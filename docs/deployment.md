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

The frontend uses browser sessions and group data in Supabase. **Dev previews deliberately have no
Supabase credentials or persistent backend**, so every preview starts empty.
To exercise authenticated group journeys in previews, first extend preview
provisioning/teardown with an isolated disposable Supabase project or stack per
PR, and run database/RLS tests. Never
point dev at staging or production. Persistent Supabase projects, backups, and
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
to the trusted deployment workflow paths on `refs/heads/main`; labels alone are
not an access control. Otherwise a PR can change its own workflow to request a
production runner without using these deployment gates. If your GitHub plan or
repository cannot enforce that restriction, do not attach trusted self-hosted
runners to the PR repository: use a policy-enforced deployment controller or
separate trusted deployment repository first. For public repositories, assess
GitHub's self-hosted-runner risks and use isolated disposable dev VMs/hosts.
GitHub's fork-workflow approval is separate from dev deployment approval.

Preview orchestration always checks out trusted `main` scripts, never PR
scripts, and loads only the image artifact from that PR's successful CI run.
Dev should contain **no secrets**. Protect the `dev` environment with required
maintainer reviewers and prevent self-review before enabling preview CD.
Do not approve images from unreviewed/untrusted contributors. Fully automatic
previews require infrastructure capable of safely containing hostile workloads.

## Configure GitHub environments and flags

Create the `dev`, `staging`, and `production` environments **before** enabling CD.
Restrict staging/production deployment branches to `main`; require production
reviewers if desired. Permit the trusted preview workflow's refs in `dev`.
The preview deployment URL appears in the environment deployment and workflow
summary as `https://pr-<number>.<DEV_BASE_DOMAIN>`.

| Scope | Variable/secret | Value |
| --- | --- | --- |
| Repository variable | `PREVIEW_CD_ENABLED` | `true` to deploy PR previews |
| Repository variable | `CD_ENABLED` | `true` to deploy staging then production |
| `dev` variable | `DEV_BASE_DOMAIN` | e.g. `dev.example.com`, without a scheme |
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
`workflow_run` workflows must exist on the default branch (`main`) before they
can trigger. Do not approve an old deployment after its three-day image artifact
expires; rerun CI instead.

## Cleanup, failures, and recovery

- Each successful PR revision destroys its previous container and project
  volumes before starting the tested image. There are no persistent dev mounts.
  Failed, stale, or closed-during-deployment previews are also removed.
- PR closure (merged **or unmerged**) triggers trusted cleanup without a dev
  approval. Deployment and cleanup share a per-PR lock; other PRs are independent.
  Reopening a PR triggers CI and a fresh preview.
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
