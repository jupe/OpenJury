# OpenJury

OpenJury is a starter architecture for a serverless, real-time, multi-tenant
competition and blind-voting platform. Communities create isolated **groups** and
host competitions such as baking contests, karaoke nights, or hackathons. Each
competition has configurable grading categories, participant entries, and votes.
Events can be live (synchronous) or remote (asynchronous).

This repository is **scaffolding, not a working voting service**. Pages contain
placeholder UI; no authentication, database queries, media uploads, voting,
moderation, or lifecycle automation is implemented.

## Tech stack

- **Next.js App Router**, React, and TypeScript for pages and application structure.
- **Tailwind CSS** for styling shared UI components.
- **Supabase**: PostgreSQL database, Auth (planned magic links / OAuth), Storage
  (planned entry media), and Realtime (planned state updates).
- **Deployment**: Docker images with optional GitHub Actions deployments to
  self-hosted Docker hosts; Supabase Cloud for the persistent backend.

## Local setup

### 1. Install and run

Use Node.js 26.10.0 (pinned in `.nvmrc`) and npm 12.2.0, matching Docker and CI.
Node.js 26 is currently the Current release, not LTS.

```sh
nvm install
nvm use
npm install --global npm@12.2.0
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. All placeholder routes work without Supabase
configuration. Restart the dev server after changing environment variables.
If you do not use nvm, install the same Node.js version directly.

Tooling uses the latest compatible stable releases. ESLint stays on 9.39.5
because Next.js's React/import/accessibility plugins do not yet support ESLint
10; TypeScript stays on 6.0.3 because typescript-eslint does not yet support
TypeScript 7. Upgrade these together once upstream support is available.

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Check TypeScript without building |
| `npm run build` | Type-check and create a production build |
| `npm start` | Serve the production build |
| `npm run test:e2e` | Run Chromium desktop/mobile browser tests |
| `npm run test:smoke` | Run the deployment smoke subset |

For local browser tests, run `npx playwright install --with-deps chromium` first.
Playwright builds and starts the production server automatically.
Set `PLAYWRIGHT_BASE_URL` to test an already running container or deployment.
Tests cover the implemented placeholder UI, navigation, and health checks—not
authentication or voting features that do not exist yet.

### 2. Configure Supabase

Create a Supabase project and copy its project URL and **public anon key** into
`.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-anon-key
```

These values are exposed to the browser. Never use a service-role key or secret
key in a `NEXT_PUBLIC_*` variable, and never commit `.env.local`.

`lib/supabase.ts` exports `getSupabase()`, a lazily initialized client for future
browser-side integration. Calling it without configuration produces a clear
error; simply rendering the starter does not require credentials. Server-side
cookie/session handling should be added separately when implementing Auth.

### 3. Apply the schema

In the Supabase dashboard SQL Editor, run the contents of
`supabase/migrations/01_initial_schema.sql` once against a fresh project. The
migration expects Supabase's `auth.users` table and is not intended for a plain
PostgreSQL database without that table.

Alternatively, with the Supabase CLI installed and Docker running, initialize a
local Supabase workspace with `supabase init`, then run `supabase start` and
`supabase db reset` from the repository root. The reset applies migrations and
**deletes existing local database data**. Use the local URL and anon key printed
by the CLI in `.env.local`. CLI workspace configuration is not included here.

## Project structure

```text
app/
  layout.tsx                    Root document and shared layout
  globals.css                   Tailwind import and base styles
  page.tsx                      / — landing and sign-in placeholder
  dashboard/page.tsx            /dashboard — user's groups
  group/[id]/page.tsx            /group/[id] — group competition list
  competition/[id]/page.tsx      /competition/[id] — submissions and voting
  competition/[id]/admin/page.tsx
                                /competition/[id]/admin — review and publishing
components/
  Layout.tsx                    Shared navigation and page container
  Card.tsx                      Content section
  Button.tsx                    Styled native button
lib/
  supabase.ts                   Lazy Supabase client
supabase/
  migrations/01_initial_schema.sql
.env.example                    Public client configuration template
```

Use `/group/demo`, `/competition/demo`, and `/competition/demo/admin` to preview
dynamic routes. IDs are displayed as placeholders, not queried from the database.
Actions are disabled deliberately, and the admin page is a public UI preview,
not an authorized admin area.

## Database model

Supabase Auth manages users in `auth.users`; application names can later be
stored in user metadata or a separate profile table.

| Table | Purpose |
| --- | --- |
| `groups` | Tenant name, creator, and creation time |
| `group_members` | Group/user membership with `admin` or `member` role |
| `competitions` | Group event, live/remote type, status, and optional deadlines |
| `categories` | Competition grading criteria with a default maximum score of 5 |
| `entries` | Submission creator, title, media URLs, anonymous number, and disqualification flag |
| `votes` | Entry/category/user score, unique per entry, voter, and category |

UUID primary keys, foreign keys, allowed-value checks, and cascading deletion of
group-owned data are defined in the migration. Votes accept scores from 1–5.
Anonymous entry numbers are nullable until voting starts and unique within a
competition; assigning them is deferred. Category-specific score limits and
ensuring an entry and category belong to the same competition must be enforced
when implementing voting.

The planned lifecycle is:

```text
draft → submission → voting → review_pending → completed
```

Live events advance through admin controls; remote events will use deadlines.
Random numbering, deadline jobs, vote locking, moderation, result aggregation,
and Realtime subscriptions are intentionally left for future implementation.

## Security boundary and next steps

**Row Level Security is enabled on all six tables with no access policies.**
Anonymous and authenticated API clients therefore have no row access by
default. This is intentional: do not expose data or add permissive policies
just to make the placeholders functional.

Before enabling real functionality:

1. Implement Auth and group membership checks, including admin authorization.
2. Add tenant-aware RLS policies based on `auth.uid()` and group membership.
3. Provide a safe blind-voting view or RPC that omits `creator_id` and `title`
   for non-admins until results are published. **RLS filters rows, not columns**;
   RLS alone cannot hide those fields while exposing the same entry row.
4. Enforce voter identity, membership, competition/category consistency,
   category score limits, voting status, and deadlines in the database.
5. Add private Storage buckets and appropriate upload/read policies.
6. Implement lifecycle transitions, results publishing, and Realtime updates
   only after the access model is secured.

## CI/CD

### Delivery flow

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

### Enable merge protection first

In GitHub's ruleset/branch protection settings for `main`:

- Require a pull request, reviews, and the `checks` status check.
- Require branches to be up to date, or enable the merge queue (CI handles
  `merge_group` events).
- Prevent bypasses/direct pushes, and require review of workflow, Docker,
  deployment, and dependency changes by trusted maintainers.

Workflow files alone cannot enforce merge protection; these repository settings
must be applied by an administrator. No path filters skip CI.

### Docker and runtime configuration

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

The app is currently stateless scaffolding. **Dev previews deliberately have no
Supabase credentials or persistent backend**, so every preview starts empty.
There is no working database-backed user journey to reset or test yet. Before
adding those features, extend preview provisioning/teardown with an isolated
disposable Supabase project or stack per PR, and add database/RLS tests. Never
point dev at staging or production. Persistent Supabase projects, backups, and
schema migrations are managed separately; this frontend deployment does not
reset or migrate them. Preserve the existing deny-by-default RLS boundary.

### Prepare self-hosted infrastructure

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

### Configure GitHub environments and flags

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

### Cleanup, failures, and recovery

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