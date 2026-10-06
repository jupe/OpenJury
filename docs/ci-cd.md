# CI/CD

[Project overview](../README.md) · [Automation](automation.md) · [Deployment](deployment.md)

## Delivery flow

```text
PR / merge queue      → detect relevant changes
                      → lint + typecheck + Docker build + browser E2E if needed
                       → optional clean dev preview in the same CI run
PR closed or merged   → delete its dev preview, including volumes

main → same CI checks → publish the tested image to GHCR (no rebuild)
                     → optional staging deployment by image digest
                     → staging browser smoke tests through HTTPS ingress
                     → production approval (if configured)
                     → production deployment of the SAME digest + smoke tests
```

CI runs on GitHub-hosted runners, including fork PRs. It exercises the production
Docker image, not the Next.js development server. The stable required check is
`checks` in the `CI` workflow. Image artifacts expire after three days; browser
reports after seven. Actions are commit-pinned and Dependabot proposes updates.
The full Playwright suite runs in Chromium; Android and iPhone run `@smoke` and
`@mobile` tests. Four CI workers keep the browser stage under five minutes.
Production builds use Webpack because Turbopack currently breaks PGlite's WASM
initializer in the demo.

Documentation-only PRs and merge-queue entries skip the build/test job. The
documentation allowlist is root-level `*.md`, Markdown files under `docs/`, and
`LICENSE`; all other paths (including application code, dependencies, tests,
workflows, database migrations, and deployment configuration) run the full job.
Mixed changes and moves between code and documentation also run the full job.
Detection compares the event's base revision with the checked-out merge revision,
not just the latest commit, without a changed-file API limit.
The `checks` status still runs and succeeds for documentation-only changes; a
failed detector or required build fails it. Previews are skipped when CI produces
no tested image. Pushes to `main` still run full CI and publish a tested image.

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

Main images are published as `ghcr.io/jupe/openjury:sha-<commit>`. Deployments use
the immutable `ghcr.io/jupe/openjury@sha256:...` reference recorded in the Release
summary. Same-repository PRs may push only to the separate
`ghcr.io/jupe/openjury-preview` package (tagged `pr-<number>-<sha>`) so dev
previews pull just the changed layers; fork PRs get a read-only token and keep
using the image artifact. PR images are never written to the release package,
and their versions are deleted when the PR closes. Release verifies the source
revision and skips superseded main builds; deployment checks main again after
any approval wait. Releases are serialized across staging and production.
A failed staging deployment **or smoke test blocks production**.

The optional `PR preview` job is part of the PR's `CI` workflow, so deployment
progress and approval appear alongside its checks. It calls trusted preview
orchestration pinned to an immutable commit, downloads the tested image from that same run, and
records a `dev` deployment against the PR head SHA (not the synthetic merge
commit), with the preview URL. The PR-specific description keeps deployment
cleanup scoped to that preview without creating one GitHub environment per PR.
The required `checks` job remains independent
of preview approval. Fork PRs still build and test, but skip deployment because
their read-only token cannot register deployments and they cannot access dev
secrets. A maintainer can move reviewed changes to a same-repository branch to
preview them.

## Enable merge protection first

In GitHub's ruleset/branch protection settings for `main`:

- Require a pull request, reviews, and the `checks` status check.
- Require branches to be up to date, or enable the merge queue (CI handles
  `merge_group` events).
- Prevent bypasses/direct pushes, and require review of workflow, Docker,
  deployment, and dependency changes by trusted maintainers.

Workflow files alone cannot enforce merge protection; these repository settings
must be applied by an administrator. CI is not filtered at the workflow trigger,
so documentation-only changes do not leave the required check pending.

See [automation](automation.md) for optional reviewed minor-PR merging and
deployment notifications, and [deployment](deployment.md) for infrastructure,
environment flags, cleanup, and recovery.
