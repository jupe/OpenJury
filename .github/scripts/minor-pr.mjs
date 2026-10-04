export const LABEL = "automerge:minor";

// Deliberately narrow: new features and other application code need manual merging.
const allowedPaths = new Set([
  "README.md",
  "app/globals.css",
  "components/Button.tsx",
  "components/Card.tsx",
  "components/Layout.tsx",
]);
const sensitiveCode = /\b(auth\w*|permission\w*|supabase|vot(e|es|ing)|token|secret|fetch|eval)\b|process\.env|dangerouslySetInnerHTML/i;

export function assessDiff(pr, files) {
  if (!files.length || files.length !== pr.changed_files || files.length > 5) {
    return "Incomplete diff or more than five changed files";
  }
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (!allowedPaths.has(file.filename) || file.status !== "modified" || file.previous_filename) {
      return "Changed paths or file operations require a maintainer";
    }
    if (!file.patch || !Number.isInteger(file.additions) || !Number.isInteger(file.deletions)) {
      return "Missing text diff";
    }
    const changed = file.patch.split("\n").filter((line) => /^[+-]/.test(line));
    if (
      changed.filter((line) => line.startsWith("+")).length !== file.additions ||
      changed.filter((line) => line.startsWith("-")).length !== file.deletions
    ) {
      return "Truncated diff";
    }
    if (file.filename !== "README.md" && changed.some((line) => sensitiveCode.test(line))) {
      return "Potentially sensitive application change";
    }
    additions += file.additions;
    deletions += file.deletions;
  }
  if (additions !== pr.additions || deletions !== pr.deletions) return "Inconsistent diff totals";
  if (additions + deletions === 0 || additions + deletions > 100) return "Not a small text change";
  return null;
}

export function hasRequiredProtection(protection) {
  const reviews = protection.required_pull_request_reviews;
  const bypass = reviews?.bypass_pull_request_allowances;
  return Boolean(
    protection.enforce_admins?.enabled &&
    protection.required_status_checks?.strict &&
    protection.required_status_checks.contexts?.includes("checks") &&
    reviews?.required_approving_review_count >= 1 &&
    reviews.dismiss_stale_reviews &&
    reviews.require_last_push_approval &&
    !bypass?.users?.length && !bypass?.teams?.length && !bypass?.apps?.length
  );
}

export function latestReviews(reviews) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    // A later comment does not erase an approval or a request for changes.
    if (review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(review.user.login, review);
    }
  }
  return [...latest.values()];
}

function candidate(pr, fullName) {
  return pr.state === "open" && !pr.draft && !pr.merged &&
    pr.base.ref === "main" && pr.base.repo.full_name === fullName &&
    pr.head.repo?.full_name === fullName &&
    pr.labels.some((label) => label.name === LABEL);
}

export async function evaluatePR(github, repo, pr) {
  if (!candidate(pr, `${repo.owner}/${repo.repo}`)) return "Not an opted-in, same-repository PR";
  if (pr.mergeable !== true || pr.mergeable_state !== "clean") return "GitHub merge requirements are not satisfied";
  const { data: protection } = await github.rest.repos.getBranchProtection({ ...repo, branch: "main" });
  if (!hasRequiredProtection(protection)) return "Required branch protections are missing";

  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...repo, pull_number: pr.number, per_page: 100,
  });
  const diffReason = assessDiff(pr, files);
  if (diffReason) return diffReason;

  const reviews = latestReviews(await github.paginate(github.rest.pulls.listReviews, {
    ...repo, pull_number: pr.number, per_page: 100,
  }));
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return "Review changes are outstanding";
  let approved = false;
  for (const review of reviews) {
    if (review.state !== "APPROVED" || review.commit_id !== pr.head.sha ||
        review.user.type !== "User" || review.user.login === pr.user.login) continue;
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo, username: review.user.login,
    });
    if (["write", "maintain", "admin"].includes(data.permission)) approved = true;
  }
  if (!approved) return "An independent maintainer must approve the current revision";

  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo, workflow_id: "ci.yml", event: "pull_request", head_sha: pr.head.sha, per_page: 100,
  });
  const latest = runs.filter((run) =>
    run.head_sha === pr.head.sha && run.head_repository?.full_name === `${repo.owner}/${repo.repo}` &&
    run.pull_requests?.some((pull) => pull.number === pr.number)
  ).sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
    return "The latest CI run for this PR revision has not succeeded";
  }
  return null;
}

export async function mergeMinorPRs({ github, context, core }) {
  const repo = context.repo;
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...repo, state: "open", base: "main", per_page: 100,
  });
  for (const pull of pulls.filter((pr) => pr.labels.some((label) => label.name === LABEL))) {
    try {
      const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: pull.number });
      const reason = await evaluatePR(github, repo, pr);
      if (reason) {
        core.info(`#${pr.number}: manual merge or waiting — ${reason}`);
        continue;
      }
      // Never leave pending auto-merge enabled: eligibility belongs to this exact diff.
      const { data: current } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
      if (!candidate(current, `${repo.owner}/${repo.repo}`) ||
          current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha ||
          current.mergeable !== true || current.mergeable_state !== "clean") {
        core.info(`#${pr.number}: changed during assessment; retry on the next run`);
        continue;
      }
      const { data } = await github.rest.pulls.merge({
        ...repo, pull_number: pr.number, sha: pr.head.sha, merge_method: "squash",
      });
      core.info(`#${pr.number}: ${data.merged ? "merged reviewed minor change" : "merge refused by GitHub"}`);
    } catch (error) {
      // Missing permissions, unavailable protections, and API errors all fail closed.
      core.warning(`#${pull.number}: no merge performed (${error.status ?? "API error"})`);
    }
  }
}
