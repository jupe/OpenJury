import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { assessDiff, hasRequiredProtection, latestReviews, mergeMinorPRs } from "../.github/scripts/minor-pr.mjs";
import { notifyDeployment } from "../.github/scripts/deployment-feedback.mjs";
import { shouldRunChecks } from "../.github/scripts/ci-changes.mjs";

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

test("main release handoff does not depend on artifact storage or bypass checks", () => {
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const publish = workflowStep(ci, "Publish tested main image");
  expect(publish).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(publish).not.toContain("continue-on-error");
  expect(ci.indexOf("- name: Test production image")).toBeLessThan(ci.indexOf("- name: Publish tested main image"));
  const sign = ci.split("\n  sign:")[1].split("\n  preview:")[0];
  expect(sign).toContain("needs: [build, checks]");
  expect(sign).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(sign).toContain("environment: release-signing");
  expect(sign).toContain("IMAGE_DIGEST: ${{ needs.build.outputs.image-digest }}");
  expect(sign).toContain("COSIGN_PRIVATE_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}");
  expect(sign).not.toMatch(/continue-on-error|checkout|self-hosted/);
  expect(ci.split("\n  sign:")[0]).not.toContain("COSIGN_PRIVATE_KEY");
  expect(ci).not.toMatch(/actions\/attest@|attestations:|id-token:/);
  for (const name of ["Save tested image", "Upload tested image"]) {
    const step = workflowStep(ci, name);
    expect(step).toContain("if: github.event_name == 'pull_request' && steps.preview-image.outcome != 'success'");
    expect(step).not.toContain("github.event_name == 'push'");
  }
  const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  expect(release).not.toMatch(/download-artifact|docker (build|load)|release-image/);
  expect(release).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(release).toContain("github.event.workflow_run.event == 'push'");
  expect(release).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  expect(release).toContain("CI_RUN_ID: ${{ github.event.workflow_run.id }}");
  expect(release).toContain("COSIGN_PUBLIC_KEY: ${{ vars.COSIGN_PUBLIC_KEY }}");
  expect(release).not.toContain("COSIGN_PRIVATE_KEY");
  expect(release).not.toMatch(/gh attestation|attestations:/);
  for (const workflow of [sign, release]) {
    expect(workflow).toContain("sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6");
    expect(workflow).toContain("cosign-release: v3.1.3");
  }
  expect(publish).not.toContain("GITHUB_RUN_ATTEMPT");
  expect(release).not.toContain("workflow_run.run_attempt");
  expect(release).toContain("if: steps.current.outputs.current == 'true'");
  expect(release).toContain("data.commit.sha === context.payload.workflow_run.head_sha");
  expect(release).toContain("needs.staging.result == 'success' && vars.CD_ENABLED == 'true'");
  const deploy = readFileSync(resolve(".github/workflows/deploy.yml"), "utf8");
  expect(workflowStep(deploy, "Upload smoke report")).toContain("continue-on-error: true");
  expect(workflowStep(deploy, "Smoke test through the public ingress")).not.toContain("continue-on-error");
});

for (const workflow of ["ci.yml", "release.yml"]) {
  for (const failure of ["", "revision", "pull", "push", "digest", "signature"]) {
    if (workflow === "ci.yml" && ["pull", "signature"].includes(failure)) continue;
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
          docker() {
            printf '%s\\n' "$*" >> "$DOCKER_LOG"
            case "$1" in
              login) cat >/dev/null ;;
              logout|tag) return 0 ;;
              pull|push) test "$FAILURE" != "$1" ;;
              image)
                if [[ "$*" == *RepoDigests* ]]; then
                  if [[ "$FAILURE" == digest ]]; then printf 'ghcr.io/other/image@sha256:invalid\\n';
                  else printf '%s\\n' "$EXPECTED_DIGEST"; fi
                elif [[ "$FAILURE" == revision ]]; then printf 'wrong-revision\\n';
                else printf '%s\\n' "$REVISION"; fi ;;
              *) return 1 ;;
            esac
          }
          cosign() {
            printf 'cosign %s\\n' "$*" >> "$DOCKER_LOG"
            test "$FAILURE" != signature
          }
          export -f docker cosign
          ${script}
        `], {
          env: {
            ...process.env,
            GITHUB_REPOSITORY: fullName,
            GITHUB_SHA: sha,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "2",
            CI_RUN_ID: "123",
            REVISION: sha,
            GITHUB_ACTOR: "test",
            GH_TOKEN: "test-only",
            COSIGN_PUBLIC_KEY: "test-only-public-key",
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
            expect(commands).toContain(`pull ${source}`);
            expect(commands).toContain(`image inspect ${digest}`);
            expect(commands).toContain(`tag ${digest} ghcr.io/jupe/openjury:sha-${sha}`);
            expect(commands).toContain(`cosign verify --key env://COSIGN_PUBLIC_KEY --insecure-ignore-tlog=true -a repository=${fullName} -a workflow=${fullName}/.github/workflows/ci.yml@refs/heads/main -a ref=refs/heads/main -a revision=${sha} -a run-id=123 ${digest}`);
            expect(commands.indexOf("cosign verify")).toBeLessThan(commands.indexOf(`tag ${digest}`));
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

for (const failure of ["", "sign", "verify", "name", "digest", "private-key", "password", "public-key"]) {
  test(`private main signing fails closed: ${failure || "success"}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "openjury-sign-"));
    const log = join(directory, "commands");
    const digest = `sha256:${"b".repeat(64)}`;
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    const script = workflowStep(ci, "Sign and verify tested image").split("run: |")[1];
    try {
      const run = () => execFileSync("bash", ["-e", "-c", `
        : > "$COMMAND_LOG"
        docker() { printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"; cat >/dev/null; }
        cosign() {
          printf 'cosign %s\\n' "$*" >> "$COMMAND_LOG"
          test "$FAILURE" != "$1"
        }
        export -f docker cosign
        ${script}
      `], {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: fullName, GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main",
          GITHUB_RUN_ID: "123", GITHUB_ACTOR: "test", GH_TOKEN: "test-only",
          IMAGE_NAME: failure === "name" ? "ghcr.io/other/image" : "ghcr.io/jupe/openjury",
          IMAGE_DIGEST: failure === "digest" ? "invalid" : digest,
          COSIGN_PRIVATE_KEY: failure === "private-key" ? "" : "test-only-private-key",
          COSIGN_PASSWORD: failure === "password" ? "" : "test-only-password",
          COSIGN_PUBLIC_KEY: failure === "public-key" ? "" : "test-only-public-key",
          DOCKER_CONFIG: join(directory, "auth"), COMMAND_LOG: log, FAILURE: failure,
        },
      });
      if (failure) expect(run).toThrow();
      else expect(run).not.toThrow();
      const commands = readFileSync(log, "utf8");
      expect(commands).not.toMatch(/test-only-private-key|test-only-password|docker (build|run|pull)/);
      if (!failure) {
        const annotations = `-a repository=${fullName} -a workflow=${fullName}/.github/workflows/ci.yml@refs/heads/main -a ref=refs/heads/main -a revision=${sha} -a run-id=123 ghcr.io/jupe/openjury@${digest}`;
        expect(commands).toContain(`cosign sign --yes --key env://COSIGN_PRIVATE_KEY --use-signing-config=false --tlog-upload=false ${annotations}`);
        expect(commands).toContain(`cosign verify --key env://COSIGN_PUBLIC_KEY --insecure-ignore-tlog=true ${annotations}`);
      } else if (failure === "sign") {
        expect(commands).not.toContain("cosign verify");
      } else if (failure !== "verify") {
        expect(commands).toBe("");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
  const checks = workflow.split("\n  checks:")[1].split(/\n  [a-z]+:/)[0];
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
