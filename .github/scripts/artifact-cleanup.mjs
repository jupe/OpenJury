const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

function requireMetadata(condition, message) {
  if (!condition) throw new Error(`Cleanup stopped: ${message}`);
}

function oldEnough(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now - MIN_AGE_MS;
}

export async function cleanupLegacyArtifacts({ github, context, core, dryRun = true, now = Date.now() }) {
  requireMetadata(typeof dryRun === "boolean", "dryRun must be a boolean");
  requireMetadata(Number.isFinite(now), "invalid clock");
  requireMetadata(
    context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main",
    "only manual dispatches on main are allowed",
  );
  const repo = context.repo;
  const fullName = `${repo.owner}/${repo.repo}`.toLowerCase();
  const actions = github.rest.actions;
  const stats = { listed: 0, eligible: 0, eligibleBytes: 0, deleted: 0, reclaimedBytes: 0, missing: 0, skipped: 0, blocked: false };

  async function workflow(file) {
    const { data } = await actions.getWorkflow({ ...repo, workflow_id: file });
    requireMetadata(positiveId(data.id) && data.path === `.github/workflows/${file}`, `unverified ${file} workflow`);
    return data.id;
  }

  async function currentMain() {
    const { data } = await github.rest.repos.getBranch({ ...repo, branch: "main" });
    requireMetadata(SHA.test(data.commit?.sha), "missing main SHA");
    return data.commit.sha;
  }

  async function releaseIsActive(releaseId) {
    // workflow_run's head_sha may describe the workflow revision rather than the
    // triggering CI revision. Protect every artifact while any Release is open.
    // No status filter: include waiting approvals and future/unknown statuses.
    const runs = await github.paginate(actions.listWorkflowRuns, {
      ...repo, workflow_id: releaseId, per_page: 100,
    });
    requireMetadata(Array.isArray(runs), "invalid Release inventory");
    for (const run of runs) {
      requireMetadata(positiveId(run.id) && run.workflow_id === releaseId, "unverified Release run");
    }
    return runs.some((run) => run.status !== "completed");
  }

  async function eligible(artifact, ciId, mainSha) {
    const match = /^image-([1-9][0-9]*)$/.exec(artifact.name);
    if (!match || artifact.expired !== false) return false;
    const runId = Number(match[1]);
    if (!positiveId(artifact.id) || !positiveId(runId) ||
        artifact.workflow_run?.id !== runId ||
        !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 0 ||
        !oldEnough(artifact.created_at, now) || !oldEnough(artifact.updated_at, now)) return false;
    const { data: run } = await actions.getWorkflowRun({ ...repo, run_id: runId });
    requireMetadata(run.id === runId && positiveId(run.workflow_id), `unverified CI run ${runId}`);
    return run.workflow_id === ciId &&
      run.event === "push" && run.head_branch === "main" && run.status === "completed" &&
      run.repository?.full_name?.toLowerCase() === fullName &&
      run.head_repository?.full_name?.toLowerCase() === fullName &&
      positiveId(run.repository?.id) && run.head_repository?.id === run.repository.id &&
      artifact.workflow_run.repository_id === run.repository.id &&
      artifact.workflow_run.head_repository_id === run.repository.id &&
      artifact.workflow_run.head_branch === "main" &&
      artifact.workflow_run.head_sha === run.head_sha &&
      SHA.test(run.head_sha) && run.head_sha !== mainSha &&
      oldEnough(run.updated_at, now);
  }

  try {
    // Finish pagination before any deletion so removing a page cannot shift the
    // remaining artifacts out of the inventory.
    const artifacts = await github.paginate(actions.listArtifactsForRepo, { ...repo, per_page: 100 });
    requireMetadata(Array.isArray(artifacts), "invalid artifact inventory");
    stats.listed = artifacts.length;
    const ciId = await workflow("ci.yml");
    const releaseId = await workflow("release.yml");
    const mainSha = await currentMain();
    if (await releaseIsActive(releaseId)) {
      stats.blocked = true;
      stats.skipped = stats.listed;
      core.info("Skipped all artifacts: a Release run is not completed (including pending approvals).");
      return stats;
    }
    const candidates = [];
    const seen = new Set();
    for (const artifact of artifacts) {
      if (seen.has(artifact.id) || !await eligible(artifact, ciId, mainSha)) {
        stats.skipped++;
        continue;
      }
      seen.add(artifact.id);
      candidates.push(artifact);
      stats.eligible++;
      stats.eligibleBytes += artifact.size_in_bytes;
      core.info(`${dryRun ? "Would delete" : "Candidate"} artifact ${artifact.id} (${artifact.name}), ${artifact.size_in_bytes} bytes`);
    }
    if (dryRun) return stats;

    for (const artifact of candidates) {
      if (await releaseIsActive(releaseId)) {
        stats.blocked = true;
        core.info("Stopped deleting: a Release run became active.");
        break;
      }
      const latestMain = await currentMain();
      const { data: fresh } = await actions.getArtifact({ ...repo, artifact_id: artifact.id });
      requireMetadata(fresh.id === artifact.id && fresh.name === artifact.name, "artifact identity changed");
      if (!await eligible(fresh, ciId, latestMain)) {
        stats.skipped++;
        continue;
      }
      try {
        await actions.deleteArtifact({ ...repo, artifact_id: artifact.id });
      } catch (error) {
        // Only an already-deleted artifact is a safe race. Metadata failures,
        // permissions errors, and rate limits must stop the cleanup.
        if (error.status !== 404) throw error;
        stats.missing++;
        continue;
      }
      stats.deleted++;
      stats.reclaimedBytes += fresh.size_in_bytes;
      core.info(`Deleted artifact ${artifact.id} (${artifact.name})`);
    }
    return stats;
  } finally {
    await core.summary.addHeading("Legacy main-CI artifact cleanup")
      .addRaw(`Mode: ${dryRun ? "dry run (no deletions)" : "apply"}\n\n` +
        `Listed: ${stats.listed}; eligible: ${stats.eligible}; skipped: ${stats.skipped}; deleted: ${stats.deleted}; already absent: ${stats.missing}.\n\n` +
        `Eligible bytes: ${stats.eligibleBytes}; reclaimed bytes: ${stats.reclaimedBytes}.\n\n` +
        `Blocked by active Release: ${stats.blocked ? "yes" : "no"}. ` +
        "Reclaimed bytes count successful artifact deletions, not a billing adjustment. " +
        "Review the job result for metadata/API failures.\n")
      .write();
  }
}
