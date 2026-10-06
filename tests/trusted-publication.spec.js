import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getTrustedPublication, validatePublication, validateSourceRun,
} from "../.github/scripts/trusted-publication.mjs";

const repository = "jupe/OpenJury";
const revision = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const image = `ghcr.io/jupe/openjury@sha256:${"c".repeat(64)}`;

function fixture() {
  const state = {
    workflow: { id: 3, name: "CI", path: ".github/workflows/ci.yml" },
    run: {
      id: 9, run_attempt: 2, workflow_id: 3, path: ".github/workflows/ci.yml",
      repository: { full_name: repository }, head_repository: { full_name: repository },
      head_sha: revision, event: "push", head_branch: "main",
      status: "completed", conclusion: "success",
    },
    jobs: [{
      name: "Publish tested main image", status: "completed",
      conclusion: "success", run_attempt: 2,
    }],
    artifacts: [{
      id: 100, name: "published-image-9-2", expired: false,
      workflow_run: { id: 9, head_sha: revision },
    }],
    pr: { state: "open", head: { repo: { full_name: repository } } },
    requests: [],
  };
  const actions = {
    getWorkflow: async (args) => {
      state.requests.push(args);
      expect(args).toEqual({ owner: "jupe", repo: "OpenJury", workflow_id: "ci.yml" });
      return { data: state.workflow };
    },
    getWorkflowRun: async (args) => {
      state.requests.push(args);
      expect(args).toEqual({ owner: "jupe", repo: "OpenJury", run_id: 9 });
      return { data: state.run };
    },
    listJobsForWorkflowRun() {},
    listWorkflowRunArtifacts() {},
  };
  const github = {
    rest: {
      actions,
      repos: { getBranch: async () => ({ data: { commit: { sha: revision } } }) },
      pulls: { get: async () => ({ data: state.pr }) },
    },
    paginate: async (method, args) => {
      expect(args).toMatchObject({ owner: "jupe", repo: "OpenJury", run_id: 9, per_page: 100 });
      if (method === actions.listJobsForWorkflowRun) {
        expect(args.filter).toBe("latest");
        return state.jobs;
      }
      expect(method).toBe(actions.listWorkflowRunArtifacts);
      return state.artifacts;
    },
  };
  return { state, github, lookup: () => getTrustedPublication({ github, repository, runId: 9 }) };
}

function publication() {
  return { repository, revision, imageId, image, runId: "9", runAttempt: "2" };
}

test("publication resolves workflow path and ID through the source repository API", async () => {
  const { state, lookup } = fixture();
  const result = await lookup();
  expect(result).toEqual({ run: state.run, artifact: state.artifacts[0] });
  expect(state.requests).toHaveLength(2);
  state.workflow.name = "Display names are not identity";
  await expect(lookup()).resolves.toEqual(result);
});

for (const [name, change] of [
  ["forged workflow ID", { workflow_id: 4 }],
  ["forged workflow path", { path: ".github/workflows/evil.yml" }],
  ["foreign run repository", { repository: { full_name: "fork/OpenJury" } }],
  ["fork head repository", { head_repository: { full_name: "fork/OpenJury" } }],
  ["PR event", { event: "pull_request" }],
  ["manual event", { event: "workflow_dispatch" }],
  ["non-main branch", { head_branch: "feature" }],
  ["incomplete run", { status: "in_progress" }],
  ["failed run", { conclusion: "failure" }],
  ["invalid revision", { head_sha: "not-a-sha" }],
  ["invalid attempt", { run_attempt: 0 }],
  ["invalid run ID", { id: 0 }],
]) {
  test(`trusted source rejects ${name}`, async () => {
    const { state, lookup } = fixture();
    Object.assign(state.run, change);
    expect(() => validateSourceRun(state.run, state.workflow, repository)).toThrow("trusted CI workflow");
    await expect(lookup()).rejects.toThrow("trusted CI workflow");
  });
}

test("a different API workflow path is rejected even when its display name is CI", async () => {
  const { state, lookup } = fixture();
  state.workflow.path = ".github/workflows/evil.yml";
  await expect(lookup()).rejects.toThrow("trusted CI workflow");
});

for (const [name, mutate] of [
  ["missing publisher", (state) => { state.jobs = []; }],
  ["skipped publisher", (state) => { state.jobs[0].conclusion = "skipped"; }],
  ["publisher from previous attempt", (state) => { state.jobs[0].run_attempt = 1; }],
  ["missing record", (state) => { state.artifacts = []; }],
  ["expired record", (state) => { state.artifacts[0].expired = true; }],
  ["previous-attempt record", (state) => { state.artifacts[0].name = "published-image-9-1"; }],
  ["another run's record", (state) => { state.artifacts[0].workflow_run.id = 8; }],
  ["another revision's record", (state) => { state.artifacts[0].workflow_run.head_sha = "d".repeat(40); }],
  ["duplicate records", (state) => { state.artifacts.push({ ...state.artifacts[0], id: 101 }); }],
]) {
  test(`publication artifact rejects ${name}`, async () => {
    const { state, lookup } = fixture();
    mutate(state);
    await expect(lookup()).rejects.toThrow();
  });
}

for (const runId of ["0", "-1", "9;evil"]) {
  test(`source run ID ${runId} is rejected before any API request`, async () => {
    const { state, github } = fixture();
    await expect(getTrustedPublication({ github, repository, runId })).rejects.toThrow("Invalid source");
    expect(state.requests).toEqual([]);
  });
}

test("digest publication matches exact repository, revision, run, attempt, and image ID", () => {
  const { state } = fixture();
  expect(validatePublication(publication(), state.run, repository)).toEqual(publication());
});

for (const [name, change] of [
  ["mutable tag", { image: "ghcr.io/jupe/openjury:ci-9-2" }],
  ["foreign digest", { image: image.replace("jupe/", "fork/") }],
  ["malformed digest", { image: "ghcr.io/jupe/openjury@sha256:bad" }],
  ["extra digest suffix", { image: `${image}@extra` }],
  ["wrong repository", { repository: "fork/OpenJury" }],
  ["wrong revision", { revision: "d".repeat(40) }],
  ["wrong source run", { runId: "10" }],
  ["wrong attempt", { runAttempt: "1" }],
  ["invalid image ID", { imageId: "sha256:bad" }],
]) {
  test(`publication metadata rejects ${name}`, () => {
    const { state } = fixture();
    expect(() => validatePublication({ ...publication(), ...change }, state.run, repository))
      .toThrow("validated source run");
  });
}

function stepText(path, name) {
  return readFileSync(resolve(path), "utf8")
    .split(`- name: ${name}\n`)[1].split(/\n(?:      - |  [a-z])/)[0];
}

test("public workflows contain no self-hosted runners or calls into deployment templates", () => {
  for (const file of readdirSync(resolve(".github/workflows"))) {
    const text = readFileSync(resolve(".github/workflows", file), "utf8");
    expect(text).not.toContain("self-hosted");
    expect(text).not.toMatch(/uses:.*(?:deploy|preview)(?:-environment)?\.yml/);
  }
  for (const file of ["deploy.yml", "preview.yml", "preview-cleanup.yml"]) {
    expect(() => readFileSync(resolve(".github/workflows", file), "utf8")).toThrow();
  }
  const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const build = ci.split("\n  build:")[1].split("\n  checks:")[0];
  const publish = ci.split("\n  publish:")[1];
  expect(build).toContain("permissions:\n      contents: read");
  expect(build).not.toMatch(/packages: write|GH_TOKEN:|docker (login|push)/);
  expect(publish).toContain("permissions:\n      packages: write");
  expect(publish).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(publish).not.toMatch(/actions\/checkout|uses: \.\//);
  const archive = stepText(".github/workflows/ci.yml", "Upload tested image");
  expect(archive).toContain("tested-image-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(archive).toContain("image.tar");
  expect(archive).toContain("image.id");
  expect(archive).toContain("/revision");
  expect(archive).toContain("if-no-files-found: error");
  expect(archive).not.toContain("continue-on-error");
  expect(publish).toContain("name: tested-image-${{ github.run_id }}-${{ github.run_attempt }}");
});

for (const workflow of ["ci", "release"]) {
  const failures = workflow === "ci"
    ? ["", "archive-revision", "load", "image-id", "revision", "push", "digest"]
    : ["", "pull", "image-id", "revision", "push"];
  for (const failure of failures) {
    test(`${workflow} image handoff fails closed: ${failure || "success"}`, () => {
      const directory = mkdtempSync(resolve(".test-publication-"));
      mkdirSync(join(directory, "image"));
      writeFileSync(join(directory, "image/image.id"), imageId);
      writeFileSync(join(directory, "image/revision"), failure === "archive-revision" ? "wrong" : revision);
      writeFileSync(join(directory, "image/image.tar"), "mock archive");
      const log = join(directory, "docker.log");
      const step = stepText(`.github/workflows/${workflow}.yml`, workflow === "ci"
        ? "Validate and publish without executing source or rebuilding"
        : "Promote the tested digest, never a mutable CI tag");
      const script = step.split("run: |")[1];
      try {
        const execute = () => execFileSync("bash", ["-e", "-c", `
          docker() {
            printf '%s\\n' "$*" >> "$DOCKER_LOG"
            case "$1" in
              login) cat >/dev/null ;;
              logout|tag) return 0 ;;
              load|pull|push) test "$FAILURE" != "$1" ;;
              image)
                if [[ "$*" == *RepoDigests* ]]; then
                  if [[ "$FAILURE" == digest ]]; then printf 'ghcr.io/other/image@sha256:bad\\n';
                  else printf '%s\\n' "$IMAGE"; fi
                elif [[ "$*" == *".Id"* ]]; then
                  if [[ "$FAILURE" == image-id ]]; then printf 'sha256:%064d\\n' 1;
                  else printf '%s\\n' "$IMAGE_ID"; fi
                elif [[ "$FAILURE" == revision ]]; then printf 'wrong-revision\\n';
                else printf '%s\\n' "$REVISION"; fi ;;
              *) return 1 ;;
            esac
          }
          export -f docker
          ${script}
        `], {
          stdio: "pipe",
          env: {
            ...process.env, GITHUB_REPOSITORY: repository, GITHUB_SHA: revision,
            GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "2", GITHUB_ACTOR: "test",
            GH_TOKEN: "test-only", RUNNER_TEMP: directory, IMAGE: image, IMAGE_ID: imageId,
            REVISION: revision, DOCKER_LOG: log, DOCKER_CONFIG: join(directory, "auth"),
            GITHUB_STEP_SUMMARY: join(directory, "summary"), FAILURE: failure,
          },
        });
        if (failure) expect(execute).toThrow();
        else expect(execute).not.toThrow();
        const commands = (() => {
          try { return readFileSync(log, "utf8"); } catch { return ""; }
        })();
        expect(commands).not.toMatch(/^(build|save) /m);
        if (workflow === "release") {
          expect(commands).toContain(`pull ${image}`);
          expect(commands).not.toContain(":ci-");
          expect(commands).not.toMatch(/^load /m);
        }
        if (!failure && workflow === "ci") {
          expect(commands).toContain(`tag ${imageId} ghcr.io/jupe/openjury:ci-9-2`);
          expect(JSON.parse(readFileSync(join(directory, "published/image.json"), "utf8")))
            .toEqual(publication());
          expect(commands.indexOf("load ")).toBeLessThan(commands.indexOf("login "));
        } else if (!failure) {
          expect(commands).toContain(`tag ${image} ghcr.io/jupe/openjury:sha-${revision}`);
        } else {
          if (failure !== "push" && failure !== "digest") expect(commands).not.toMatch(/^push /m);
          expect(() => readFileSync(join(directory, "published/image.json"), "utf8")).toThrow();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const name of [
  "Select only successful trusted source main publication", "Reject stale or invalid releases",
]) {
  for (const [caseName, pr, passes] of [
    ["same-repository open PR", { state: "open", head: { repo: { full_name: repository } } }, true],
    ["fork PR", { state: "open", head: { repo: { full_name: "fork/OpenJury" } } }, false],
    ["closed PR", { state: "closed", head: { repo: { full_name: repository } } }, false],
    ["deleted head", { state: "open", head: { repo: null } }, false],
  ]) {
    test(`private ${name} gates ${caseName}`, async () => {
      const { state, github } = fixture();
      state.pr = pr;
      // Reuse the transformed import; native dynamic imports bypass Playwright's module wrapper.
      const script = stepText("deploy/workflows/deploy-environment.yml", name).split("script: |")[1]
        .replace(/await import\(`[^`]*trusted-publication\.mjs`\)/, "helpers");
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const run = new AsyncFunction("github", "core", "process", "helpers", script);
      const environment = {
        GITHUB_WORKSPACE: resolve("."), SOURCE_REPOSITORY: repository,
        SOURCE_RUN: "9", SOURCE_ATTEMPT: "2", REVISION: revision, TARGET: "dev", PR_NUMBER: "7",
      };
      const result = run(github, { setOutput() {} }, { env: environment }, { getTrustedPublication });
      if (passes) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow(/same-repository/);
    });
  }
}

test("private templates stay manual, validate inputs, and forward explicit environment settings", () => {
  const deploy = readFileSync(resolve("deploy/workflows/deploy.yml"), "utf8");
  expect(deploy).toContain("workflow_dispatch:");
  expect(deploy).not.toMatch(/^\s+schedule:/m);
  expect(deploy).toContain("github.event.repository.private == true");
  expect(deploy).toContain("source_attempt: ${{ fromJSON(needs.staging.outputs.source-attempt) }}");
  const worker = readFileSync(resolve("deploy/workflows/deploy-environment.yml"), "utf8");
  expect(worker).toContain("AUTH_RATE_LIMIT_EMAIL_SENT: ${{ vars.AUTH_RATE_LIMIT_EMAIL_SENT || '10' }}");
  expect(worker).toContain("PREVIEW_ADMIN_PASSWORD: ${{ inputs.environment == 'dev' && secrets.PREVIEW_ADMIN_PASSWORD || '' }}");
  expect(worker).toContain("PREVIEW_ADMIN_PASSWORD:?");
  expect(worker).toContain("repository: ${{ vars.SOURCE_REPOSITORY }}");
  expect(worker).toContain("ref: ${{ needs.source.outputs.revision }}");
  expect(worker).toContain("APP_SCHEME: ${{ inputs.environment == 'dev' && (vars.APP_SCHEME || 'https') || 'https' }}");
  expect(worker).toContain("format('pr-{0}.{1}', inputs.pr_number, vars.DEV_BASE_DOMAIN)");
  expect(worker).toContain("url: ${{ steps.deploy.outputs.url }}");
  expect(worker).toContain("String(run.run_attempt) !== process.env.SOURCE_ATTEMPT");
  expect(stepText("deploy/workflows/deploy-environment.yml", "Smoke test through the public ingress"))
    .not.toContain("continue-on-error");
  expect(worker).toContain("PLAYWRIGHT_BASE_URL: ${{ needs.deploy.outputs.url }}");
});

test("private smoke is hosted and gates production while failed dev smoke triggers trusted cleanup", () => {
  const worker = readFileSync(resolve("deploy/workflows/deploy-environment.yml"), "utf8");
  const deployment = worker.split("\n  deploy:")[1].split("\n  smoke:")[0];
  const smoke = worker.split("\n  smoke:")[1].split("\n  cleanup:")[0];
  expect(deployment).not.toMatch(/ci-images|npm run test:smoke/);
  expect(smoke).toContain("needs: [source, deploy]");
  expect(smoke).toContain("runs-on: ubuntu-24.04");
  expect(smoke).not.toContain("self-hosted");
  expect(smoke).toContain("repository: ${{ vars.SOURCE_REPOSITORY }}");
  expect(smoke).toContain("ref: ${{ needs.source.outputs.revision }}");
  expect(smoke).toContain("PLAYWRIGHT_BASE_URL: ${{ needs.deploy.outputs.url }}");
  expect(smoke).toContain("operator-approved VPN access");
  const cleanup = worker.split("\n  cleanup:")[1];
  expect(cleanup).toContain("needs: [source, deploy, smoke]");
  expect(cleanup).toContain("inputs.environment == 'dev'");
  expect(cleanup).toContain("needs.deploy.result == 'success'");
  expect(cleanup).toContain("needs.smoke.result != 'success'");
  expect(cleanup).toContain("ref: ${{ needs.source.outputs.revision }}");
  expect(cleanup).toContain("COMPOSE_PROJECT_NAME: openjury-pr-${{ inputs.pr_number }}");
  expect(cleanup).not.toMatch(/inputs\.(sha|image)|head\.sha|packages: write/);
  const orchestrator = readFileSync(resolve("deploy/workflows/deploy.yml"), "utf8");
  expect(orchestrator).toContain("needs: staging");
});

for (const [target, scheme, passes, promotion = "matched"] of [
  ["dev", "http", true],
  ["dev", "https", true],
  ["staging", "https", true],
  ["production", "https", true],
  ["staging", "http", false],
  ["production", "http", false],
  ["dev", "ftp", false],
  ["staging", "https", false, "missing"],
  ["staging", "https", false, "mismatch"],
  ["staging", "https", false, "malformed"],
  ["staging", "https", false, "multi-platform"],
  ["staging", "https", false, "missing-descriptor"],
]) {
  test(`private ${target} scheme ${scheme}, promotion ${promotion} ${passes ? "works" : "is rejected"}`, () => {
    const directory = mkdtempSync(resolve(".test-deployment-scheme-"));
    const output = join(directory, "output");
    const summary = join(directory, "summary");
    const log = join(directory, "commands");
    const host = target === "dev" ? "pr-7.dev.example.invalid" : `${target}.example.invalid`;
    const script = stepText("deploy/workflows/deploy-environment.yml", "Deploy immutable image")
      .split("run: |")[1];
    try {
      const execute = () => execFileSync("bash", ["-e", "-c", `
        docker() {
          printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
          case "$1" in
            login) cat >/dev/null ;;
            pull|logout) return 0 ;;
            manifest)
              case "$PROMOTION_RESULT" in
                missing) return 1 ;;
                mismatch) printf '{"Descriptor":{"digest":"sha256:%064d"}}\\n' 1 ;;
                malformed) printf '{"Descriptor":{"digest":"bad"}}\\n' ;;
                multi-platform) printf '[]\\n' ;;
                missing-descriptor) printf '{}\\n' ;;
                *) printf '{"Descriptor":{"digest":"%s"}}\\n' "\${IMAGE#*@}" ;;
              esac ;;
            image)
              if [[ "$*" == *".Id"* ]]; then printf '%s\\n' "$IMAGE_ID";
              else printf '%s\\n' "$REVISION"; fi ;;
            *) return 1 ;;
          esac
        }
        bash() { printf 'bash %s\\n' "$*" >> "$COMMAND_LOG"; }
        export -f docker bash
        ${script}
      `], {
        stdio: "pipe",
        env: {
          ...process.env, IMAGE: image, IMAGE_ID: imageId, REVISION: revision,
          SOURCE_REPOSITORY: repository, TARGET: target, APP_SCHEME: scheme, APP_HOST: host,
          PREVIEW_ADMIN_PASSWORD: target === "dev" ? "test-only" : "",
          GH_TOKEN: "test-only", GHCR_USERNAME: "test", DOCKER_CONFIG: join(directory, "auth"),
          GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, COMMAND_LOG: log,
          PROMOTION_RESULT: promotion,
        },
      });
      if (passes) {
        expect(execute).not.toThrow();
        expect(readFileSync(output, "utf8")).toBe(`url=${scheme}://${host}\n`);
        expect(readFileSync(summary, "utf8")).toContain(`URL: ${scheme}://${host}`);
        const commands = readFileSync(log, "utf8");
        const confirmation = `docker manifest inspect --verbose ghcr.io/jupe/openjury:sha-${revision}`;
        expect(commands).toContain(confirmation);
        expect(commands).toContain(`docker pull ${image}`);
        expect(commands.indexOf(confirmation)).toBeLessThan(commands.indexOf(`docker pull ${image}`));
        expect(commands).not.toContain(`docker pull ghcr.io/jupe/openjury:sha-${revision}`);
        expect(commands).toContain("bash deploy/stack.sh deploy");
      } else {
        expect(execute).toThrow();
        expect(() => readFileSync(output, "utf8")).toThrow();
        if (promotion === "matched") {
          expect(() => readFileSync(log, "utf8")).toThrow();
        } else {
          const commands = readFileSync(log, "utf8");
          expect(commands).toContain("docker manifest inspect --verbose");
          expect(commands).not.toMatch(/docker pull|bash deploy\/stack\.sh/);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
