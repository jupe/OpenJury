# Deployment and operations

[Project overview](../README.md) · [CI/CD](ci-cd.md) · [Automation](automation.md) · [Proxmox VM setup](proxmox.md) · [Security](security.md)

Run commands from the repository root; file paths below are relative to that
root unless explicitly stated otherwise.

## Docker and runtime configuration

```sh
docker build -t openjury:local .
docker run --rm -p 3000:3000 openjury:local
```

The image runs as non-root and includes `/api/health`. `.env` files and build
credentials are excluded from the Docker context. Configure **runtime**
`SUPABASE_URL` and `SUPABASE_ANON_KEY` when starting a persistent deployment.
Only these public client values are served by `/runtime-config.js`, with caching
disabled. Never supply a service-role key. This allows staging and production
to use different Supabase projects without rebuilding the image. The original
`NEXT_PUBLIC_*` variables remain available for local development.

The frontend uses browser sessions and group data in Supabase. **Each dev
preview gets its own disposable Supabase backend** (`deploy/compose.supabase.yml`:
Postgres, Auth, PostgREST, Realtime, and Storage) with secrets generated per
deployment. The PR's own `supabase/migrations` are applied to it, and its API is
served on the preview host under `/auth/v1`, `/rest/v1`, `/realtime/v1`, and
`/storage/v1`. Every revision starts empty, and closing the PR deletes the
database and storage volumes. It needs about 0.5 GB RAM per preview. Magic-link
emails go to the dev VM's shared Mailpit (`http://mail.<DEV_BASE_DOMAIN>`), and
previews also offer password sign-in for an optional seeded account
(`PREVIEW_ADMIN_EMAIL`, default `admin@openjury.test`, and the
`PREVIEW_ADMIN_PASSWORD` secret). Staging and production never enable password
sign-in. Never point dev at staging or production. Persistent Supabase projects, backups, and
schema migrations are managed separately; this frontend deployment does not
reset or migrate them. Preserve deny-by-default access for competition data.

## Supplemental Vercel hosting

Vercel is an optional additional frontend host; it does not replace the existing
Docker image promotion or self-hosted deployment workflows.

Import this repository into Vercel with the Next.js preset. Use the repository
root and the existing `npm run build` command. Ensure the Vercel build/runtime
supports the Node.js and npm versions required by `package.json`; if it does
not, retain Docker hosting until supported rather than silently changing the
project's toolchain.

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` for each trusted Vercel environment.
These are public client values delivered through the uncached
`/runtime-config.js` endpoint; never set a service-role key. Apply both database
migrations separately and configure Supabase Auth Site URL and exact
`https://<host>/dashboard` redirect allowlist entries for each trusted domain.
See [local development](development.md#2-configure-supabase).

Keep untrusted previews unconfigured, or give each an isolated disposable
Supabase backend. Do not share production data or production Auth redirect
permissions with PR previews. Vercel deployments build independently and do
not inherit Docker's tested-image promotion guarantee; protect production
deployment with the repository's CI checks and Vercel deployment controls.

## Prepare self-hosted infrastructure

For Proxmox VE, use the provisioning and guest playbooks described in
[Proxmox VM setup](proxmox.md).

CD is **off by default**: unset flags skip self-hosted jobs rather than queueing
them while runners are absent. Image publication from main stays enabled.

Provision separate Linux x64 Docker hosts/runners with these custom labels:

| Environment | Runner label | Compose project |
| --- | --- | --- |
| Dev previews | `openjury-dev` | `openjury-pr-<number>` |
| Staging | `openjury-staging` | `openjury-staging` |
| Production | `openjury-production` | `openjury-production` |

Each also needs the standard `self-hosted`, `linux`, `x64` labels, a current
GitHub Actions runner supporting Node 24 actions, Git, Bash, curl, and Docker Engine
with Compose v2 supporting `up --wait`. Use one deployment host per label:
jobs with that label must reach the **same Docker daemon**, including cleanup.
Never register multiple unrelated Docker hosts under one environment's label.

On each host, provision:

- A Traefik HTTPS reverse proxy with Docker discovery, a `websecure` entrypoint,
  and a certificate resolver (default `letsencrypt`). Set
  `exposedByDefault=false`; do not expose its dashboard publicly.
- An external Docker network named `openjury-proxy` (or override
  `PROXY_NETWORK`), with Traefik attached. The app has no published host ports
  and no Docker socket/host mounts; the deployment runner needs Docker access.
- DNS and valid TLS for staging/production and wildcard dev hostnames such as
  `*.dev.example.com`. Configure DNS-01/wildcard certificates or an appropriate
  certificate strategy to avoid per-PR ACME rate limits.
- Public HTTPS reachability from GitHub-hosted runners for smoke tests, and
  outbound access to GitHub artifacts/GHCR from deployment hosts.

**Treat every PR image as arbitrary, untrusted code, including fork PRs.**
Use a dedicated, disposable dev security boundary with no production/staging
network access, credentials, cloud metadata access, or shared Docker daemon.
Restrict egress and isolate previews from sensitive services. Container
hardening is defense in depth, not a VM security boundary. Never run this dev
runner on a persistent trusted machine. Restrict **all deployment runner groups**
to the trusted deployment workflow paths on `refs/heads/main` (or the exact
approved preview workflow commit described below); labels alone are
not an access control. Otherwise a PR can change its own workflow to request a
production runner without using these deployment gates. If your GitHub plan or
repository cannot enforce that restriction, do not attach trusted self-hosted
runners to the PR repository: use a policy-enforced deployment controller or
separate trusted deployment repository first. For public repositories, assess
GitHub's self-hosted-runner risks and use isolated disposable dev VMs/hosts.
GitHub's fork-workflow approval is separate from dev deployment approval.

The PR's `CI` workflow calls `.github/workflows/preview.yml` at the immutable
commit `25646215ded255adb6c02aa80c161dd56b14557b` as a reusable workflow; it has
no separate `workflow_run` trigger. This revision already has `workflow_call`,
so CI can resolve it even before this change reaches `main`. Keep the dev runner
group restricted to
`jupe/OpenJury/.github/workflows/preview.yml@25646215ded255adb6c02aa80c161dd56b14557b`,
not the PR-controlled caller. Keep staging/production runner policies restricted
to their trusted workflows on `main`. Preview orchestration always checks out
trusted `main` scripts, never PR
scripts, and pulls the tested image by digest from
`ghcr.io/jupe/openjury-preview` using the artifact from the same CI run.
Fork PRs build and test but do not deploy: their read-only token cannot create
deployment records and dev secrets are unavailable. To preview reviewed fork
changes, a maintainer must put them on a same-repository branch.
Dev should contain **no secrets**. Protect the `dev` environment with required
maintainer reviewers and prevent self-review before enabling preview CD.
Do not approve images from unreviewed/untrusted contributors. Fully automatic
previews require infrastructure capable of safely containing hostile workloads.

## Configure GitHub environments and flags

Create the `dev`, `staging`, and `production` environments **before** enabling CD.
Restrict staging/production deployment branches to `main`; require production
reviewers if desired. Permit PR merge refs (`refs/pull/<number>/merge`) in `dev`;
the reusable workflow retains the caller's event ref. `dev` supplies approval,
variables, and secrets with `deployment: false`; do not configure custom
deployment protection rules, which are incompatible with this setting.
The preview job appears in the PR's CI checks. It explicitly records a
`dev-pr-<number>` deployment for the PR head commit, with the URL
`https://pr-<number>.<DEV_BASE_DOMAIN>` in the PR deployment and workflow summary.
These per-PR deployment records do not supply secrets or replace `dev` approval.

| Scope | Variable/secret | Value |
| --- | --- | --- |
| Repository variable | `PREVIEW_CD_ENABLED` | `true` to deploy PR previews |
| Repository variable | `CD_ENABLED` | `true` to deploy staging then production |
| `dev` variable | `DEV_BASE_DOMAIN` | e.g. `dev.example.com`, without a scheme |
| `dev` variable | `PREVIEW_ADMIN_EMAIL` | Optional seeded preview account; defaults to `admin@openjury.test` |
| `dev` secret | `PREVIEW_ADMIN_PASSWORD` | Optional; when set, every preview seeds that account with this password |
| `dev` variable | `APP_SCHEME` | Optional; `http` only for a [LAN-only dev VM](proxmox.md#quick-start-lan-only-dev-vm), defaults to `https` |
| `staging` / `production` variable | `APP_HOST` | Environment hostname, without a scheme |
| Each environment variable | `PROXY_NETWORK` | Optional; defaults to `openjury-proxy` |
| Each environment variable | `TLS_RESOLVER` | Optional; defaults to `letsencrypt` |
| `staging` / `production` variable | `SUPABASE_URL` | That environment's public Supabase URL |
| `staging` / `production` secret | `SUPABASE_ANON_KEY` | That environment's **public anon** key only |

Allow Actions to publish/read this repository's GHCR package. The workflows use
short-lived `GITHUB_TOKEN` credentials; no PAT is required. If the package already
exists, grant this repository Actions access in its package settings.

Enable the flags independently after infrastructure and environment protections
are ready. Push a new PR revision/main commit (or rerun its CI) to start delivery.
The pinned reusable preview workflow must exist at its referenced commit; the
Release `workflow_run` workflow must exist on the default branch (`main`).
Do not approve an old
deployment after its three-day image artifact expires; rerun CI instead.

### Migrating from the separate PR preview workflow

GitHub resolves reusable workflows before evaluating job conditions; disabling
`PREVIEW_CD_ENABLED` cannot fix a call to a workflow without `workflow_call`.
The immutable pin avoids that bootstrap failure without loading orchestration
from the PR's current revision. Review and allow the exact pinned workflow in
the dev runner policy before enabling preview CD. Until this change is merged,
disable preview CD to avoid also triggering the legacy `workflow_run` preview
on `main`. After merging, update open PR branches from `main`, re-enable the flag,
and rerun CI on a reviewed same-repository PR to verify approval, the preview
check, and the deployment URL on its head commit.

When changing preview orchestration later, update the caller's pin and the dev
runner allowlist to an existing reviewed commit with `workflow_call`; changes
to the working copy alone do not change the pinned workflow. Do not use a local
PR-controlled reusable workflow or a moving PR branch as a shortcut.

## Cleanup, failures, and recovery

- Each successful PR revision destroys its previous container and project
  volumes before starting the tested image. There are no persistent dev mounts.
  Failed, stale, or closed-during-deployment previews are also removed.
  CI runs with preview CD enabled are not interrupted by newer PR commits;
  newer checks run independently of older preview approvals, and outdated heads
  are skipped after approval. Replacing a preview marks its previous deployment
  records inactive, even if the replacement fails. Each PR's deployment statuses
  are independent, so a successful preview does not deactivate another PR's URL.
- PR closure (merged **or unmerged**) triggers trusted cleanup without a dev
  approval. Deployment and cleanup share a per-PR lock; other PRs are independent.
  Reopening a PR triggers CI and a fresh preview.
  Cleanup also marks that PR's deployment records inactive.
- If a runner is offline or an event was missed, run **PR preview cleanup → Run workflow**
  on `main`, supplying `pr_number`, to destroy that preview. This cleanup-only
  dispatch also works when `PREVIEW_CD_ENABLED` is disabled. Clean up existing
  previews before disabling the flag; disabling it is not a mass teardown.
- Failed smoke reports are attached to the Release run. Production is untouched
  if staging fails. A production smoke failure marks the release failed but
  does not automatically revert traffic; there is no blue/green or zero-downtime
  guarantee with this single-container Compose setup.
- To roll back, take a previously successful digest from a Release summary,
  authenticate the relevant host to GHCR, set the same environment variables
  and `COMPOSE_PROJECT_NAME`, then run `bash deploy/stack.sh deploy` with `IMAGE`
  set to that digest. Run `PLAYWRIGHT_BASE_URL=https://<host> npm run test:smoke`
  afterward. Do not reset persistent data or rebuild an old source tree.
- Monitor host disk use and retain enough prior GHCR digests for rollback.
  Cleanup removes the preview's old image when it is not shared; it never runs
  a global Docker prune or deletes the shared proxy/network.
