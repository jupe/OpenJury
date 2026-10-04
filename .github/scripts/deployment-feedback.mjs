async function closingIssues(github, repo, number) {
  const issues = [];
  let after = null;
  do {
    const result = await github.graphql(`
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 100, after: $after) {
              nodes { number author { login } repository { nameWithOwner } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`, { ...repo, number, after });
    const connection = result.repository.pullRequest.closingIssuesReferences;
    issues.push(...connection.nodes.filter((issue) =>
      issue.repository.nameWithOwner === `${repo.owner}/${repo.repo}`
    ));
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !after) throw new Error("Incomplete linked issue pagination");
  } while (after);
  return issues;
}

export async function notifyDeployment({ github, context, core, revision, productionResult }) {
  if (productionResult !== "success") return;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid deployed revision");
  const repo = context.repo;
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...repo, state: "closed", base: "main", sort: "updated", direction: "desc", per_page: 100,
  });
  // Scan merged PRs, not just the tip commit: superseded CI runs may never deploy.
  for (const pr of pulls.filter((pull) => pull.merged_at && pull.merge_commit_sha)) {
    const issues = await closingIssues(github, repo, pr.number);
    if (!issues.length) continue;
    let comparison;
    try {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        ...repo, basehead: `${pr.merge_commit_sha}...${revision}`, per_page: 1,
      });
      comparison = data;
    } catch (error) {
      if (error.status === 404) continue; // History rewritten or no common ancestor.
      throw error;
    }
    if (!["ahead", "identical"].includes(comparison.status)) continue;
    const marker = `<!-- openjury:production:pr:${pr.number} -->`;
    for (const issue of issues) {
      const comments = await github.paginate(github.rest.issues.listComments, {
        ...repo, issue_number: issue.number, per_page: 100,
      });
      if (comments.some((comment) =>
        comment.user?.login === "github-actions[bot]" && comment.user.type === "Bot" &&
        comment.body?.includes(marker)
      )) continue;
      const author = issue.author?.login;
      const mention = author && /^[a-z\d][a-z\d-]{0,38}$/i.test(author) ? `@${author} ` : "";
      await github.rest.issues.createComment({
        ...repo, issue_number: issue.number,
        body: `${marker}\n${mention}PR #${pr.number} is included in production revision \`${revision}\`.\n\n` +
          `Production deployment and smoke tests passed: ${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}\n\n` +
          "Please confirm whether this resolves your feedback. If not, reply here so a maintainer can reopen or follow up.",
      });
      core.info(`Notified #${issue.number} about deployed PR #${pr.number}`);
    }
  }
}
