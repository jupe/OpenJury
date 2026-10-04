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

## 2. Configure Supabase

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

## 3. Apply the schema

In the Supabase dashboard SQL Editor, run the contents of
`supabase/migrations/01_initial_schema.sql` once against a fresh project. The
migration expects Supabase's `auth.users` table and is not intended for a plain
PostgreSQL database without that table.

Alternatively, with the Supabase CLI installed and Docker running, initialize a
local Supabase workspace with `supabase init`, then run `supabase start` and
`supabase db reset` from the repository root. The reset applies migrations and
**deletes existing local database data**. Use the local URL and anon key printed
by the CLI in `.env.local`. CLI workspace configuration is not included here.

See the [database model and lifecycle](database.md) and
[security prerequisites](security.md) before implementing database-backed features.
