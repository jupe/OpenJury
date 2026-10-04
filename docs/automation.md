# PR automation and deployment notifications

[Project overview](../README.md) · [CI/CD](ci-cd.md) · [Deployment](deployment.md)

File paths below are relative to the repository root.

## Opt-in minor PR automation

`Merge reviewed minor PRs` assesses the **actual current diff**, not the issue
description or a `bug` label. It runs after CI, twice hourly (to pick up later
reviews/label changes), and through manual workflow dispatch on `main`.
It is disabled until `MINOR_PR_AUTOMERGE_ENABLED=true`.

A maintainer applies the `automerge:minor` label to request assessment and
independently approves the latest revision after verifying that the change is
low risk. The author cannot approve their own PR; bot or read-only-user approvals
do not qualify. This is automatic **merging after human review**, not automatic
approval by the implementation agent.

The initial conservative policy permits only modifications to `README.md`,
`app/globals.css`, and the shared `Button.tsx`, `Card.tsx`, and `Layout.tsx`
components in `components/`. It allows at most five files and 100 total
added/deleted lines, requires complete text patches, and rejects file
creation/deletion/renaming. A sensitive-code heuristic also blocks suspicious
component/CSS edits. These checks are not semantic proof: the reviewer must
confirm no security or business-logic changes are hidden in an allowed file.
Authentication, permissions, voting integrity, database migrations, dependencies,
workflows, deployment configuration, and all other unclassified paths require
manual merging, even for one-line fixes. Larger PRs also remain manual.

Before enabling:

1. Configure **classic branch protection** for `main`: require `checks`, require
   the branch to be up to date, require at least one approving review, dismiss
   stale reviews, require approval of the most recent reviewable push, enforce
   protections for administrators, and leave review bypass allowances empty.
   The automation explicitly verifies these settings and fails closed for
   rulesets-only or merge-queue-only configurations; those PRs can still use the
   normal maintainer/queue process. Keep any additional rulesets enforced.
2. Create a dedicated GitHub App installed **only on this repository**, granting
   Contents and Pull requests write, Actions read, and Administration read
   (needed to verify branch protection). Do not grant it bypass privileges or
   permission to modify workflows. Enable squash merging in repository settings.
3. Create the `minor-pr-automation` environment and restrict its deployment
   branches to **only `main`**, with no allowed tags. Store
   `MINOR_PR_APP_PRIVATE_KEY` as an **environment secret**, never a repository
   secret accessible to PR workflows. Set environment variable
   `MINOR_PR_APP_CLIENT_ID` to the App client ID. Required environment reviewers
   can be retained if each automation run should also need approval.
4. Set repository variable `MINOR_PR_AUTOMERGE_ENABLED=true`, create the
   `automerge:minor` label, and apply it to a reviewed candidate.

The workflow executes trusted `main` code only, never PR code or dependencies,
and uses a short-lived repository-scoped App token so its merge triggers normal
push CI and Release workflows (`GITHUB_TOKEN` merges would suppress those
events). It requires successful latest PR CI, no outstanding change requests,
and GitHub's clean merge state. It rechecks the head/base and label, then performs
a SHA-pinned squash merge subject to GitHub protections. It never leaves GitHub
auto-merge armed for future, unassessed revisions. Fork PRs remain manual.
Assessment failures/waiting reasons appear in the workflow log. Remove the
label to withdraw a request or disable the variable to stop future runs;
cancel an already-running workflow as well for an immediate stop.

## Feedback deployment notifications

Set repository variable `DEPLOYMENT_NOTIFICATIONS_ENABLED=true` to notify
reporters on same-repository issues linked through a PR's closing references
(for example, `Fixes #123`). Notifications are GitHub issue comments mentioning
the reporter, **not in-app notifications**: this scaffold does not yet have
authenticated feedback conversations or an app/GitHub identity mapping.

Notifications run only after production deployment **and production smoke tests**
succeed. A merge, skipped deployment, failed staging, or failed production smoke
test does not generate a success notification. `CD_ENABLED`, environment
approvals, and tested-image promotion are unchanged; minor PR automation does
not enable CD or bypass approvals.

The notifier verifies that each merged PR's merge commit is contained in the
deployed revision. It includes earlier PRs whose own CI/release was superseded,
not just the tip PR. Bot-authored per-PR markers deduplicate issue comments on
retries and later releases. On first enablement, it also catches up historical
merged PRs with linked issues contained in the deployment. Only same-repository
issues are contacted; cross-repository references are ignored. Notification
delivery failures fail the notification job without rolling back production;
rerun failed jobs to retry. A reply that the fix did not work is left for
maintainer triage; no automatic reopen or new implementation is triggered.
