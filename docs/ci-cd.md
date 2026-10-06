# CI/CD

[Project overview](../README.md) · [Automation](automation.md) · [Deployment](deployment.md)

## Delivery flow

```text
PR / merge queue      → detect relevant changes
                      → lint + typecheck + real database policies
                      → Docker build + browser E2E if needed (read-only token)

main → same CI checks → tested-image artifact → isolated hosted publication
                     → GHCR immutable digest → hosted Release promotion

private controller   → validate successful source main CI and immutable digest
                     → staging + smoke tests → production approval + deployment
```

CI runs on GitHub-hosted runners, including fork PRs. It exercises the production
Docker image, not the Next.js development server. The stable required check is
`checks` in the `CI` workflow. Main tested-image archives expire after three days,
publication records after 30 days, and browser reports after seven.
Actions are commit-pinned and Dependabot proposes updates.
The full Playwright suite runs in Chromium; Android and iPhone run `@smoke` and
`@mobile` tests. Four CI workers keep the browser stage under five minutes.
Production builds use Webpack because Turbopack currently breaks PGlite's WASM
initializer in the demo. Browser-report uploads are best-effort when the
repository reaches GitHub's storage quota. Main's tested-image artifact and
published digest handoff are required:
publication fails closed if either is unavailable. Build/test jobs have only a
read-only token; an isolated main-only hosted job publishes without executing the
image or loading repository dependencies. Registry publication remains required, while browser report uploads
(including deployment smoke reports) are best-effort.

Documentation-only PRs and merge-queue entries skip the build/test job. The
documentation allowlist is root-level `*.md`, Markdown files under `docs/`, and
`LICENSE`; all other paths (including application code, dependencies, tests,
workflows, database migrations, and deployment configuration) run the full job.
Mixed changes and moves between code and documentation also run the full job.
Detection compares the event's base revision with the checked-out merge revision,
not just the latest commit, without a changed-file API limit.
The `checks` status still runs and succeeds for documentation-only changes; a
failed detector or required build fails it. No previews run in source CI. Pushes to `main` still run full CI and publish a tested image.

## Prebuilt CI environment

`Prebuild CI images` publishes two targets from `Dockerfile.ci` to
`ghcr.io/jupe/openjury-ci`: `tools-<input-hash>` contains Node, the npm version
from `package.json`, locked application dependencies, Chromium, WebKit and their
OS libraries, ShellCheck, and Ansible; `dependencies-<input-hash>` contains the
Alpine dependencies used to build the production image. The separate dependency
target preserves compatibility with the Alpine production runtime.

Images rebuild on `main` when their inputs change, weekly to refresh base images
and OS packages, or through manual dispatch on `main`. Only that trusted workflow
publishes the cache; PR jobs never publish CI images. The key covers `.nvmrc`,
both npm manifests, the Ansible requirements, the image recipe and its dedicated
Docker ignore file, and the preparation action. No application source or secrets
are baked into these images.

After the first publication, **make the `openjury-ci` GHCR package public** so
fork PRs and read-only CI jobs can pull it without registry credentials. Run the
workflow manually after merging to warm the cache. CI and deployment smoke tests
pull matching inputs and run tools in disposable containers on GitHub-hosted
runners. They use the locally resolved image ID throughout each job; browser
containers use host networking to reach the production container's loopback port.
Dependencies are linked into the workspace only inside these tooling containers.
Private-controller smoke jobs set the preparation action's `repository` input to
`SOURCE_REPOSITORY`, so they reuse the source's public tooling cache instead of
looking for images belonging to the private deployment repository.
Normal cache hits require no Node, npm, application dependency, browser, OS
package, or Ansible installation.

A new dependency PR, first run, missing/private package, or registry outage falls
back to building the exact images locally; it never uses stale dependencies or
needs a write token. Only cache misses incur installation. Changing application
source alone reuses both images. Image pulls still transfer uncached layers on
fresh hosted runners.

The production Dockerfile accepts `DEPENDENCIES_IMAGE` so CI reuses the prebuilt
Alpine dependencies without another `npm ci`. A normal local `docker build .`
still installs from the lockfile itself. Neither path changes the runtime image
or release promotion of the tested image.

## Image promotion and previews

An isolated main-only publication job publishes
`ghcr.io/jupe/openjury:ci-<run-id>-<attempt>` after tests and `checks` pass. PR jobs never
publish packages, even for same-repository branches. Release accepts only a
validated successful same-repository `main` push from the expected CI workflow,
uses its published digest handoff, verifies the revision label, and tags the same
digest as `ghcr.io/jupe/openjury:sha-<commit>` without rebuilding. A mutable run
tag is not the deployment authority. Superseded main builds are rejected.
Publication records are attempt-scoped: rerun **all CI jobs** when an archive or
record has expired or a partial retry did not rerun publication. Promotion refuses
to reuse a publication from a different run attempt.

The public repository does not deploy to VMs. The private controller must validate
the source run/digest and recheck `main` after approval; a failed staging deployment
or smoke test must block production. See [deployment](deployment.md) for migration.
The controller also verifies the promoted `sha-<revision>` manifest matches the
validated digest before deployment, preventing deployment of an unpromoted image
that CI retention could later delete.
Cryptographic artifact attestations are not yet configured. Public-repository
operators can add trusted build attestations and verification after checking
GitHub feature availability and ensuring the attesting publisher has the exact
tested digest; do not mistake a revision label alone for cryptographic provenance.
CI also exercises the configured, signed-out navigation path on desktop and both
mobile browsers using mocked public configuration, even when the test container
otherwise runs in demo mode.

There is no reusable self-hosted workflow call from source CI. Optional manual
trusted-main previews associated with same-repository PRs and cleanup live in
private-controller templates under `deploy/workflows/`. These previews do not run
PR changes. Fork PRs build/test only and remain ineligible for deployment.
The required `checks` job is independent of any private-controller approval.

## Automatic GHCR retention

`GHCR retention` runs daily at 03:41 UTC from `main`. Maintainers can also run it
on `main` using **Actions → GHCR retention → Run workflow**; manual runs default
to **dry run**, listing candidates without deleting anything. Disable that input
to reclaim space immediately according to the same retention policy.

| Package | Automatically removed | Always retained |
| --- | --- | --- |
| `openjury-ci` | Recognized old cache versions and untagged versions, after seven days without an update | Two newest versions of each target (`tools` and `dependencies`), recent versions, and unfamiliar tags |
| `openjury-preview` | Versions older than three days whose **every** tag belongs to a closed PR | All open-PR images, recent versions, untagged versions, and unfamiliar tags |
| `openjury` | Versions tagged **only** `ci-<run-id>` or `ci-<run-id>-<attempt>`, after seven days without an update | Five newest CI versions, every promoted `sha-<commit>` release, recent versions, untagged versions, and unfamiliar tags |

The daily sweep still handles legacy preview images created before migration.
Source CI no longer publishes new preview packages or schedules VM teardown on
PR closure. Cleanup of running previews belongs to the private controller.

Cleanup deletes **versions**, not individual tags: a digest shared by an open PR
or a release tag is protected. It paginates inventory, rechecks version metadata
and PR state before deletion, serializes cleanup runs, and never deletes entire
packages. At least the newest version of each package is retained, including when
all PRs are closed, to preserve package permissions/visibility and avoid GHCR's
last-version restriction. Permission/API errors fail the workflow rather than
triggering broader deletion.

The workflow uses `GITHUB_TOKEN` with `packages: write`; each package must grant
this repository Actions access with **admin** permission for version deletion.
Check the package's **Settings → Manage Actions access** if cleanup returns 403.
Missing/inaccessible packages (404) are logged and skipped. No PAT is needed.
GitHub may refuse deletion of heavily downloaded public versions; those require
maintainer intervention. Registry storage accounting may lag behind deletion.

Promoted release digests are intentionally **not age-pruned**: hosts deploy and
roll back by digest, and manual rollbacks are not tracked centrally. Age alone
cannot establish that a release is unused. This preserves existing deployment
and rollback behavior; release-history pruning requires an authoritative inventory
of deployed and rollback digests first.
Expired unpromoted CI images cannot be used for old Release retries; rerun full CI
on current `main` instead. Removed CI caches rebuild locally on demand using the
exact dependency inputs, so old branches and fork builds continue working.
Cache publication currently uses single-platform `docker build` images; before
switching to multi-platform indexes, extend retention to protect their untagged
child manifests.

## Enable merge protection first

In GitHub's ruleset/branch protection settings for `main`:

- Require a pull request, current-revision maintainer/code-owner reviews, dismiss
  stale approvals, and require the `checks` status check.
- Require branches to be up to date, or enable the merge queue (CI handles
  `merge_group` events).
- Prevent bypasses/direct pushes, and require review of workflow, Docker,
  deployment, and dependency changes by trusted maintainers. Enable code-owner
  review for `.github/CODEOWNERS`; that file alone does not enforce protection.

Set Actions' default token to read-only, require approval for all outside
contributors' workflows, and do not send secrets or write tokens to forks.
Remove all source-repository self-hosted runner access, including inherited runner
groups. Environment reviewers and labels cannot restrict runner scheduling.

Workflow files alone cannot enforce merge protection; these repository settings
must be applied by an administrator. CI is not filtered at the workflow trigger,
so documentation-only changes do not leave the required check pending.

See [automation](automation.md) for optional reviewed minor-PR merging and
deployment notifications, and [deployment](deployment.md) for infrastructure,
environment flags, cleanup, and recovery.
