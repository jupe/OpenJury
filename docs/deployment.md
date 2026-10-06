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
deployment. The private preview template applies trusted `main` migrations, and its API is
served on the preview host under `/auth/v1`, `/rest/v1`, `/realtime/v1`, and
`/storage/v1`. Every revision starts empty, and closing the PR deletes the
database and storage volumes. It needs about 0.5 GB RAM per preview. Magic-link
emails go to the dev VM's loopback-only Mailpit; inspect them through an SSH
tunnel to port 8025. Disposable previews may seed a password account so admins
can sign in without opening email. Set `PREVIEW_ADMIN_EMAIL` (default
`admin@openjury.test`, restricted to fictional `.test`/`.invalid` domains)
and an explicit strong `PREVIEW_ADMIN_PASSWORD` secret
in the private deployment boundary. There is no shared default password.
Seeded accounts are only for disposable previews;
staging and production never enable password sign-in or seed this account. Never
point dev at staging or production. Persistent Supabase projects, backups, and
schema migrations are managed separately; this frontend deployment does not
reset or migrate them, unless an environment opts into the
[self-hosted stack](proxmox.md#quick-start-lan-staging-and-production-vms).
Preserve deny-by-default access for competition data.

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

The public source repository has **no active self-hosted deployment workflows**.
Image publication from trusted `main` stays enabled on GitHub-hosted runners.
Reference workflows under `deploy/workflows/` are not active Actions workflows
here. They must be reviewed and installed in a separate private deployment
repository before use. This change deliberately stops automatic VM deployment
until that operator migration is complete.

**Do this before making the source public:**

1. Stop/unregister every runner attached to this source repository, including
   inherited organization runner groups, cancel queued legacy deployments, and
   clean up existing previews with trusted scripts. Removing workflow files or
   turning off CD flags does not prevent a new PR workflow from requesting an
   already registered runner.
2. Create a private maintainer-only deployment repository. Copy the reviewed
   `deploy/workflows/*.yml` templates into its `.github/workflows/` directory.
   They check out trusted source `main` for validation and the selected successful
   source revision for deployment scripts, configuration and migrations; they
   never check out PR code.
   Configure `SOURCE_REPOSITORY=jupe/OpenJury`, `SOURCE_TOKEN` (source Actions,
   Contents and Pull requests read) and `GHCR_TOKEN` (source package read)
   as private-controller secrets. These are the controller credentials needed
   to read source Actions metadata/artifacts and pull its GHCR images. Its default
   `GITHUB_TOKEN` belongs to the private repository and does not automatically
   authorize cross-repository API/package access.
3. Register the VMs only to that private repository. Move SMTP, production and
   preview credentials into its environments; remove those secrets from the public
   source repository. Protect the controller's `main` and require production approval.
4. Accept only a validated successful source CI `main` push run and its exact
   immutable tested image digest/revision. Verify workflow identity, repository,
   event, branch, conclusion and current `main` revision again after approval.
   Do not accept a digest, source branch or dispatch payload as proof of CI success.
   Wait for hosted Release promotion: the controller additionally confirms that
   `sha-<revision>` points to that exact digest, so registry retention protects
   the deployed image. Missing/mismatched promotion fails closed; the tag is never
   the deployment authority. The current confirmation supports single-platform
   images only; extend verification and retention before adopting image indexes.
5. Verify isolated staging deployment and smoke tests before enabling production.
   Keep previews disabled until their separate network/access boundary is ready.

Repository creation, runner re-registration, permissions, secrets and live
firewall changes cannot be performed by committing this source change.

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
- HTTPS reachability from the private controller's GitHub-hosted smoke job, and
  outbound access to GitHub artifacts/GHCR from deployment hosts.

The smoke job is separate from the deployment VM so protected public/NAT aliases
and hairpin-egress blocks do not prevent checking the public ingress. Restricted
dev/staging ingress requires an operator-managed, approved VPN integration or
equivalent trusted access for that job; do not weaken the VM firewall to make
smoke tests pass.

**Treat every PR image as arbitrary, untrusted code, including fork PRs.**
Use a dedicated, disposable dev security boundary with no production/staging
network access, credentials, cloud metadata access, or shared Docker daemon.
Restrict egress and isolate previews from sensitive services. Container
hardening is defense in depth, not a VM security boundary. Never run this dev
runner on a persistent trusted machine. Restrict **all deployment runner groups**
to the private deployment repository and, where supported, its trusted workflow
paths on `refs/heads/main`; labels alone are
not an access control. Otherwise a PR can change its own workflow to request a
production runner without using these deployment gates. If your GitHub plan or
repository cannot enforce that restriction, do not attach trusted self-hosted
runners to the PR repository: use a policy-enforced deployment controller or
separate trusted deployment repository first. For public repositories, assess
GitHub's self-hosted-runner risks and use isolated disposable dev VMs/hosts.
GitHub's fork-workflow approval is separate from dev deployment approval.

Public CI does not invoke a deployment workflow and does not publish PR images
to GHCR. Fork PRs build and test but never deploy. The optional private preview
template deliberately runs only the **tested trusted main image** in a disposable
backend associated with an open same-repository PR number; it does **not** show
the PR's changes. It is manually dispatched, never executes PR scripts/migrations,
and rejects fork PRs. Deploying actual PR code is deferred until a separate
disposable hostile-workload boundary has been designed and verified.
Keep the dev host free of persistent secrets/data. Protect preview access with VPN
or ingress authentication, require maintainer approval, and prevent self-review.
Do not approve unreviewed images; fully automatic hostile-code previews require
disposable per-PR VM/microVM boundaries and additional automation.

## Configure private GitHub environments

Create `dev`, `staging`, and `production` environments **in the private deployment
repository**, not the public source repository. Restrict deployments to the
controller's trusted `main`, and require production and preview reviewers.
Private-controller deployment records/checks are not automatically attached to
public PRs; publishing a URL back to the source requires a separately scoped
integration and must not disclose private hostnames or credentials.

| Scope | Variable/secret | Value |
| --- | --- | --- |
| Private controller variable | `SOURCE_REPOSITORY` | `jupe/OpenJury` |
| Private controller secret | `SOURCE_TOKEN` | Source Contents/Actions/Pull requests read only |
| Private controller secret | `GHCR_TOKEN` | Source package read only |
| `dev` variable | `DEV_BASE_DOMAIN` | e.g. `dev.example.com`, without a scheme |
| `dev` variable | `PREVIEW_ADMIN_EMAIL` | Fictional `.test`/`.invalid` address; defaults to `admin@openjury.test` |
| `dev` secret | `PREVIEW_ADMIN_PASSWORD` | Explicit strong password; no default |
| `dev` variable | `APP_SCHEME` | Optional; `http` only for a [LAN-only dev VM](proxmox.md#quick-start-lan-only-dev-vm), defaults to `https` |
| `staging` / `production` variable | `APP_HOST` | Environment hostname, without a scheme |
| Each environment variable | `PROXY_NETWORK` | Optional; defaults to `openjury-proxy` |
| Each environment variable | `TLS_RESOLVER` | Optional; defaults to `letsencrypt` |
| `staging` / `production` variable | `SUPABASE_URL` | That environment's public Supabase URL (hosted Supabase only) |
| `staging` / `production` secret | `SUPABASE_ANON_KEY` | That environment's **public anon** key only (hosted Supabase only) |
| `staging` / `production` variable | `PLATFORM_ADMIN_EMAILS` | Self-hosted Supabase only: comma-separated emails of [platform admins](architecture.md#roles), synced on every deploy (removing one revokes it). Previews default to the seeded preview account |
| `staging` / `production` variable | `SUPABASE_SELF_HOSTED` | `true` to run a persistent Supabase stack on the host instead ([LAN VMs](proxmox.md#quick-start-lan-staging-and-production-vms)) |
| `staging` / `production` variable | `TLS_TERMINATION` | `upstream` when your own proxy terminates HTTPS in front of the host; defaults to `traefik` |
| `staging` / `production` variables | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | Self-hosted Supabase only: magic-link mail server; unset sends mail to the host's Mailpit |
| `staging` / `production` secret | `SMTP_PASS` | Self-hosted Supabase only: SMTP password |
| `staging` / `production` variable | `AUTH_RATE_LIMIT_EMAIL_SENT` | Positive hourly email budget; default 10 |

Allow Actions to publish/read this repository's GHCR package. The workflows use
short-lived `GITHUB_TOKEN` credentials; no PAT is required. If the package already
exists, grant this repository Actions access in its package settings.

Source `workflow_run` triggers do not cross repository boundaries. Use the private
controller's reviewed dispatch/polling interface; never add a deployment dispatch
secret to public PR jobs. Install its workflows only after infrastructure protections
are ready. Do not approve an old deployment after its image artifact expires;
rerun the relevant trusted CI instead.

### Migrating existing installations

Disabling flags is not runner removal. Existing runner registrations and VM state
are not changed by merging this PR. Stop the services, remove their old registrations
and re-register them in the private repository. Keep persistent database/storage
volumes and their secrets file intact. Rerun guest configuration to remove any
previously public Mailpit route. Reapply the external VM firewall with all sensitive
public/NAT aliases in `openjury_protected_cidrs`; verify the actual policy afterward.
Do not enable preview access merely because the source repository is public.

## Cleanup, failures, and recovery

- Each approved private preview deploy destroys its previous container and project
  volumes before starting the tested image. There are no persistent dev mounts.
  Failed previews are removed; stale/closed PRs are rejected before deployment.
  A PR closed during deployment still needs private-controller cleanup.
  Public CI is independent of private preview approvals; outdated heads must be
  skipped after approval. Each preview is scoped by its PR number, and a new
  deployment must not delete another PR's resources.
- Public PR closure no longer schedules VM cleanup. The private controller must
  poll PR state or provide maintainer-dispatched cleanup. Deployment and cleanup
  must share a per-PR lock. Clean up closed/superseded previews promptly.
- If a runner is offline or an event was missed, run **PR preview cleanup → Run workflow**
  in the private controller on `main`, supplying `pr_number`, to destroy that preview. This cleanup-only
  dispatch does not depend on source-repository flags. Clean up existing
  previews before removing the controller; disabling it is not a mass teardown.
- Failed smoke reports are attached to the private deployment run when artifact storage is
  available; report upload failures do not block promotion, but smoke test
  failures still do. Production is untouched
  if staging fails. A production smoke failure marks the release failed but
  does not automatically revert traffic; there is no blue/green or zero-downtime
  guarantee with this single-container Compose setup.
- To roll back, take a previously successful digest from a Release summary,
  authenticate the relevant host to GHCR, set the same environment variables
  and `COMPOSE_PROJECT_NAME`, then run `bash deploy/stack.sh deploy` with `IMAGE`
  set to that digest. Run `PLAYWRIGHT_BASE_URL=https://<host> npm run test:smoke`
  afterward. Do not reset persistent data or rebuild an old source tree.
- Monitor host disk use and retain enough prior GHCR digests for rollback.
  [Automatic GHCR retention](ci-cd.md#automatic-ghcr-retention) preserves promoted
  releases, but expires old unpromoted CI images after seven days
  while retaining the five newest CI versions.
  If a tested image has been deleted, rerun all CI jobs on current `main` rather
  than rebuilding in Release or deploying an untested image. The isolated
  publication handoff requires a tested-image artifact; artifact quota exhaustion
  therefore blocks main publication rather than bypassing that trust boundary.
  Cleanup removes the preview's old image when it is not shared; it never runs
  a global Docker prune or deletes the shared proxy/network.
