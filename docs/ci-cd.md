# CI/CD

[Project overview](../README.md) · [Automation](automation.md) · [Deployment](deployment.md)

## Delivery flow

```text
Every PR / merge queue → lint + typecheck + Docker build + browser E2E
                       → optional clean dev preview after successful CI
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

Main images are published as `ghcr.io/jupe/openjury:sha-<commit>`. Deployments use
the immutable `ghcr.io/jupe/openjury@sha256:...` reference recorded in the Release
summary. No PR has registry write credentials. Release verifies the source
revision and skips superseded main builds; deployment checks main again after
any approval wait. Releases are serialized across staging and production.
A failed staging deployment **or smoke test blocks production**.

## Enable merge protection first

In GitHub's ruleset/branch protection settings for `main`:

- Require a pull request, reviews, and the `checks` status check.
- Require branches to be up to date, or enable the merge queue (CI handles
  `merge_group` events).
- Prevent bypasses/direct pushes, and require review of workflow, Docker,
  deployment, and dependency changes by trusted maintainers.

Workflow files alone cannot enforce merge protection; these repository settings
must be applied by an administrator. No path filters skip CI.

See [automation](automation.md) for optional reviewed minor-PR merging and
deployment notifications, and [deployment](deployment.md) for infrastructure,
environment flags, cleanup, and recovery.
