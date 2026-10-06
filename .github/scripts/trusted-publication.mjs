const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;

export function validateSourceRun(run, workflow, repository) {
  if (workflow.path !== ".github/workflows/ci.yml" ||
      run.workflow_id !== workflow.id ||
      run.path !== workflow.path ||
      run.repository?.full_name !== repository ||
      run.head_repository?.full_name !== repository ||
      run.event !== "push" || run.head_branch !== "main" ||
      run.status !== "completed" || run.conclusion !== "success" ||
      !sha.test(run.head_sha || "") ||
      !Number.isSafeInteger(run.id) || run.id < 1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error("Not a successful same-repository main push from the trusted CI workflow");
  }
  return run;
}

export async function getTrustedPublication({ github, repository, runId }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository || "") ||
      !/^[1-9][0-9]*$/.test(String(runId))) {
    throw new Error("Invalid source repository or run ID");
  }
  const [owner, repo] = repository.split("/");
  const { data: workflow } = await github.rest.actions.getWorkflow({
    owner, repo, workflow_id: "ci.yml",
  });
  const { data: run } = await github.rest.actions.getWorkflowRun({
    owner, repo, run_id: Number(runId),
  });
  validateSourceRun(run, workflow, repository);
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner, repo, run_id: run.id, filter: "latest", per_page: 100,
  });
  if (!jobs.some((job) => job.name === "Publish tested main image" &&
      job.status === "completed" && job.conclusion === "success" &&
      job.run_attempt === run.run_attempt)) {
    throw new Error("Source run has no successful isolated publication job");
  }
  const name = `published-image-${run.id}-${run.run_attempt}`;
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner, repo, run_id: run.id, per_page: 100,
  });
  const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
  if (matches.length !== 1 || matches[0].workflow_run?.id !== run.id ||
      matches[0].workflow_run?.head_sha !== run.head_sha) {
    throw new Error("Missing or ambiguous publication artifact for this exact source run");
  }
  return { run, artifact: matches[0] };
}

export function validatePublication(publication, run, repository) {
  const prefix = `ghcr.io/${repository.toLowerCase()}@`;
  if (publication.repository !== repository ||
      publication.revision !== run.head_sha ||
      String(publication.runId) !== String(run.id) ||
      String(publication.runAttempt) !== String(run.run_attempt) ||
      !digest.test(publication.imageId || "") ||
      typeof publication.image !== "string" ||
      !publication.image.startsWith(prefix) ||
      !digest.test(publication.image.slice(prefix.length))) {
    throw new Error("Publication does not match the validated source run and image digest");
  }
  return publication;
}
