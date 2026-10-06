import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { cleanupLegacyArtifacts } from "../.github/scripts/artifact-cleanup.mjs";

const now = Date.parse("2026-10-06T12:00:00Z");
const old = "2026-10-04T12:00:00Z";
const recent = "2026-10-06T11:00:00Z";
const sha = "a".repeat(40);
const main = "b".repeat(40);
const context = { repo: { owner: "jupe", repo: "OpenJury" }, eventName: "workflow_dispatch", ref: "refs/heads/main" };

function archive(id = 1) {
  return {
    id, name: `image-${id + 100}`, expired: false, size_in_bytes: 4096,
    created_at: old, updated_at: old,
    workflow_run: { id: id + 100, repository_id: 42, head_repository_id: 42, head_branch: "main", head_sha: sha },
  };
}

function fixture(artifacts = [archive()]) {
  const calls = [];
  const runs = new Map(artifacts.map((artifact) => [artifact.workflow_run.id, {
    id: artifact.workflow_run.id, workflow_id: 10, event: "push", head_branch: "main", head_sha: sha,
    status: "completed", updated_at: old,
    repository: { id: 42, full_name: "jupe/OpenJury" },
    head_repository: { id: 42, full_name: "jupe/OpenJury" },
  }]));
  const state = { releases: [], main, artifacts, runs, summary: "", calls, deleted: [] };
  const actions = {
    async getWorkflow({ workflow_id }) {
      return { data: { id: workflow_id === "ci.yml" ? 10 : 20, path: `.github/workflows/${workflow_id}` } };
    },
    async listArtifactsForRepo({ page, per_page }) {
      calls.push(`artifacts:${page}`);
      return { data: { artifacts: artifacts.slice((page - 1) * per_page, page * per_page) } };
    },
    async listWorkflowRuns({ page, per_page, workflow_id, ...params }) {
      expect(workflow_id).toBe(20);
      expect(params).not.toHaveProperty("status");
      calls.push(`releases:${page}`);
      return { data: { workflow_runs: state.releases.slice((page - 1) * per_page, page * per_page) } };
    },
    async getWorkflowRun({ run_id }) {
      calls.push(`run:${run_id}`);
      return { data: state.runs.get(run_id) };
    },
    async getArtifact({ artifact_id }) {
      return { data: state.artifacts.find((artifact) => artifact.id === artifact_id) };
    },
    async deleteArtifact({ artifact_id }) {
      calls.push(`delete:${artifact_id}`);
      state.deleted.push(artifact_id);
    },
  };
  const github = {
    rest: {
      actions,
      repos: { async getBranch() { return { data: { commit: { sha: state.main } } }; } },
    },
    async paginate(method, params) {
      const values = [];
      for (let page = 1; ; page++) {
        const { data } = await method({ ...params, page });
        const batch = data.artifacts || data.workflow_runs;
        values.push(...batch);
        if (batch.length < params.per_page) return values;
      }
    },
  };
  const summary = { addHeading() { return this; }, addRaw(text) { state.summary += text; return this; }, async write() {} };
  const options = { github, context, core: { info() {}, summary }, now };
  return { state, actions, options, run: (dryRun = true) => cleanupLegacyArtifacts({ ...options, dryRun }) };
}

test("dry run is the default and reports potential, not reclaimed, bytes", async () => {
  const f = fixture();
  expect(await cleanupLegacyArtifacts(f.options)).toMatchObject({ eligible: 1, eligibleBytes: 4096, deleted: 0, reclaimedBytes: 0 });
  expect(f.state.deleted).toEqual([]);
  expect(f.state.summary).toContain("dry run (no deletions)");
});

test("all artifact pages and candidate metadata are read before the first deletion", async () => {
  const f = fixture(Array.from({ length: 101 }, (_, index) => archive(index + 1)));
  const stats = await f.run(false);
  expect(stats).toMatchObject({ listed: 101, deleted: 101, reclaimedBytes: 101 * 4096 });
  expect(f.state.calls.indexOf("artifacts:2")).toBeLessThan(f.state.calls.indexOf("delete:1"));
  expect(f.state.calls.indexOf("run:201")).toBeLessThan(f.state.calls.indexOf("delete:1"));
});

test("the 24-hour minimum includes the boundary but excludes younger artifacts", async () => {
  for (const [age, expected] of [[24 * 60 * 60 * 1000, 1], [24 * 60 * 60 * 1000 - 1, 0]]) {
    const f = fixture();
    f.state.artifacts[0].created_at = new Date(now - age).toISOString();
    f.state.artifacts[0].updated_at = new Date(now - age).toISOString();
    f.state.runs.get(101).updated_at = new Date(now - age).toISOString();
    expect(await f.run(false)).toMatchObject({ deleted: expected });
  }
});

test("duplicate inventory entries cannot double-count deletion or bytes", async () => {
  const f = fixture([archive(), archive()]);
  expect(await f.run(false)).toMatchObject({ eligible: 1, deleted: 1, reclaimedBytes: 4096 });
});

for (const [label, modify] of [
  ["image references", (a) => { a.name = "image-ref-101"; }],
  ["reports", (a) => { a.name = "playwright-report-101"; }],
  ["lookalike archives", (a) => { a.name = "image-101-extra"; }],
  ["mismatched run ID", (a) => { a.name = "image-999"; }],
  ["expired archives", (a) => { a.expired = true; }],
  ["recent creation", (a) => { a.created_at = recent; }],
  ["recent update", (a) => { a.updated_at = recent; }],
  ["invalid timestamp", (a) => { a.created_at = "invalid"; }],
  ["missing size", (a) => { delete a.size_in_bytes; }],
  ["missing linkage", (a) => { delete a.workflow_run; }],
  ["foreign artifact repository", (a) => { a.workflow_run.repository_id = 99; }],
  ["foreign artifact head repository", (a) => { a.workflow_run.head_repository_id = 99; }],
  ["artifact SHA mismatch", (a) => { a.workflow_run.head_sha = main; }],
  ["PR event", (_, r) => { r.event = "pull_request"; }],
  ["PR target event", (_, r) => { r.event = "pull_request_target"; }],
  ["merge group event", (_, r) => { r.event = "merge_group"; }],
  ["non-main branch", (_, r) => { r.head_branch = "topic"; }],
  ["different workflow", (_, r) => { r.workflow_id = 11; }],
  ["in-progress CI", (_, r) => { r.status = "in_progress"; }],
  ["pending CI", (_, r) => { r.status = "pending"; }],
  ["recent CI rerun", (_, r) => { r.updated_at = recent; }],
  ["foreign head repository", (_, r) => { r.head_repository = { id: 99, full_name: "fork/OpenJury" }; }],
  ["foreign run repository", (_, r) => { r.repository = { id: 99, full_name: "fork/OpenJury" }; }],
  ["current main SHA", (a, r) => { a.workflow_run.head_sha = main; r.head_sha = main; }],
]) {
  test(`preserves ${label}`, async () => {
    const f = fixture();
    modify(f.state.artifacts[0], f.state.runs.get(101));
    expect(await f.run(false)).toMatchObject({ eligible: 0, deleted: 0 });
    expect(f.state.deleted).toEqual([]);
  });
}

for (const status of ["in_progress", "queued", "pending", "waiting", "requested", "future_status", undefined]) {
  test(`a ${status} Release on any SHA blocks cleanup, including later pages`, async () => {
    const f = fixture();
    f.state.releases = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, workflow_id: 20, status: "completed" }));
    f.state.releases.push({ id: 101, workflow_id: 20, status, head_sha: "c".repeat(40) });
    expect(await f.run(false)).toMatchObject({ blocked: true, deleted: 0 });
    expect(f.state.calls).toContain("releases:2");
  });
}

test("completed Releases do not block obsolete artifacts", async () => {
  const f = fixture();
  f.state.releases = [{ id: 1, workflow_id: 20, status: "completed", head_sha: sha }];
  expect(await f.run(false)).toMatchObject({ deleted: 1 });
});

for (const change of ["main", "release", "ci", "artifact"]) {
  test(`rechecks ${change} before deleting`, async () => {
    const f = fixture();
    const original = f.actions.getWorkflowRun;
    let reads = 0;
    f.actions.getWorkflowRun = async (params) => {
      const result = await original(params);
      if (++reads === 1) {
        if (change === "main") f.state.main = sha;
        if (change === "release") f.state.releases = [{ id: 1, workflow_id: 20, status: "waiting" }];
        if (change === "ci") f.state.runs.set(101, { ...result.data, status: "in_progress" });
        if (change === "artifact") f.state.artifacts = [{ ...archive(), updated_at: recent }];
      }
      return result;
    };
    expect(await f.run(false)).toMatchObject({ deleted: 0 });
    expect(f.state.deleted).toEqual([]);
  });
}

for (const method of ["getWorkflow", "listArtifactsForRepo", "listWorkflowRuns", "getWorkflowRun", "getArtifact"]) {
  test(`fails closed on ${method} metadata errors, including 404`, async () => {
    const f = fixture();
    f.actions[method] = async () => { throw Object.assign(new Error("metadata unavailable"), { status: 404 }); };
    await expect(f.run(false)).rejects.toThrow("metadata unavailable");
    expect(f.state.deleted).toEqual([]);
  });
}

test("a later candidate metadata failure prevents all deletions", async () => {
  const f = fixture([archive(1), archive(2)]);
  const original = f.actions.getWorkflowRun;
  f.actions.getWorkflowRun = async (params) => {
    if (params.run_id === 102) throw new Error("rate limited");
    return original(params);
  };
  await expect(f.run(false)).rejects.toThrow("rate limited");
  expect(f.state.deleted).toEqual([]);
});

test("unverified workflow identity or missing main metadata fails closed", async () => {
  for (const metadata of ["workflow", "main", "release"]) {
    const f = fixture();
    if (metadata === "workflow") f.actions.getWorkflow = async () => ({ data: { id: 10, path: ".github/workflows/not-ci.yml" } });
    if (metadata === "main") f.state.main = undefined;
    if (metadata === "release") f.state.releases = [{ id: 1, status: "completed" }];
    await expect(f.run(false)).rejects.toThrow("Cleanup stopped");
    expect(f.state.deleted).toEqual([]);
  }
});

test("a main-branch lookup failure prevents any deletion", async () => {
  const f = fixture();
  f.options.github.rest.repos.getBranch = async () => { throw new Error("branch unavailable"); };
  await expect(f.run(false)).rejects.toThrow("branch unavailable");
  expect(f.state.deleted).toEqual([]);
});

test("a deletion failure stops before later candidates and reports only successful bytes", async () => {
  const f = fixture([archive(1), archive(2), archive(3)]);
  const original = f.actions.deleteArtifact;
  f.actions.deleteArtifact = async (params) => {
    if (params.artifact_id === 2) throw Object.assign(new Error("forbidden"), { status: 403 });
    return original(params);
  };
  await expect(f.run(false)).rejects.toThrow("forbidden");
  expect(f.state.deleted).toEqual([1]);
  expect(f.state.summary).toContain("deleted: 1;");
  expect(f.state.summary).toContain("reclaimed bytes: 4096");
});

for (const status of [404, 403, 429, 500]) {
  test(`artifact deletion ${status} is ${status === 404 ? "a safe missing-artifact race" : "fatal"}`, async () => {
    const f = fixture();
    f.actions.deleteArtifact = async () => { throw Object.assign(new Error("delete failed"), { status }); };
    if (status === 404) {
      expect(await f.run(false)).toMatchObject({ deleted: 0, reclaimedBytes: 0, missing: 1 });
    } else {
      await expect(f.run(false)).rejects.toThrow("delete failed");
    }
    expect(f.state.summary).toContain("reclaimed bytes: 0");
  });
}

test("only manual main runs and boolean inputs are accepted", async () => {
  const f = fixture();
  for (const override of [
    { dryRun: "false" },
    { context: { ...context, ref: "refs/heads/topic" } },
    { context: { ...context, eventName: "push" } },
  ]) {
    await expect(cleanupLegacyArtifacts({ ...f.options, ...override })).rejects.toThrow("Cleanup stopped");
  }
  expect(f.state.calls).toEqual([]);
});

test("workflow is main-only, manual, dry-run by default, with only job-scoped artifact writes", () => {
  const workflow = readFileSync(".github/workflows/artifact-cleanup.yml", "utf8");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("type: boolean\n        default: true");
  expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  expect(workflow.split("jobs:")[0]).not.toContain("actions: write");
  expect(workflow.match(/actions: write/g)).toHaveLength(1);
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).not.toMatch(/schedule:|secrets[.:]|packages:|pull_request|deleteWorkflowRun/);
  for (const action of ["checkout", "github-script"]) {
    const pin = workflow.match(new RegExp(`uses: actions/${action}@([a-f0-9]{40})`))[0];
    expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(pin);
  }
});
