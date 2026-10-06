import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { assessDiff, hasRequiredProtection, latestReviews, mergeMinorPRs } from "../.github/scripts/minor-pr.mjs";
import { notifyDeployment } from "../.github/scripts/deployment-feedback.mjs";
import { shouldRunChecks } from "../.github/scripts/ci-changes.mjs";
import { releaseImage } from "../.github/scripts/release-image.mjs";

const repo = { owner: "jupe", repo: "OpenJury" };
const fullName = "jupe/OpenJury";
const sha = "a".repeat(40);
const context = { repo, serverUrl: "https://github.com", runId: 123 };
const core = { info() {}, warning() {} };

for (const [cacheHit, dependencies, rebuild, pulls, builds] of [
  ["true", "true", "false", 2, 0],
  ["false", "true", "false", 2, 2],
  ["true", "false", "false", 1, 0],
  ["true", "true", "true", 0, 2],
]) {
  test(`CI image preparation: hit=${cacheHit}, dependencies=${dependencies}, rebuild=${rebuild}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "openjury-ci-images-"));
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
          GITHUB_REPOSITORY: fullName,
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
  for (const file of ["ci.yml", "deploy.yml"]) {
    const workflow = readFileSync(resolve(".github/workflows", file), "utf8");
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
});

function workflowStep(workflow, name) {
  return workflow.split(`- name: ${name}\n`)[1].split(/\n(?:      - |  [a-z])/)[0];
}

const imageDigest = `sha256:${"b".repeat(64)}`;

function releaseJob(name, runAttempt = 1, overrides = {}) {
  return {
    id: 1000 + runAttempt * 10 + (name === "Build and test" ? 1 : name === "checks" ? 2 : 3),
    run_id: 123, head_sha: sha, run_attempt: runAttempt, name,
    status: "completed", conclusion: "success",
    started_at: `2026-10-06T07:${String(runAttempt).padStart(2, "0")}:10Z`,
    completed_at: `2026-10-06T07:${String(runAttempt).padStart(2, "0")}:20Z`,
    ...overrides,
  };
}

function imageMarker(runAttempt = 1, overrides = {}) {
  return releaseJob(`release-image-v1 ${imageDigest}`, runAttempt, {
    started_at: `2026-10-06T07:${String(runAttempt).padStart(2, "0")}:30Z`, ...overrides,
  });
}

function releaseFixture({ attempt = 1, jobs, runOverrides = {}, triggerOverrides = {} } = {}) {
  const trigger = {
    id: 123, run_attempt: attempt, head_sha: sha, path: ".github/workflows/ci.yml",
    head_branch: "main", event: "push", status: "completed", conclusion: "success",
    repository: { full_name: fullName }, head_repository: { full_name: fullName },
    ...triggerOverrides,
  };
  const run = { ...trigger, ...runOverrides };
  const entries = jobs || [releaseJob("Build and test"), releaseJob("checks"), imageMarker()];
  let runCalls = 0;
  let pages = 0;
  const listJobsForWorkflowRun = () => { throw new Error("Use authenticated pagination"); };
  const github = {
    rest: { actions: {
      async getWorkflowRunAttempt(params) {
        runCalls++;
        expect(params).toEqual({ ...repo, run_id: trigger.id, attempt_number: trigger.run_attempt });
        return { data: run };
      },
      listJobsForWorkflowRun,
    } },
    async paginate(endpoint, params) {
      expect(endpoint).toBe(listJobsForWorkflowRun);
      expect(params).toEqual({ ...repo, run_id: 123, filter: "all", per_page: 100 });
      // Model the flattened result returned by github-script's pagination plugin.
      const result = [];
      for (let offset = 0; offset < entries.length; offset += params.per_page) {
        pages++;
        result.push(...entries.slice(offset, offset + params.per_page));
      }
      return result;
    },
  };
  return {
    github, context: { ...context, payload: { workflow_run: trigger } },
    calls: () => ({ runCalls, pages }),
  };
}

test("release resolves an immutable image from the authenticated originating run", async () => {
  const fixture = releaseFixture();
  await expect(releaseImage(fixture)).resolves.toBe(`ghcr.io/jupe/openjury@${imageDigest}`);
  expect(fixture.calls()).toEqual({ runCalls: 1, pages: 1 });
});

for (const [name, overrides] of [
  ["wrong workflow", { path: ".github/workflows/preview.yml" }],
  ["wrong branch", { head_branch: "feature" }],
  ["PR event", { event: "pull_request" }],
  ["foreign head repository", { head_repository: { full_name: "other/OpenJury" } }],
  ["foreign repository", { repository: { full_name: "other/OpenJury" } }],
  ["missing head repository", { head_repository: null }],
  ["missing repository", { repository: null }],
  ["failed run", { conclusion: "failure" }],
  ["unfinished run", { status: "in_progress" }],
  ["invalid run id", { id: "123" }],
  ["zero run id", { id: 0 }],
  ["unsafe run id", { id: Number.MAX_SAFE_INTEGER + 1 }],
  ["invalid SHA", { head_sha: "main" }],
  ["SHA newline", { head_sha: `${sha}\n` }],
  ["invalid attempt", { run_attempt: "1" }],
  ["zero attempt", { run_attempt: 0 }],
]) {
  for (const source of ["triggerOverrides", "runOverrides"]) {
    test(`release rejects ${source}: ${name}`, async () => {
      const fixture = releaseFixture({ [source]: overrides });
      await expect(releaseImage(fixture)).rejects.toThrow("Invalid originating CI run");
      expect(fixture.calls().pages).toBe(0);
      if (source === "triggerOverrides") expect(fixture.calls().runCalls).toBe(0);
    });
  }
}

for (const runOverrides of [{ id: 456 }, { head_sha: "c".repeat(40) }, { run_attempt: 2 }]) {
  test(`release rejects API run/event mismatch ${JSON.stringify(runOverrides)}`, async () => {
    await expect(releaseImage(releaseFixture({ runOverrides }))).rejects.toThrow("does not match");
  });
}

test("release propagates run and jobs API failures instead of skipping verification", async () => {
  for (const endpoint of ["getWorkflowRunAttempt", "paginate"]) {
    const fixture = releaseFixture();
    const fail = async () => { throw new Error("API unavailable"); };
    if (endpoint === "paginate") fixture.github.paginate = fail;
    else fixture.github.rest.actions[endpoint] = fail;
    await expect(releaseImage(fixture)).rejects.toThrow("API unavailable");
  }
});

for (const [name, overrides] of [
  ["wrong run", { run_id: 456 }],
  ["wrong SHA", { head_sha: "c".repeat(40) }],
  ["invalid attempt", { run_attempt: 0 }],
  ["missing attempt", { run_attempt: undefined }],
  ["invalid job id", { id: "123" }],
  ["missing name", { name: undefined }],
]) {
  test(`release rejects job metadata: ${name}`, async () => {
    const fixture = releaseFixture({ jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(1, overrides),
    ] });
    await expect(releaseImage(fixture)).rejects.toThrow("Invalid originating CI job metadata");
  });
}

for (const name of [
  "release-image-v1", "release-image-v1 sha256:bad", "release-image-v2 sha256:" + "b".repeat(64),
  `release-image-v1 ${imageDigest}\n`, `release-image-v1 ${imageDigest} extra`,
  `release-image-v1 sha256:${"B".repeat(64)}`,
]) {
  test(`release rejects malformed marker ${JSON.stringify(name)}`, async () => {
    await expect(releaseImage(releaseFixture({ jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(1, { name }),
    ] }))).rejects.toThrow("Malformed image marker");
  });
}

for (const missing of ["Build and test", "checks", `release-image-v1 ${imageDigest}`]) {
  test(`release fails closed without ${missing}`, async () => {
    await expect(releaseImage(releaseFixture({ jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(),
    ].filter((job) => job.name !== missing) }))).rejects.toThrow("Missing, duplicate, or unsuccessful");
  });
}

for (const overrides of [
  { conclusion: "failure" }, { conclusion: "skipped" },
  { conclusion: "cancelled" }, { status: "in_progress", conclusion: null },
]) {
  test(`release rejects latest unsuccessful marker ${JSON.stringify(overrides)}`, async () => {
    await expect(releaseImage(releaseFixture({ attempt: 2, jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(), imageMarker(2, overrides),
    ] }))).rejects.toThrow("unsuccessful image marker");
  });
}

test("release rejects duplicate markers even when their digest matches", async () => {
  for (const name of [`release-image-v1 ${imageDigest}`, `release-image-v1 sha256:${"c".repeat(64)}`]) {
    await expect(releaseImage(releaseFixture({ jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(),
      imageMarker(1, { id: 9999, name }),
    ] }))).rejects.toThrow("duplicate");
  }
});

test("release rejects duplicated API job IDs", async () => {
  await expect(releaseImage(releaseFixture({ jobs: [
    releaseJob("Build and test"), releaseJob("checks"), imageMarker(), imageMarker(),
  ] }))).rejects.toThrow("Invalid originating CI job metadata");
});

test("release paginates all jobs including a marker beyond page one", async () => {
  const filler = Array.from({ length: 105 }, (_, index) => releaseJob(`other ${index}`, 1, { id: index + 1 }));
  const jobs = [releaseJob("Build and test"), releaseJob("checks"), ...filler, imageMarker()];
  const fixture = releaseFixture({ jobs });
  await expect(releaseImage(fixture)).resolves.toBe(`ghcr.io/jupe/openjury@${imageDigest}`);
  expect(fixture.calls().pages).toBe(2);
  await expect(releaseImage(releaseFixture({ jobs: [
    imageMarker(1, { id: 9999 }), ...jobs,
  ] }))).rejects.toThrow("duplicate");
});

test("unrelated partial retry reuses the prior successful build and marker", async () => {
  await expect(releaseImage(releaseFixture({ attempt: 3, jobs: [
    releaseJob("Build and test"), releaseJob("checks"), imageMarker(),
    releaseJob("Unrelated job", 2), releaseJob("checks", 3),
  ] }))).resolves.toBe(`ghcr.io/jupe/openjury@${imageDigest}`);
});

test("release selects the latest eligible marker regardless of API order", async () => {
  const digest = `sha256:${"c".repeat(64)}`;
  await expect(releaseImage(releaseFixture({ attempt: 2, jobs: [
    imageMarker(2, { name: `release-image-v1 ${digest}` }),
    releaseJob("Build and test", 2), releaseJob("checks", 2),
    imageMarker(1, { conclusion: "failure" }),
    releaseJob("checks"), releaseJob("Build and test"),
  ] }))).resolves.toBe(`ghcr.io/jupe/openjury@${digest}`);
});

test("a stale completion ignores newer attempts including newer builds and markers", async () => {
  const fixture = releaseFixture({ jobs: [
    releaseJob("Build and test", 2), imageMarker(2, { name: "release-image-v1 malformed" }),
    releaseJob("checks", 2, { conclusion: "failure" }),
    releaseJob("Build and test"), imageMarker(), releaseJob("checks"),
  ] });
  await expect(releaseImage(fixture)).resolves.toBe(`ghcr.io/jupe/openjury@${imageDigest}`);
});

test("a future marker cannot supply a missing handoff to a stale event", async () => {
  await expect(releaseImage(releaseFixture({ jobs: [
    releaseJob("Build and test"), releaseJob("checks"), imageMarker(2),
  ] }))).rejects.toThrow("image marker");
});

test("a malformed newest marker cannot fall back to an older successful marker", async () => {
  await expect(releaseImage(releaseFixture({ attempt: 2, jobs: [
    releaseJob("Build and test"), releaseJob("checks"), imageMarker(),
    imageMarker(2, { name: "release-image-v1 malformed" }),
  ] }))).rejects.toThrow("Malformed image marker");
});

test("a rebuilt image requires a new marker", async () => {
  await expect(releaseImage(releaseFixture({ attempt: 2, jobs: [
    releaseJob("Build and test"), releaseJob("checks"), imageMarker(),
    releaseJob("Build and test", 2), releaseJob("checks", 2),
  ] }))).rejects.toThrow("predates the latest build");
});

for (const overrides of [
  { started_at: "2026-10-06T07:01:00Z" }, { started_at: null }, { started_at: "invalid" },
]) {
  test(`release rejects a marker without post-build timing ${JSON.stringify(overrides)}`, async () => {
    await expect(releaseImage(releaseFixture({ jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(1, overrides),
    ] }))).rejects.toThrow("predates the latest build");
  });
}

for (const name of ["Build and test", "checks"]) {
  test(`release rejects the latest failed ${name} instead of a prior success`, async () => {
    await expect(releaseImage(releaseFixture({ attempt: 2, jobs: [
      releaseJob("Build and test"), releaseJob("checks"), imageMarker(),
      releaseJob(name, 2, { conclusion: "failure" }), imageMarker(2),
    ] }))).rejects.toThrow("unsuccessful");
  });
}

test("CI marker validates its digest before succeeding", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const script = workflowStep(ci, "Record the checked main image in job metadata").split("run: |")[1];
  for (const digest of [imageDigest, "", "sha256:bad", `${imageDigest}\n`, `sha256:${"B".repeat(64)}`]) {
    const run = () => execFileSync("bash", ["-e", "-c", script], { env: { ...process.env, DIGEST: digest } });
    if (digest === imageDigest) expect(run).not.toThrow();
    else expect(run).toThrow();
  }
});

test("main release handoff does not depend on artifact storage or bypass checks", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const publish = workflowStep(ci, "Publish tested main image");
  expect(publish).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(publish).not.toContain("continue-on-error");
  expect(ci.indexOf("- name: Test production image")).toBeLessThan(ci.indexOf("- name: Publish tested main image"));
  expect(ci).toContain("main-image-digest: ${{ steps.main-image.outputs.digest }}");
  const marker = ci.split("\n  release-image:\n")[1].split("\n  preview:")[0];
  expect(marker).toContain("name: release-image-v1 ${{ needs.build.outputs.main-image-digest }}");
  expect(marker).toContain("needs: [build, checks]");
  expect(marker).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(marker).toContain('[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]');
  expect(marker).not.toMatch(/continue-on-error|always\(\)/);
  for (const name of ["Save tested image", "Upload tested image"]) {
    const step = workflowStep(ci, name);
    expect(step).toContain("if: github.event_name == 'pull_request' && steps.preview-image.outcome != 'success'");
    expect(step).not.toContain("github.event_name == 'push'");
  }
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  expect(release).not.toMatch(/download-artifact|docker (build|load)/);
  expect(`${ci}\n${release}`).not.toMatch(/actions\/attest|attestations:|id-token:|gh attestation/);
  expect(release).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(release).toContain("github.event.workflow_run.event == 'push'");
  expect(release).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  expect(release).toContain("github.event.workflow_run.head_branch == 'main'");
  expect(release).toContain("actions: read");
  expect(workflowStep(release, "Check out trusted release automation")).toContain("ref: ${{ github.sha }}");
  const handoff = workflowStep(release, "Read the checked image from CI job metadata");
  expect(handoff).toContain(".github/scripts/release-image.mjs");
  expect(handoff).not.toContain("continue-on-error");
  expect(release).toContain("TESTED_IMAGE: ${{ steps.tested-image.outputs.image }}");
  expect(publish).not.toContain("GITHUB_RUN_ATTEMPT");
  expect(release).toContain("if: steps.current.outputs.current == 'true'");
  expect(release).toContain("data.commit.sha === context.payload.workflow_run.head_sha");
  expect(release).toContain("needs.staging.result == 'success' && vars.CD_ENABLED == 'true'");
  const deploy = readFileSync(resolve(".github/workflows/deploy.yml"), "utf8");
  expect(workflowStep(deploy, "Upload smoke report")).toContain("continue-on-error: true");
  expect(workflowStep(deploy, "Smoke test through the public ingress")).not.toContain("continue-on-error");
});

for (const workflow of ["ci.yml", "release.yml"]) {
  for (const failure of ["", "revision", "pull", "push", "digest", "different-digest", "missing", "mutable", "repository"]) {
    if (workflow === "ci.yml" && !["", "revision", "push", "digest"].includes(failure)) continue;
    test(`${workflow} tested image promotion fails closed: ${failure || "success"}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "openjury-release-"));
      const output = join(directory, "output");
      const log = join(directory, "docker.log");
      const digest = `ghcr.io/jupe/openjury@sha256:${"b".repeat(64)}`;
      const source = "ghcr.io/jupe/openjury:ci-123";
      const text = readFileSync(resolve(".github/workflows", workflow), "utf8");
      const step = workflowStep(text, workflow === "ci.yml"
        ? "Publish tested main image" : "Publish the tested image, without rebuilding");
      const script = step.split("run: |")[1];
      try {
        const run = () => execFileSync("bash", ["-e", "-c", `
          : > "$DOCKER_LOG"
          docker() {
            printf '%s\\n' "$*" >> "$DOCKER_LOG"
            case "$1" in
              login) cat >/dev/null ;;
              logout|tag) return 0 ;;
              pull|push) test "$FAILURE" != "$1" ;;
              image)
                if [[ "$*" == *RepoDigests* ]]; then
                  if [[ "$FAILURE" == digest ]]; then printf 'ghcr.io/other/image@sha256:invalid\\n';
                  elif [[ "$FAILURE" == different-digest ]]; then printf 'ghcr.io/jupe/openjury@sha256:%064d\\n' 1;
                  else printf '%s\\n' "$EXPECTED_DIGEST"; fi
                elif [[ "$FAILURE" == revision ]]; then printf 'wrong-revision\\n';
                else printf '%s\\n' "$REVISION"; fi ;;
              *) return 1 ;;
            esac
          }
          export -f docker
          ${script}
        `], {
          env: {
            ...process.env,
            GITHUB_REPOSITORY: fullName,
            GITHUB_SHA: sha,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "2",
            TESTED_IMAGE: failure === "missing" ? "" : failure === "mutable" ? source :
              failure === "repository" ? digest.replace("jupe/openjury", "other/image") : digest,
            REVISION: sha,
            GITHUB_ACTOR: "test",
            GH_TOKEN: "test-only",
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: join(directory, "summary"),
            DOCKER_CONFIG: join(directory, "auth"),
            DOCKER_LOG: log,
            FAILURE: failure,
            EXPECTED_DIGEST: digest,
          },
        });
        if (failure) expect(run).toThrow();
        else expect(run).not.toThrow();
        const commands = readFileSync(log, "utf8");
        expect(commands).not.toMatch(/^(build|load|save) /m);
        if (!failure) {
          if (workflow === "ci.yml") {
            expect(commands).toContain(`tag openjury:ci ${source}`);
            expect(commands).toContain(`push ${source}`);
            expect(readFileSync(output, "utf8")).toBe(`name=ghcr.io/jupe/openjury\ndigest=sha256:${"b".repeat(64)}\n`);
          } else {
            expect(commands).toContain(`pull ${digest}`);
            expect(commands).not.toContain(source);
            expect(commands).toContain(`image inspect ${digest}`);
            expect(commands).toContain(`tag ${digest} ghcr.io/jupe/openjury:sha-${sha}`);
            expect(readFileSync(output, "utf8")).toBe(`image=${digest}\n`);
          }
        } else {
          if (failure !== "push" && !(workflow === "ci.yml" && failure === "digest")) {
            expect(commands).not.toMatch(/^push /m);
          }
          expect(() => readFileSync(output, "utf8")).toThrow();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

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
  const checks = workflow.split("\n  checks:")[1].split(/\n  [a-z][a-z-]*:/)[0];
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

test("PR CI includes trusted preview orchestration after checks with fork and docs skips", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const preview = ci.split("\n  preview:")[1];
  expect(preview).toContain("needs: [build, checks]");
  expect(preview).toContain("github.event_name == 'pull_request'");
  expect(preview).toContain("vars.PREVIEW_CD_ENABLED == 'true'");
  expect(preview).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  expect(preview).toContain("needs.build.outputs.preview-artifact != ''");
  expect(preview).toContain("uses: jupe/OpenJury/.github/workflows/preview.yml@50d123dcc5a2600c27fa91a540be7501ed46e252");
  expect(preview).not.toMatch(/uses: (?:\.\/\.github\/workflows\/preview\.yml|jupe\/OpenJury\/\.github\/workflows\/preview\.yml@main)/);
  expect(preview).toContain("sha: ${{ github.event.pull_request.head.sha }}");
  expect(preview).toContain("artifact: ${{ needs.build.outputs.preview-artifact }}");
  expect(ci).toContain("vars.PREVIEW_CD_ENABLED == 'true' && github.run_id || 'latest'");
  expect(ci).toContain("cancel-in-progress: true");
  expect(ci).toContain("steps.upload_image_ref.outcome == 'success'");
  expect(ci).toContain("steps.upload_tested_image.outcome == 'success'");
  expect(ci).toContain("continue-on-error: ${{ github.event_name == 'pull_request' }}");
  expect(ci).toContain("continue-on-error: true");
  const workflow = readFileSync(resolve(".github/workflows/preview.yml"), "utf8");
  expect(workflow).toContain("workflow_call:");
  expect(workflow).not.toContain("workflow_run");
  expect(workflow).toContain("deployment: false");
  expect(workflow).toContain("ref: main");
  expect(workflow).toContain("run-id: ${{ github.run_id }}");
  expect(workflow).toContain("cancel-in-progress: false");
});

function previewScript(stepName) {
  const workflow = readFileSync(resolve(".github/workflows/preview.yml"), "utf8");
  return workflow.split(`- name: ${stepName}`)[1].split("\n      - name:")[0].split("script: |")[1];
}

test("preview validates run inputs and skips closed or superseded PR heads", async () => {
  const script = previewScript("Recheck PR after waiting for approval and the deployment lock");
  for (const [state, head, artifact, expected] of [
    ["open", sha, "image-ref-123", true],
    ["open", sha, "image-123", true],
    ["closed", sha, "image-ref-123", false],
    ["open", "new", "image-ref-123", false],
  ]) {
    const outputs = {};
    await runInNewContext(`(async () => { ${script} })()`, {
      context: { ...context, payload: { pull_request: { number: 7, head: { sha } } } },
      process: { env: { PR_NUMBER: "7", EXPECTED_SHA: sha, ARTIFACT: artifact } },
      core: { setOutput: (key, value) => { outputs[key] = value; } },
      github: { rest: { pulls: { get: async () => ({ data: { state, head: { sha: head } } }) } } },
    });
    expect(outputs.current).toBe(expected);
  }
  for (const env of [
    { PR_NUMBER: "8", EXPECTED_SHA: sha, ARTIFACT: "image-ref-123" },
    { PR_NUMBER: "7", EXPECTED_SHA: "other", ARTIFACT: "image-ref-123" },
    { PR_NUMBER: "7", EXPECTED_SHA: sha, ARTIFACT: "image-ref-999" },
  ]) {
    const error = await runInNewContext(`(async () => { ${script} })()`, {
      context: { ...context, payload: { pull_request: { number: 7, head: { sha } } } },
      process: { env },
    }).then(() => null, (failure) => failure.message);
    expect(error).toContain("Preview inputs do not match");
  }
});

test("preview registers an in-progress deployment for the exact PR head, without merging", async () => {
  const calls = [];
  const outputs = {};
  await runInNewContext(`(async () => { ${previewScript("Register deployment for the PR head commit")} })()`, {
    context: { ...context, payload: { pull_request: { number: 7 } } },
    process: { env: { EXPECTED_SHA: sha } },
    core: { setOutput: (key, value) => { outputs[key] = value; } },
    github: { rest: { repos: {
      createDeployment: async (args) => { calls.push(args); return { data: { id: 99 } }; },
      createDeploymentStatus: async (args) => { calls.push(args); },
    } } },
  });
  expect(calls[0]).toMatchObject({
    ...repo, ref: sha, environment: "dev", auto_merge: false,
    required_contexts: [], transient_environment: false, production_environment: false,
  });
  expect(outputs.id).toBe(99);
  expect(calls[1]).toMatchObject({ deployment_id: 99, state: "in_progress" });
});

test("preview reports health failures and removes closed, superseded, or cancelled deployments", async () => {
  for (const [state, head, outcome, jobStatus, status, destroys] of [
    ["open", sha, "success", "success", "success", false],
    ["open", sha, "failure", "failure", "failure", true],
    ["open", sha, "success", "cancelled", "failure", true],
    ["closed", sha, "success", "success", "inactive", true],
    ["open", "new", "success", "success", "inactive", true],
  ]) {
    const statuses = [];
    const commands = [];
    await runInNewContext(`(async () => { ${previewScript("Remove failed, closed, or superseded deployments")} })()`, {
      context,
      process: { env: {
        PR_NUMBER: "7", EXPECTED_SHA: sha, DEPLOYMENT_ID: "99", DEPLOY_OUTCOME: outcome,
        JOB_STATUS: jobStatus, DEPLOYMENT_URL: "https://pr-7.example.com",
      } },
      github: { rest: {
        pulls: { get: async () => ({ data: { state, head: { sha: head } } }) },
        repos: { createDeploymentStatus: async (args) => { statuses.push(args); } },
      } },
      exec: { exec: async (command, args) => { commands.push([command, args]); } },
    });
    expect(commands.length).toBe(destroys ? 1 : 0);
    expect(statuses[0]).toMatchObject({ deployment_id: 99, state: status, auto_inactive: false });
    expect(statuses[0].environment_url).toBe(status === "success" ? "https://pr-7.example.com" : undefined);
  }
});

test("destroying an old preview deactivates this PR's records, but not its replacement or other PRs", async () => {
  const statuses = [];
  const queries = [];
  const commands = [];
  await runInNewContext(`(async () => { ${previewScript("Destroy old preview and all its data")} })()`, {
    context,
    process: { env: { PR_NUMBER: "7", DEPLOYMENT_ID: "100" } },
    exec: { exec: async (command, args) => { commands.push([command, args]); } },
    github: {
      paginate: async (method, args) => method(args),
      rest: { repos: {
        listDeployments: async (args) => {
          queries.push(args);
          return args.environment === "dev"
            ? [
              { id: 98, description: "PR #8 preview" },
              { id: 99, description: "PR #7 preview" },
              { id: 100, description: "PR #7 preview" },
            ]
            : [{ id: 97, description: "PR #7 preview" }];
        },
        createDeploymentStatus: async (args) => { statuses.push(args); },
      } },
    },
  });
  expect(commands).toEqual([["bash", ["deploy/stack.sh", "destroy"]]]);
  expect(queries).toEqual([
    { ...repo, environment: "dev", per_page: 100 },
    { ...repo, environment: "dev-pr-7", per_page: 100 },
  ]);
  expect(statuses).toEqual([
    { ...repo, deployment_id: 99, state: "inactive" },
    { ...repo, deployment_id: 97, state: "inactive" },
  ]);
});

test("preview cleanup deactivates only that PR's deployments and respects reopened PRs", async () => {
  const workflow = readFileSync(resolve(".github/workflows/preview-cleanup.yml"), "utf8");
  const cleanup = workflow.split("\n  registry:")[0];
  expect(cleanup).toContain("deployments: write");
  const script = cleanup.split("script: |")[1];
  for (const [eventName, state, shouldClean] of [
    ["pull_request_target", "closed", true],
    ["pull_request_target", "open", false],
    ["workflow_dispatch", "open", true],
  ]) {
    const commands = [];
    const statuses = [];
    const queries = [];
    await runInNewContext(`(async () => { ${script} })()`, {
      context: { ...context, eventName },
      process: { env: { PR_NUMBER: "7" } },
      github: {
        paginate: async (method, args) => method(args),
        rest: {
          pulls: { get: async () => ({ data: { state } }) },
          repos: {
            listDeployments: async (args) => {
              queries.push(args);
              return args.environment === "dev"
                ? [
                  { id: 99, description: "PR #7 preview" },
                  { id: 100, description: "PR #8 preview" },
                ]
                : [{ id: 98, description: "PR #7 preview" }];
            },
            createDeploymentStatus: async (args) => { statuses.push(args); },
          },
        },
      },
      exec: { exec: async (command, args) => { commands.push([command, args]); } },
    });
    expect(commands.length).toBe(shouldClean ? 1 : 0);
    expect(queries).toEqual(shouldClean ? [
      { ...repo, environment: "dev", per_page: 100 },
      { ...repo, environment: "dev-pr-7", per_page: 100 },
    ] : []);
    expect(statuses.map(({ deployment_id, state }) => ({ deployment_id, state }))).toEqual(
      shouldClean ? [
        { deployment_id: 99, state: "inactive" },
        { deployment_id: 98, state: "inactive" },
      ] : [],
    );
  }
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
