import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessDiff, hasRequiredProtection, latestReviews, mergeMinorPRs } from "../.github/scripts/minor-pr.mjs";
import { notifyDeployment } from "../.github/scripts/deployment-feedback.mjs";

const repo = { owner: "jupe", repo: "OpenJury" };
const fullName = "jupe/OpenJury";
const sha = "a".repeat(40);
const context = { repo, serverUrl: "https://github.com", runId: 123 };
const core = { info() {}, warning() {} };

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

test("automation workflows stay opt-in, trusted, and behind production success", () => {
  const merge = readFileSync(resolve(".github/workflows/minor-pr.yml"), "utf8");
  expect(merge).toContain("vars.MINOR_PR_AUTOMERGE_ENABLED == 'true'");
  expect(merge).toContain("github.ref == 'refs/heads/main'");
  expect(merge).toContain("environment: minor-pr-automation");
  expect(merge).toContain("ref: refs/heads/main");
  expect(merge).not.toMatch(/pull_request_target:|pull_request_review:|npm (ci|install)/);
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  expect(release).toContain("needs: [publish, production]");
  expect(release).toContain("needs.production.result == 'success'");
  expect(release).toContain("vars.DEPLOYMENT_NOTIFICATIONS_ENABLED == 'true'");
  expect(release).toContain("needs.staging.result == 'success' && vars.CD_ENABLED == 'true'");
});
