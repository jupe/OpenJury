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
`checks` in the `CI` workflow. PR image artifacts expire after three days; browser
reports after seven. Actions are commit-pinned and Dependabot proposes updates.
The full Playwright suite runs in Chromium; Android and iPhone run `@smoke` and
`@mobile` tests. Four CI workers keep the browser stage under five minutes.
Production builds use Webpack because Turbopack currently breaks PGlite's WASM
initializer in the demo. On PRs, artifact uploads are best-effort when the
repository reaches GitHub's storage quota; this skips the optional preview if
its image artifact is unavailable. Main pushes publish the tested image directly
to GHCR after all tests pass; release promotion does not use Actions artifact
storage. Registry publication remains required, while browser report uploads
(including deployment smoke reports) are best-effort.

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

Main CI publishes `ghcr.io/jupe/openjury:ci-<run-id>` and signs its digest with
Cosign after tests and required checks pass. Signing runs in a separate
GitHub-hosted job with no checkout or application execution, using a key from the
main-only `release-signing` environment. The run tag remains usable when a
partial CI retry reuses the successful build job. Release pulls
that successful run's image, resolves its digest, verifies its source revision
and signature against an independently configured public key, requiring signed
annotations for this repository, CI workflow, `main` ref, tested commit and CI run ID,
and tags it as `ghcr.io/jupe/openjury:sha-<commit>` without rebuilding. Deployments use
the immutable `ghcr.io/jupe/openjury@sha256:...` reference recorded in the Release
summary. Same-repository PRs may push only to the separate
`ghcr.io/jupe/openjury-preview` package (tagged `pr-<number>-<sha>`) so dev
previews pull just the changed layers; fork PRs get a read-only token and keep
using the image artifact. PR images are never written to the release package,
and their versions are deleted when the PR closes. Release verifies the source
revision and skips superseded main builds; deployment checks main again after
any approval wait. Releases are serialized across staging and production.
A failed staging deployment **or smoke test blocks production**.
Missing or invalid provenance also blocks promotion: a registry tag or revision
label alone is not trusted, since PR workflows have registry write permission.
Cosign signatures are stored alongside the image in GHCR, not in Actions artifacts
or GitHub's attestation service (which is unavailable for user-owned private
repositories). Signing explicitly disables public transparency-log uploads to
avoid disclosing private image metadata. Verification skips only the transparency
log requirement, not signature, digest or annotation checks.
CI also exercises the configured, signed-out navigation path on desktop and both
mobile browsers using mocked public configuration, even when the test container
otherwise runs in demo mode.

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

### Configure private release signing

Before merging this workflow change, a repository administrator must:

1. Create the `release-signing` environment. Under **Deployment branches and
   tags**, select only the `main` branch, with no tag rule or wildcard. Do not
   rely on the job's `if` alone: a PR can change its own workflow.
2. On a trusted administrator machine, use Cosign v3.1.3's
   `cosign generate-key-pair` with a strong, nonempty password. Store the generated
   `cosign.key` PEM as the environment secret `COSIGN_PRIVATE_KEY` and its password
   as the environment secret `COSIGN_PASSWORD`. Do **not** create these as
   repository secrets or make them available to PR jobs. Keep a secure backup;
   never commit the private key or password.
3. Store the contents of `cosign.pub` as the repository Actions variable
   `COSIGN_PUBLIC_KEY`. Do not source the trusted key from the image or its
   signature. Do not override this variable in individual environments.
4. Preserve reviewed, protected changes to `main`, especially workflow changes.
   Anyone able to run arbitrary workflows on an allowed signing-environment ref
   can use the signing key. Environment availability and branch restrictions
   depend on the repository's GitHub plan; do not replace missing restrictions
   with an unprotected repository secret.

No OIDC permission, GitHub attestation entitlement, public repository, or public
transparency log is needed. Missing keys, a mismatched public key, failed signing,
and failed verification remain blocking. After setup and merge, the new main CI
run signs its tested image and triggers Release; rerunning an old commit still
uses that commit's old workflow. A partial retry of a failed signing job can reuse
the successful build's digest. For key rotation, update both secrets and the
trusted public key, then rerun current-main CI before promotion.

Retain Cosign's OCI signature referrers with their subject images for retries.
Do not bulk-delete untagged GHCR versions: those may contain required signatures.
This signing change does not sign PR preview images or change preview cleanup.

### Recover Actions artifact storage

The **Legacy main-CI artifact cleanup** workflow is manual and defaults to a dry
run. After merging, run it on `main`, review its summary, and run again with
`dry_run` disabled to delete eligible archives. It only targets `image-<run-id>`
artifacts from completed, superseded main-push CI runs at least 24 hours old.
It skips all cleanup while any Release is unfinished (including approvals).
It preserves current-main artifacts,
PR artifacts, image references, browser reports, and all GHCR images/signatures.
The dry-run summary reports the eligible bytes; it does not free storage.

GitHub's quota error reports usage recalculation every 6–12 hours, so deleting
artifacts may not unblock uploads immediately. Existing archives still consume
space until deleted or expired. For more capacity instead of deletion, an account
owner can review payment settings and the Actions storage spending budget; this
workflow does not change billing. Main release promotion remains independent of
Actions artifact storage, and diagnostic-report upload failures remain nonblocking.

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
