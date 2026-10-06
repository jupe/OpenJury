# Local development

[Project overview](../README.md) · [Architecture](architecture.md) · [Database](database.md) · [Security](security.md)

Run commands from the repository root; file paths below are relative to that
root unless explicitly stated otherwise.

## 1. Install and run

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

Open <http://localhost:3000>. Without Supabase configuration, the app shows setup
guidance and safe previews; authenticated group features require configuration.
Restart the dev server after changing environment variables.
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
| `npm run test:e2e` | Run desktop Chromium, Android Chromium, and iPhone WebKit tests |
| `npm run test:smoke` | Run the deployment smoke subset |

For local browser tests, run `npx playwright install --with-deps chromium webkit` first.
Playwright builds and starts the production server automatically.
Set `PLAYWRIGHT_BASE_URL` to test an already running container or deployment.
Tests cover navigation, health checks, and mocked authentication/group journeys.
They do not replace database policy tests or a real Supabase magic-link check.

## 2. Configure Supabase

Create a Supabase project and copy its project URL and **public anon key** into
`.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-public-anon-key
```

These values are exposed to the browser. Never use a service-role key or secret
key in a `NEXT_PUBLIC_*` variable, and never commit `.env.local`.

`lib/supabase.ts` exports `getSupabase()`, a lazily initialized browser client.
Calling it without configuration produces a clear error; rendering public
shells does not require credentials. Authentication is browser-session based;
no private server-rendered data or server-side cookie session is implemented.

Enable the email provider in Supabase Auth. Set the Site URL to the deployed
origin and add exact allowed redirect URLs for each trusted environment, such
as `http://localhost:3000/dashboard` locally and your production
`https://<host>/dashboard`. The sign-in form sends a magic link returning to
`/dashboard`; Supabase's browser client processes the returned session.
Configure production email delivery and rate limits in Supabase. Do not allow
untrusted preview origins against a production Auth project.

## 3. Apply the schema

In the Supabase dashboard SQL Editor, run
`supabase/migrations/01_initial_schema.sql` and then
`supabase/migrations/02_group_access.sql` and
`supabase/migrations/03_competition_setup.sql`,
`supabase/migrations/04_secure_submissions.sql`,
`supabase/migrations/05_transactional_lifecycle.sql`, and
`supabase/migrations/06_secure_ballots.sql` and
`supabase/migrations/07_admin_review_and_publication.sql`,
`supabase/migrations/08_realtime_notifications.sql`,
`supabase/migrations/09_group_management.sql`,
`supabase/migrations/10_competition_attendees.sql`,
`supabase/migrations/11_review_enhancements.sql`,
`supabase/migrations/12_roles_and_invites.sql`,
`supabase/migrations/13_disqualified_result_vote_count.sql`,
`supabase/migrations/14_published_result_media.sql`, and
`supabase/migrations/15_competition_details.sql`, once each, in that order.
Self-hosted deployments apply them automatically and record each one.
They expect Supabase's `auth.users` table and API roles and are not intended
for a plain PostgreSQL database without that infrastructure. For existing
projects, apply only migrations not already applied, in sequence. Apply
migrations as the database owner, as in the SQL Editor: security-definer
functions run with their owner's permissions to perform the otherwise-denied
writes.
Migration 15 adds competition description/rules and admin-only metadata editing
in every phase; existing draft-save calls may omit the two new optional arguments.

Alternatively, with the Supabase CLI installed and Docker running, initialize a
local Supabase workspace with `supabase init`, then run `supabase start` and
`supabase db reset` from the repository root. The reset applies migrations and
**deletes existing local database data**. Use the local URL and anon key printed
by the CLI in `.env.local`. CLI workspace configuration is not included here.

See the [database model and lifecycle](database.md) and
[security prerequisites](security.md) before implementing database-backed features.
