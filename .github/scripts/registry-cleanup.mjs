const DAY = 24 * 60 * 60 * 1000;
const CI_TAG = /^ci-[1-9][0-9]*(?:-[1-9][0-9]*)?$/;
const CACHE_TAG = /^(tools|dependencies)-[a-f0-9]{64}$/;
const PREVIEW_TAG = /^pr-([1-9][0-9]*)-[a-f0-9]{40}$/;

function tags(version) {
  return version.metadata?.container?.tags;
}

function timestamp(version) {
  return Math.max(Date.parse(version.created_at), Date.parse(version.updated_at));
}

export function cleanupCandidates({ kind, versions, closedPRs = new Set(), now = Date.now() }) {
  const newest = [...versions].sort((a, b) => timestamp(b) - timestamp(a));
  // Never delete a package's last version or fall back to deleting the package.
  const keep = new Set(newest.slice(0, 1).map((version) => version.id));
  if (kind === "release") {
    newest.filter((version) => tags(version)?.some((tag) => CI_TAG.test(tag)))
      .slice(0, 5).forEach((version) => keep.add(version.id));
  } else if (kind === "cache") {
    for (const target of ["tools", "dependencies"]) {
      newest.filter((version) => tags(version)?.some((tag) =>
        CACHE_TAG.test(tag) && tag.startsWith(`${target}-`)))
        .slice(0, 2).forEach((version) => keep.add(version.id));
    }
  } else if (kind !== "preview") {
    throw new Error("Unknown registry retention policy");
  }
  return newest.filter((version) => {
    const names = tags(version);
    if (keep.has(version.id) || !Array.isArray(names) ||
        !(timestamp(version) < now - (kind === "preview" ? 3 : 7) * DAY)) return false;
    if (kind === "release") {
      // A version can have both ci-* and sha-* tags. Deletion removes ALL tags.
      return names.length > 0 && names.every((tag) => CI_TAG.test(tag));
    }
    if (kind === "cache") return names.every((tag) => CACHE_TAG.test(tag));
    // Untagged or unfamiliar preview versions cannot be attributed to a closed PR.
    return names.length > 0 && names.every((tag) => {
      const match = PREVIEW_TAG.exec(tag);
      return match && closedPRs.has(Number(match[1]));
    });
  });
}

export async function cleanupRegistry({
  github, context, core, dryRun = true, previewOnly = false, now = Date.now(),
}) {
  const org = context.payload.repository.owner.type === "Organization";
  const scope = org ? { org: context.repo.owner } : { username: context.repo.owner };
  const api = github.rest.packages;
  const list = org ? api.getAllPackageVersionsForPackageOwnedByOrg : api.getAllPackageVersionsForPackageOwnedByUser;
  const get = org ? api.getPackageVersionForOrganization : api.getPackageVersionForUser;
  const remove = org ? api.deletePackageVersionForOrg : api.deletePackageVersionForUser;
  const plans = [];
  // Complete all inventory/permission checks before the first destructive request.
  for (const [kind, suffix] of previewOnly
    ? [["preview", "-preview"]]
    : [["release", ""], ["cache", "-ci"], ["preview", "-preview"]]) {
    const pkg = { ...scope, package_type: "container", package_name: `${context.repo.repo.toLowerCase()}${suffix}` };
    let versions;
    try {
      versions = await github.paginate(list, { ...pkg, per_page: 100 });
    } catch (error) {
      if (error.status !== 404) throw error;
      core.info(`${pkg.package_name}: no accessible package; skipping.`);
      continue;
    }
    const closedPRs = new Set();
    if (kind === "preview") {
      const numbers = new Set(versions.flatMap((version) => (tags(version) || [])
        .map((tag) => PREVIEW_TAG.exec(tag)?.[1]).filter(Boolean)));
      for (const number of numbers) {
        const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(number) });
        if (pr.state === "closed") closedPRs.add(Number(number));
      }
    }
    plans.push({ kind, pkg, versions, closedPRs });
  }
  let deleted = 0;
  let candidates = 0;
  for (const plan of plans) {
    for (const version of cleanupCandidates({ ...plan, now })) {
      candidates++;
      const params = { ...plan.pkg, package_version_id: version.id };
      // Recheck tags/timestamps: promotion or a cache refresh may have happened since listing.
      let current;
      try {
        ({ data: current } = await get(params));
      } catch (error) {
        if (error.status === 404) continue;
        throw error;
      }
      const closedPRs = new Set(plan.closedPRs);
      if (plan.kind === "preview") {
        for (const tag of tags(current) || []) {
          const match = PREVIEW_TAG.exec(tag);
          if (!match) continue;
          const number = Number(match[1]);
          const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
          if (pr.state !== "closed") closedPRs.delete(number);
        }
      }
      const versions = plan.versions.map((item) => item.id === current.id ? current : item);
      if (!cleanupCandidates({ ...plan, versions, closedPRs, now }).some((item) => item.id === current.id)) continue;
      core.info(`${dryRun ? "Would delete" : "Deleting"} ${plan.pkg.package_name} version ${current.id} (${tags(current).join(", ") || "untagged"})`);
      if (!dryRun) {
        try {
          await remove(params);
          deleted++;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
    }
  }
  core.info(`Registry cleanup: ${candidates} candidate(s), ${deleted} deleted; dry-run=${dryRun}.`);
  return { candidates, deleted };
}
