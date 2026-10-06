import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { assessDiff, hasRequiredProtection, latestReviews, mergeMinorPRs } from "../.github/scripts/minor-pr.mjs";
import { notifyDeployment } from "../.github/scripts/deployment-feedback.mjs";
import { shouldRunChecks } from "../.github/scripts/ci-changes.mjs";

const repo = { owner: "jupe", repo: "OpenJury" };
const fullName = "jupe/OpenJury";
const sha = "a".repeat(40);
const context = { repo, serverUrl: "https://github.com", runId: 123 };
const core = { info() {}, warning() {} };

for (const [cacheHit, dependencies, rebuild, pulls, builds, sourceRepository = ""] of [
  ["true", "true", "false", 2, 0],
  ["false", "true", "false", 2, 2],
  ["true", "false", "false", 1, 0],
  ["true", "true", "true", 0, 2],
  ["true", "false", "false", 1, 0, fullName],
  ["false", "false", "false", 1, 1, fullName],
]) {
  test(`CI image preparation: hit=${cacheHit}, dependencies=${dependencies}, rebuild=${rebuild}, source=${sourceRepository || "caller"}`, () => {
    const directory = mkdtempSync(resolve(".test-ci-images-"));
    const output = join(directory, "output");
    const log = join(directory, "docker.log");
    const action = readFileSync(resolve(".github/actions/ci-images/action.yml"), "utf8");
    const script = action.split("run: |")[1];
    try {
      execFileSync("bash", ["-e", "-c", `
        docker() {
          printf '%s\\n' "$*" >> "$DOCKER_LOG"
          case "$1" in
            pull) test "$CACHE_HIT" = true ;;
            image) printf 'sha256:%064d\\n' 1 ;;
            build|tag) return 0 ;;
            *) return 1 ;;
          esac
        }
        export -f docker
        ${script}
      `], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: sourceRepository ? "jupe/OpenJury-deploy-private" : fullName,
          CI_IMAGE_REPOSITORY: sourceRepository,
          GITHUB_OUTPUT: output,
          DOCKER_LOG: log,
          CACHE_HIT: cacheHit,
          INCLUDE_DEPENDENCIES: dependencies,
          REBUILD: rebuild,
          PREPARE_WORKSPACE: "false",
        },
      });
      const commands = readFileSync(log, "utf8");
      expect(commands.match(/^pull /gm) || []).toHaveLength(pulls);
      expect(commands.match(/^build /gm) || []).toHaveLength(builds);
      expect(commands).not.toMatch(/^push /m);
      if (sourceRepository) {
        expect(commands).toMatch(/^pull ghcr\.io\/jupe\/openjury-ci:tools-[a-f0-9]{64}$/m);
        expect(commands).not.toContain("ghcr.io/jupe/openjury-deploy-private-ci");
      }
      const outputs = readFileSync(output, "utf8");
      expect(outputs).toMatch(/^tools=sha256:[a-f0-9]{64}$/m);
      expect(outputs).toMatch(/^tools-tag=ghcr.io\/jupe\/openjury-ci:tools-[a-f0-9]{64}$/m);
      expect(outputs.includes("dependencies=openjury-ci-dependencies:")).toBe(dependencies === "true");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("CI and deployment smoke tests reuse tools without installing packages on cache hits", () => {
  for (const file of [".github/workflows/ci.yml", "deploy/workflows/deploy-environment.yml"]) {
    const workflow = readFileSync(resolve(file), "utf8");
    expect(workflow).toContain("uses: ./.github/actions/ci-images");
    expect(workflow).toContain("--env PLAYWRIGHT_BASE_URL");
    expect(workflow).not.toMatch(/setup-node|npm install|npm ci|playwright install|pipx run/);
  }
  const publisher = readFileSync(resolve(".github/workflows/ci-images.yml"), "utf8");
  expect(publisher).toContain("if: github.ref == 'refs/heads/main'");
  expect(publisher).not.toMatch(/pull_request/);
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  expect(dockerfile).toContain("ARG DEPENDENCIES_IMAGE=dependencies");
  expect(dockerfile).toContain("FROM ${DEPENDENCIES_IMAGE} AS builder");
  expect(dockerfile).toContain("FROM node AS runner");
  const deployment = readFileSync(resolve("deploy/workflows/deploy-environment.yml"), "utf8");
  expect(workflowStep(deployment, "Prepare prebuilt CI tools"))
    .toContain("repository: ${{ vars.SOURCE_REPOSITORY }}");
});

function workflowStep(workflow, name) {
  return workflow.split(`- name: ${name}\n`)[1].split(/\n(?:      - |  [a-z])/)[0];
}

test("main release handoff requires tested artifacts and never bypasses checks", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const publish = ci.split("\n  publish:")[1];
  expect(publish).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(publish).not.toContain("continue-on-error");
  expect(publish).toContain("needs: [build, checks]");
  expect(ci.indexOf("- name: Test production image")).toBeLessThan(ci.indexOf("- name: Save tested image"));
  expect(ci).not.toContain("actions/attest");
  expect(ci).not.toContain("attestations:");
  for (const name of ["Save tested image", "Upload tested image"]) {
    const step = workflowStep(ci, name);
    expect(step).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(step).not.toContain("continue-on-error");
  }
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  expect(release).toContain("actions/download-artifact@");
  expect(release).not.toMatch(/docker (build|load)/);
  expect(release).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(release).toContain("github.event.workflow_run.event == 'push'");
  expect(release).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  expect(release).toContain("run-id: ${{ github.event.workflow_run.id }}");
  expect(release).not.toContain("gh attestation");
  expect(release).not.toContain("attestations:");
  expect(publish).toContain("GITHUB_RUN_ATTEMPT");
  expect(release).toContain("workflow_run.run_attempt");
  expect(release).toContain("if: steps.source.outputs.current == 'true'");
  expect(release).toContain("branch.commit.sha === run.head_sha");
  expect(release).not.toMatch(/\n  (staging|production|notify):/);
  const deploy = readFileSync(resolve("deploy/workflows/deploy-environment.yml"), "utf8");
  expect(workflowStep(deploy, "Upload smoke report")).toContain("continue-on-error: true");
  expect(workflowStep(deploy, "Smoke test through the public ingress")).not.toContain("continue-on-error");
});

for (const eventName of ["pull_request", "merge_group"]) {
  test(`${eventName} skips only documentation-only or empty diffs`, () => {
    const event = { eventName, baseSha: "b".repeat(40), headSha: sha };
    for (const files of [[], ["README.md"], ["docs/ci-cd.md", "docs/nested/guide.md", "LICENSE"]]) {
      expect(shouldRunChecks(event, () => files.join("\0") + "\0")).toBe(false);
    }
    for (const file of [
      "app/page.tsx", "components/Button.tsx", "lib/supabase.ts", "public/logo.svg",
      "package.json", "package-lock.json", ".nvmrc", "Dockerfile", ".dockerignore",
      "next.config.ts", "tsconfig.json", "eslint.config.mjs", "postcss.config.mjs",
      "tests/automation.spec.js", "playwright.config.ts", "supabase/migrations/01_initial_schema.sql",
      "deploy/compose.yml", ".github/workflows/ci.yml", ".github/scripts/ci-changes.mjs",
      "app/content.md", "docs/example.js", "unknown-file", "a\nb.js",
    ]) {
      expect(shouldRunChecks(event, () => `README.md\0${file}\0`)).toBe(true);
    }
  });
}

test("CI compares full revisions with NUL-separated paths and both sides of renames", () => {
  const event = { eventName: "pull_request", baseSha: "b".repeat(40), headSha: sha };
  const git = (command, args, options) => {
    expect(command).toBe("git");
    expect(args).toEqual(["diff", "--name-only", "--no-renames", "-z", event.baseSha, sha, "--"]);
    expect(options).toEqual({ encoding: "utf8" });
    return "app/page.tsx\0docs/page.md\0";
  };
  expect(shouldRunChecks(event, git)).toBe(true);
  expect(shouldRunChecks(event, () => Array(500).fill("docs/guide.md\0").join("") + "app/page.tsx\0")).toBe(true);
});

test("main pushes always build and diff failures cannot become successful skips", () => {
  const fail = () => { throw new Error("Comparison unavailable"); };
  expect(shouldRunChecks({ eventName: "push" }, fail)).toBe(true);
  expect(() => shouldRunChecks({ eventName: "pull_request" }, fail)).toThrow("comparison revision");
  expect(() => shouldRunChecks({
    eventName: "merge_group", baseSha: "b".repeat(40), headSha: sha,
  }, fail)).toThrow("Comparison unavailable");
});

test("required CI status accepts only a successful build or a confirmed documentation skip", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const checks = workflow.slice(workflow.indexOf("\n  checks:")).split("\n  publish:")[0];
  expect(checks).toContain("needs: [changes, build]");
  expect(checks).toContain("if: always()");
  expect(workflow).toContain("if: needs.changes.outputs.build == 'true'");
  expect(workflow).not.toMatch(/paths(-ignore)?:/);
  const script = checks.split("run: |")[1];
  for (const [changes, required, build, passes] of [
    ["success", "true", "success", true],
    ["success", "false", "skipped", true],
    ["failure", "", "skipped", false],
    ["cancelled", "", "skipped", false],
    ["success", "true", "failure", false],
    ["success", "true", "cancelled", false],
    ["success", "true", "skipped", false],
    ["success", "", "skipped", false],
    ["success", "false", "failure", false],
  ]) {
    const run = () => execFileSync("bash", ["-e", "-c", script], {
      env: { ...process.env, CHANGES_RESULT: changes, BUILD_REQUIRED: required, BUILD_RESULT: build },
    });
    if (passes) expect(run).not.toThrow();
    else expect(run).toThrow();
  }
});

test("PR and fork CI never publish packages or invoke deployment templates", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const build = ci.split("\n  build:")[1].split("\n  checks:")[0];
  const publish = ci.split("\n  publish:")[1];
  expect(build).toContain("contents: read");
  expect(build).not.toContain("packages: write");
  expect(build).not.toContain("GH_TOKEN:");
  expect(build).toContain("run: bash supabase/test.sh");
  expect(build).not.toContain("head.repo.full_name == github.repository");
  expect(publish).toContain("needs: [build, checks]");
  expect(publish).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(publish).toContain("packages: write");
  expect(publish).not.toContain("actions/checkout");
  expect(ci).not.toMatch(/self-hosted|preview-artifact|preview-image|\n  preview:|uses:.*workflows\/(?:deploy|preview)/);
  expect(ci).toContain("cancel-in-progress: true");
});

function mergeFixture() {
  const state = {
    pr: {
      number: 7, state: "open", draft: false, merged: false,
      labels: [{ name: "automerge:minor" }], user: { login: "contributor" },
      head: { sha, repo: { full_name: fullName } },
      base: { ref: "main", sha: "b".repeat(40), repo: { full_name: fullName } },
      mergeable: true, mergeable_state: "clean", changed_files: 1, additions: 1, deletions: 1,
    },
    files: [{
      filename: "components/Button.tsx", status: "modified", additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-className="p-2"\n+className="p-3"',
    }],
    protection: {
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, contexts: ["checks"] },
      required_pull_request_reviews: {
        required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true,
      },
    },
    reviews: [{
      id: 1, state: "APPROVED", commit_id: sha, user: { login: "maintainer", type: "User" },
    }],
    permission: "write",
    runs: [{
      id: 1, head_sha: sha, head_repository: { full_name: fullName },
      pull_requests: [{ number: 7 }], status: "completed", conclusion: "success",
    }],
    merges: [],
    current: null,
    error: false,
  };
  let reads = 0;
  const github = {
    paginate: async (method, args) => method(args),
    rest: {
      pulls: {
        list: async () => [state.pr],
        get: async () => ({ data: ++reads > 1 && state.current ? state.current : state.pr }),
        listFiles: async () => state.files,
        listReviews: async () => state.reviews,
        merge: async (args) => {
          state.merges.push(args);
          return { data: { merged: true } };
        },
      },
      repos: {
        getBranchProtection: async () => {
          if (state.error) throw Object.assign(new Error("Unavailable"), { status: 403 });
          return { data: state.protection };
        },
        getCollaboratorPermissionLevel: async () => ({ data: { permission: state.permission } }),
      },
      actions: { listWorkflowRuns: async () => state.runs },
    },
  };
  return { state, run: () => mergeMinorPRs({ github, context, core }) };
}

test("merges only the reviewed SHA using squash", async () => {
  const { state, run } = mergeFixture();
  await run();
  expect(state.merges).toEqual([{ ...repo, pull_number: 7, sha, merge_method: "squash" }]);
});

for (const filename of [
  "app/api/auth/route.ts", "app/competition/[id]/page.tsx", "lib/supabase.ts",
  "supabase/migrations/02_feedback.sql", "package.json", "package-lock.json",
  ".github/workflows/ci.yml", ".github/scripts/minor-pr.mjs", "deploy/stack.sh",
  "Dockerfile", "middleware.ts", "components/Voting.tsx", "tests/application.spec.ts",
]) {
  test(`requires manual merge for sensitive or unclassified path ${filename}`, async () => {
    const { state, run } = mergeFixture();
    state.files[0].filename = filename;
    await run();
    expect(state.merges).toEqual([]);
  });
}

test("rejects large, inconsistent, incomplete, and non-text diffs", () => {
  const { state } = mergeFixture();
  const { pr, files } = state;
  expect(assessDiff(pr, files)).toBeNull();
  expect(assessDiff({ ...pr, changed_files: 2 }, files)).not.toBeNull();
  expect(assessDiff({ ...pr, additions: 2 }, files)).not.toBeNull();
  expect(assessDiff(pr, [{ ...files[0], patch: "" }])).not.toBeNull();
  expect(assessDiff(pr, [{ ...files[0], patch: "@@ -1 +1 @@\n+only addition" }])).not.toBeNull();
  for (const status of ["added", "removed", "renamed", "copied"]) {
    expect(assessDiff(pr, [{ ...files[0], status }])).not.toBeNull();
  }
  expect(assessDiff(pr, [{ ...files[0], previous_filename: "lib/auth.ts" }])).not.toBeNull();
  const large = { ...files[0], additions: 100, deletions: 1, patch: "-old\n" + "+new\n".repeat(100) };
  expect(assessDiff({ ...pr, additions: 100 }, [large])).not.toBeNull();
  const boundary = { ...large, additions: 99, patch: "-old\n" + "+new\n".repeat(99) };
  expect(assessDiff({ ...pr, additions: 99 }, [boundary])).toBeNull();
  expect(assessDiff({ ...pr, changed_files: 6 }, Array(6).fill(files[0]))).not.toBeNull();
});

for (const code of ["fetch(url)", "supabase.auth", "vote(entry)", "process.env.KEY", "dangerouslySetInnerHTML", "permission", "token"]) {
  test(`sensitive code in an allowed component still needs manual review: ${code}`, async () => {
    const { state, run } = mergeFixture();
    state.files[0].patch = `-old\n+${code}`;
    await run();
    expect(state.merges).toEqual([]);
  });
}

const blockers = {
  "no opt-in label": (s) => { s.pr.labels = [{ name: "bug" }]; },
  "draft PR": (s) => { s.pr.draft = true; },
  "closed PR": (s) => { s.pr.state = "closed"; },
  "different base": (s) => { s.pr.base.ref = "release"; },
  "fork PR": (s) => { s.pr.head.repo.full_name = "outside/OpenJury"; },
  "deleted fork": (s) => { s.pr.head.repo = null; },
  "merge conflict": (s) => { s.pr.mergeable = false; },
  "unknown merge state": (s) => { s.pr.mergeable = null; },
  "pending check or review": (s) => { s.pr.mergeable_state = "blocked"; },
  "outdated base": (s) => { s.pr.mergeable_state = "behind"; },
  "missing protections": (s) => { s.protection = {}; },
  "API error": (s) => { s.error = true; },
  "no approval": (s) => { s.reviews = []; },
  "stale approval": (s) => { s.reviews[0].commit_id = "old"; },
  "self approval": (s) => { s.reviews[0].user.login = "contributor"; },
  "bot approval": (s) => { s.reviews[0].user.type = "Bot"; },
  "untrusted approval": (s) => { s.permission = "read"; },
  "dismissed approval": (s) => { s.reviews.push({ ...s.reviews[0], id: 2, state: "DISMISSED" }); },
  "requested changes": (s) => {
    s.reviews.push({ ...s.reviews[0], id: 2, state: "CHANGES_REQUESTED", user: { login: "other" } });
  },
  "missing CI": (s) => { s.runs = []; },
  "failed CI": (s) => { s.runs[0].conclusion = "failure"; },
  "pending CI rerun": (s) => { s.runs.push({ ...s.runs[0], id: 2, status: "in_progress", conclusion: null }); },
  "CI for another SHA": (s) => { s.runs[0].head_sha = "old"; },
  "CI for another PR": (s) => { s.runs[0].pull_requests = [{ number: 9 }]; },
  "CI from a fork": (s) => { s.runs[0].head_repository.full_name = "other/OpenJury"; },
  "head changed during assessment": (s) => {
    s.current = structuredClone(s.pr); s.current.head.sha = "new";
  },
  "base changed during assessment": (s) => {
    s.current = structuredClone(s.pr); s.current.base.sha = "new";
  },
  "label removed during assessment": (s) => {
    s.current = structuredClone(s.pr); s.current.labels = [];
  },
};
for (const [name, change] of Object.entries(blockers)) {
  test(`fails closed: ${name}`, async () => {
    const { state, run } = mergeFixture();
    change(state);
    await run();
    expect(state.merges).toEqual([]);
  });
}

test("requires strict checks, fresh independent reviews, admin enforcement, and no bypass", () => {
  const { state } = mergeFixture();
  expect(hasRequiredProtection(state.protection)).toBe(true);
  for (const change of [
    (p) => { p.enforce_admins.enabled = false; },
    (p) => { p.required_status_checks.strict = false; },
    (p) => { p.required_status_checks.contexts = ["other"]; },
    (p) => { p.required_pull_request_reviews.dismiss_stale_reviews = false; },
    (p) => { p.required_pull_request_reviews.require_last_push_approval = false; },
    (p) => { p.required_pull_request_reviews.required_approving_review_count = 0; },
    (p) => { p.required_pull_request_reviews.bypass_pull_request_allowances = { apps: [{}] }; },
  ]) {
    const protection = structuredClone(state.protection);
    change(protection);
    expect(hasRequiredProtection(protection)).toBe(false);
  }
});

test("comments do not erase reviews; newer approvals supersede change requests", () => {
  const { state } = mergeFixture();
  const approved = state.reviews[0];
  expect(latestReviews([
    { ...approved, id: 3, state: "COMMENTED" }, { ...approved, id: 0, state: "CHANGES_REQUESTED" }, approved,
  ])).toEqual([approved]);
});

function notificationFixture() {
  const issue = { number: 12, author: { login: "reporter" }, repository: { nameWithOwner: fullName } };
  const state = {
    pulls: [{ number: 7, merged_at: "2026-10-01", merge_commit_sha: "b".repeat(40) }],
    issuePages: [[issue]], cursors: [], comments: [], sent: [], comparisons: [],
    status: "ahead", productionResult: "success", revision: sha, error: null,
  };
  const github = {
    paginate: async (method, args) => method(args),
    graphql: async (_query, args) => {
      state.cursors.push(args.after);
      const page = args.after ? Number(args.after) : 0;
      return { repository: { pullRequest: { closingIssuesReferences: {
        nodes: state.issuePages[page],
        pageInfo: { hasNextPage: page + 1 < state.issuePages.length, endCursor: String(page + 1) },
      } } } };
    },
    rest: {
      pulls: { list: async () => state.pulls },
      repos: { compareCommitsWithBasehead: async (args) => {
        state.comparisons.push(args.basehead);
        if (state.error) throw Object.assign(new Error("Unavailable"), { status: state.error });
        return { data: { status: state.status } };
      } },
      issues: {
        listComments: async ({ issue_number }) => state.comments.filter((c) => c.issue_number === issue_number),
        createComment: async (args) => {
          state.sent.push(args);
          state.comments.push({ ...args, user: { login: "github-actions[bot]", type: "Bot" } });
        },
      },
    },
  };
  return { state, run: () => notifyDeployment({
    github, context, core, revision: state.revision, productionResult: state.productionResult,
  }) };
}

test("notifies the issue reporter once after deployment, including earlier superseded CI commits", async () => {
  const { state, run } = notificationFixture();
  await run();
  expect(state.sent).toHaveLength(1);
  expect(state.sent[0].body).toContain("@reporter");
  expect(state.sent[0].body).toContain("PR #7 is included in production");
  expect(state.sent[0].body).toContain("/actions/runs/123");
  expect(state.comparisons).toEqual([`${"b".repeat(40)}...${sha}`]);
  await run();
  expect(state.sent).toHaveLength(1);
});

for (const result of ["failure", "cancelled", "skipped", ""]) {
  test(`does not notify when production including smoke tests is ${result || "unknown"}`, async () => {
    const { state, run } = notificationFixture();
    state.productionResult = result;
    await run();
    expect(state.sent).toEqual([]);
    expect(state.cursors).toEqual([]);
  });
}

test("ignores unmerged, future, divergent, and missing-history PRs", async () => {
  for (const status of ["behind", "diverged", "unknown"]) {
    const { state, run } = notificationFixture();
    state.status = status;
    await run();
    expect(state.sent).toEqual([]);
  }
  const { state, run } = notificationFixture();
  state.error = 404;
  await run();
  expect(state.sent).toEqual([]);
  state.pulls[0].merged_at = null;
  await run();
  expect(state.sent).toEqual([]);
});

test("linked issue pagination is complete and restricted to this repository", async () => {
  const { state, run } = notificationFixture();
  state.issuePages.push([
    { number: 13, author: null, repository: { nameWithOwner: fullName } },
    { number: 14, author: { login: "outside" }, repository: { nameWithOwner: "other/repo" } },
  ]);
  await run();
  expect(state.cursors).toEqual([null, "1"]);
  expect(state.sent.map((comment) => comment.issue_number)).toEqual([12, 13]);
  expect(state.sent[1].body).not.toContain("@null");
});

test("a user-supplied notification marker does not suppress the bot notification", async () => {
  const { state, run } = notificationFixture();
  state.comments.push({
    issue_number: 12, body: "<!-- openjury:production:pr:7 -->", user: { login: "someone", type: "User" },
  });
  await run();
  expect(state.sent).toHaveLength(1);
});

test("notification errors remain retryable and invalid revisions are rejected", async () => {
  const { state, run } = notificationFixture();
  state.error = 403;
  await expect(run()).rejects.toThrow("Unavailable");
  expect(state.sent).toEqual([]);
  state.error = null;
  await run();
  expect(state.sent).toHaveLength(1);
  state.revision = "not-a-sha";
  await expect(run()).rejects.toThrow("Invalid deployed revision");
});

test("merge automation stays opt-in and public Release contains no deployment stages", () => {
  const merge = readFileSync(resolve(".github/workflows/minor-pr.yml"), "utf8");
  expect(merge).toContain("vars.MINOR_PR_AUTOMERGE_ENABLED == 'true'");
  expect(merge).toContain("github.ref == 'refs/heads/main'");
  expect(merge).toContain("environment: minor-pr-automation");
  expect(merge).toContain("ref: refs/heads/main");
  expect(merge).not.toMatch(/pull_request_target:|pull_request_review:|npm (ci|install)/);
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  expect(release).not.toMatch(/\n  (staging|production|notify):/);
  expect(release).not.toMatch(/self-hosted|uses:.*workflows\/deploy/);
  const deploy = readFileSync(resolve("deploy/workflows/deploy.yml"), "utf8");
  expect(deploy).toContain("github.event.repository.private == true");
  expect(deploy).toContain("needs: staging");
  expect(deploy).not.toContain("schedule:");
});
