import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanupCandidates, cleanupRegistry } from "../.github/scripts/registry-cleanup.mjs";

const now = Date.parse("2026-10-06T00:00:00Z");
const DAY = 86400000;
const hash = "a".repeat(64);
const sha = "b".repeat(40);
const preview = (number) => `pr-${number}-${sha}`;
const core = { info() {} };

function version(id, names, age = 30) {
  const date = new Date(now - age * DAY).toISOString();
  return { id, created_at: date, updated_at: date, metadata: { container: { tags: names } } };
}

function candidates(kind, versions, closedPRs = new Set()) {
  return cleanupCandidates({ kind, versions, closedPRs, now }).map((item) => item.id);
}

test("release cleanup preserves promoted, unknown, untagged, recent and five newest CI versions", () => {
  const versions = [
    ...Array.from({ length: 7 }, (_, i) => version(i + 1, [`ci-${i + 1}`], i + 10)),
    version(8, ["ci-8", `sha-${sha}`]),
    version(9, ["ci-9", "production"]),
    version(10, []),
    version(11, ["sha256-signature"]),
    version(12, ["ci-12"], 1),
  ];
  expect(candidates("release", versions)).toEqual([5, 6, 7]);
});

test("release cleanup recognizes run-attempt tags alongside legacy tags without deleting promoted digests", () => {
  const versions = [
    ...Array.from({ length: 5 }, (_, i) => version(i + 1, [`ci-${i + 1}-2`], i + 10)),
    version(6, ["ci-6-1"]),
    version(7, ["ci-7"]),
    version(8, ["ci-8", "ci-8-2"]),
    version(9, ["ci-9-2", `sha-${sha}`]),
    version(10, ["ci-10-2", "production"]),
    ...["ci-0-1", "ci-11-0", "ci-11-01", "ci-11-2-extra"].map((tag, i) =>
      version(11 + i, [tag])),
  ];
  expect(candidates("release", versions)).toEqual([6, 7, 8]);
});

test("cache cleanup preserves two versions per target, unknown tags and refreshed old digests", () => {
  const versions = [
    version(1, [`tools-${hash}`], 10),
    version(2, [`tools-${hash}`], 11),
    version(3, [`dependencies-${hash}`], 10),
    version(4, [`dependencies-${hash}`], 11),
    version(5, [`tools-${hash}`], 20),
    version(6, [`dependencies-${hash}`], 20),
    version(7, []),
    version(8, ["manual-keep"]),
    version(9, [`tools-${hash}`, "manual-keep"]),
    version(10, [], 1),
  ];
  expect(candidates("cache", versions)).toEqual([5, 6, 7]);
  versions[6].updated_at = new Date(now).toISOString();
  expect(candidates("cache", versions)).toEqual([5, 6]);
});

test("preview cleanup requires every tag to belong to a closed PR and three days of grace", () => {
  const versions = [
    version(1, [preview(1)]),
    version(2, [preview(2)]),
    version(3, [preview(1), preview(2)]),
    version(4, [preview(1), preview(3)]),
    version(5, [preview(1), "manual-keep"]),
    version(6, []),
    version(7, ["pr-1-malformed"]),
    version(8, [preview(1)], 1),
    version(9, [preview(1)], 3),
  ];
  expect(candidates("preview", versions, new Set([1, 3]))).toEqual([1, 4]);
});

test("cleanup keeps the last version and fails closed on missing metadata or dates", () => {
  expect(candidates("cache", [version(1, [])])).toEqual([]);
  expect(candidates("cache", [
    version(1, [], 1),
    { ...version(2, []), updated_at: undefined },
    { ...version(3, []), metadata: undefined },
  ])).toEqual([]);
  expect(() => candidates("other", [])).toThrow("Unknown registry retention policy");
});

function fixture({ org = false, inventory = {}, state = "closed", error, refreshed } = {}) {
  const calls = [];
  const deleted = [];
  const context = {
    repo: { owner: "jupe", repo: "OpenJury" },
    payload: { repository: { owner: { type: org ? "Organization" : "User" } } },
  };
  const list = async (params) => {
    if (error?.list) throw Object.assign(new Error("inventory failed"), { status: error.list });
    return inventory[params.package_name] || [];
  };
  const get = async (params) => {
    if (error?.get) throw Object.assign(new Error("lookup failed"), { status: error.get });
    return { data: refreshed || inventory[params.package_name].find((item) => item.id === params.package_version_id) };
  };
  const remove = async (params) => {
    if (error?.remove) throw Object.assign(new Error("delete failed"), { status: error.remove });
    deleted.push(params);
  };
  const packages = org ? {
    getAllPackageVersionsForPackageOwnedByOrg: list,
    getPackageVersionForOrganization: get,
    deletePackageVersionForOrg: remove,
  } : {
    getAllPackageVersionsForPackageOwnedByUser: list,
    getPackageVersionForUser: get,
    deletePackageVersionForUser: remove,
  };
  const github = {
    rest: {
      packages,
      pulls: { get: async ({ pull_number }) => ({ data: {
        state: typeof state === "function" ? state(pull_number) : state,
      } }) },
    },
    paginate: async (method, params) => {
      expect(method).toBe(list);
      expect(params.per_page).toBe(100);
      expect(params.package_type).toBe("container");
      expect(params[org ? "org" : "username"]).toBe("jupe");
      calls.push(params.package_name);
      return method(params);
    },
  };
  return { github, context, core, now, calls, deleted };
}

for (const org of [false, true]) {
  test(`registry cleanup scopes paginated requests to repository packages (organization=${org})`, async () => {
    const env = fixture({ org, inventory: { "openjury-ci": [
      version(1, [], 1), version(2, []),
    ] } });
    expect(await cleanupRegistry({ ...env, dryRun: false })).toEqual({ candidates: 1, deleted: 1 });
    expect(env.calls).toEqual(["openjury", "openjury-ci", "openjury-preview"]);
    expect(env.deleted[0]).toMatchObject({ package_name: "openjury-ci", package_version_id: 2 });
  });
}

test("manual cleanup defaults to a non-destructive dry run", async () => {
  const env = fixture({ inventory: { "openjury-ci": [version(1, [], 1), version(2, [])] } });
  expect(await cleanupRegistry(env)).toEqual({ candidates: 1, deleted: 0 });
  expect(env.deleted).toEqual([]);
});

test("closed-PR cleanup never touches the release or cache packages", async () => {
  const env = fixture({ inventory: { "openjury-preview": [
    version(1, [preview(1)], 1), version(2, [preview(2)]),
  ] } });
  await cleanupRegistry({ ...env, dryRun: false, previewOnly: true });
  expect(env.calls).toEqual(["openjury-preview"]);
  expect(env.deleted.map((item) => item.package_version_id)).toEqual([2]);
});

test("cleanup rechecks PRs and protects images if a PR reopens", async () => {
  let reads = 0;
  const env = fixture({
    inventory: { "openjury-preview": [version(1, [preview(1)], 1), version(2, [preview(2)])] },
    state: (number) => number === 2 && ++reads > 1 ? "open" : "closed",
  });
  await cleanupRegistry({ ...env, dryRun: false });
  expect(env.deleted).toEqual([]);
});

test("cleanup rechecks version tags before deleting an image promoted since listing", async () => {
  const env = fixture({
    inventory: { openjury: Array.from({ length: 6 }, (_, i) => version(i + 1, [`ci-${i + 1}`], i + 10)) },
    refreshed: version(6, ["ci-6", `sha-${sha}`]),
  });
  await cleanupRegistry({ ...env, dryRun: false });
  expect(env.deleted).toEqual([]);
});

for (const status of [403, 429, 500]) {
  test(`inventory error ${status} fails closed before deletion`, async () => {
    const env = fixture({ error: { list: status } });
    await expect(cleanupRegistry({ ...env, dryRun: false })).rejects.toThrow("inventory failed");
    expect(env.deleted).toEqual([]);
  });
}

test("a missing package is skipped", async () => {
  const env = fixture({ error: { list: 404 } });
  expect(await cleanupRegistry({ ...env, dryRun: false })).toEqual({ candidates: 0, deleted: 0 });
});

for (const operation of ["get", "remove"]) {
  test(`already-deleted versions are tolerated during ${operation}`, async () => {
    const env = fixture({
      inventory: { "openjury-ci": [version(1, [], 1), version(2, [])] },
      error: { [operation]: 404 },
    });
    expect((await cleanupRegistry({ ...env, dryRun: false })).deleted).toBe(0);
  });
}

test("deletion errors never trigger whole-package deletion", async () => {
  const env = fixture({
    inventory: { "openjury-ci": [version(1, [], 1), version(2, [])] },
    error: { remove: 400 },
  });
  await expect(cleanupRegistry({ ...env, dryRun: false })).rejects.toThrow("delete failed");
  expect(env.deleted).toEqual([]);
});

test("public registry retention stays hosted while private preview cleanup is an inactive template", () => {
  const scheduled = readFileSync(resolve(".github/workflows/registry-cleanup.yml"), "utf8");
  const closure = readFileSync(resolve("deploy/workflows/preview-cleanup.yml"), "utf8");
  expect(scheduled).toContain("schedule:");
  expect(scheduled).toContain("workflow_dispatch:");
  expect(scheduled).toContain("default: true");
  expect(scheduled).toContain("if: github.ref == 'refs/heads/main'");
  expect(scheduled).not.toMatch(/pull_request:|pull_request_target:/);
  expect(closure).not.toContain("PREVIEW_CD_ENABLED");
  expect(closure).toContain("ref: main");
  expect(closure).toContain("repository: ${{ vars.SOURCE_REPOSITORY }}");
  expect(closure).toContain("github.event.repository.private == true");
  expect(closure).not.toContain("packages: write");
  expect(closure).not.toMatch(/^\s+pull_request_target:/m);
  expect(scheduled).toContain("group: ghcr-retention");
  expect(scheduled).toContain("packages: write");
  expect(scheduled).not.toContain("self-hosted");
  for (const workflow of [scheduled, closure]) {
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("deletePackageFor");
  }
});
