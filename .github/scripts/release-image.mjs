const workflowPath = ".github/workflows/ci.yml";
const markerPattern = /^release-image-v1 (sha256:[a-f0-9]{64})$/;

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateRun(run, repository) {
  if (!run || !positiveInteger(run.id) || !positiveInteger(run.run_attempt) ||
      typeof run.head_sha !== "string" || run.head_sha.length !== 40 ||
      !/^[a-f0-9]{40}$/.test(run.head_sha) || run.path !== workflowPath ||
      run.head_branch !== "main" || run.event !== "push" ||
      run.status !== "completed" || run.conclusion !== "success" ||
      run.repository?.full_name !== repository ||
      run.head_repository?.full_name !== repository) {
    throw new Error("Invalid originating CI run");
  }
}

function latestJob(jobs, matches, description) {
  const candidates = jobs.filter(matches);
  const attempt = Math.max(...candidates.map((job) => job.run_attempt));
  const latest = candidates.filter((job) => job.run_attempt === attempt);
  if (latest.length !== 1 || latest[0].status !== "completed" ||
      latest[0].conclusion !== "success") {
    throw new Error(`Missing, duplicate, or unsuccessful ${description}`);
  }
  return latest[0];
}

export async function releaseImage({ github, context }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const trigger = context.payload.workflow_run;
  validateRun(trigger, repository);
  // An old completion event must not adopt a newer retry's status or digest.
  const { data: run } = await github.rest.actions.getWorkflowRunAttempt({
    ...context.repo, run_id: trigger.id, attempt_number: trigger.run_attempt,
  });
  validateRun(run, repository);
  if (run.id !== trigger.id || run.head_sha !== trigger.head_sha ||
      run.run_attempt !== trigger.run_attempt) {
    throw new Error("Originating CI run does not match its completion event");
  }
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: run.id, filter: "all", per_page: 100,
  });
  const ids = new Set();
  for (const job of jobs) {
    if (!positiveInteger(job.id) || ids.has(job.id) ||
        job.run_id !== run.id || job.head_sha !== run.head_sha ||
        !positiveInteger(job.run_attempt) || typeof job.name !== "string") {
      throw new Error("Invalid originating CI job metadata");
    }
    ids.add(job.id);
  }
  const eligible = jobs.filter((job) => job.run_attempt <= trigger.run_attempt);
  const marker = latestJob(eligible, (job) => job.name.startsWith("release-image"), "image marker");
  const match = markerPattern.exec(marker.name);
  if (!match || match[0] !== marker.name) throw new Error("Malformed image marker");
  const digest = match[1];
  const build = latestJob(eligible, (job) => job.name === "Build and test", "build");
  latestJob(eligible, (job) => job.name === "checks", "checks");
  const buildFinished = Date.parse(build.completed_at);
  const markerStarted = Date.parse(marker.started_at);
  if (marker.run_attempt < build.run_attempt ||
      !Number.isFinite(buildFinished) || !Number.isFinite(markerStarted) ||
      markerStarted < buildFinished) {
    throw new Error("Image marker predates the latest build");
  }
  return `ghcr.io/${repository.toLowerCase()}@${digest}`;
}
