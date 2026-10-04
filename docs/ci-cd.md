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
records a `dev-pr-<number>` deployment against the PR head SHA (not the synthetic
merge commit), with the preview URL. The required `checks` job remains independent
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
