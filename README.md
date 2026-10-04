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
- **Deployment target**: Vercel for the frontend and Supabase Cloud for the backend.

## Local setup

### 1. Install and run

Use Node.js 22 or newer and npm.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. All placeholder routes work without Supabase
configuration. Restart the dev server after changing environment variables.

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run lint` | Run ESLint |
| `npm run build` | Type-check and create a production build |
| `npm start` | Serve the production build |

There is no test runner configured yet.

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

For Vercel deployment, configure the same public environment variables in the
project settings and deploy this Next.js repository. Apply database migrations
separately to Supabase; deploying the frontend does not apply them.