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
`/dashboard`. For preview-safe links, set the **Magic Link**, **Confirm signup**,
and **Invite user** email templates in Supabase Auth to the contents of
`public/auth-email.html`. Set Site URL to the app origin without a trailing slash.
The template links directly to the app with `{{ .TokenHash }}` in the URL fragment,
not to `{{ .ConfirmationURL }}` (which consumes the token on a GET).
The app calls `verifyOtp` only after the recipient selects **Continue to OpenJury**.
Fragments are not sent in HTTP requests or referrer headers. Gmail long-press
previews and email scanners can load the page without spending the token, even
when they execute JavaScript. The recipient can reopen the original email link.
Keep tokens single-use and retain Supabase's normal expiration (one hour by
default); extending expiration alone does not fix premature consumption.
Previously sent links still use the old flow; request a fresh link after updating
the templates.
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
`supabase/migrations/15_competition_details.sql`,
`supabase/migrations/16_competition_deletion.sql`,
`supabase/migrations/17_participant_voting.sql`,
`supabase/migrations/18_heic_submission_media.sql`,
`supabase/migrations/19_group_overview.sql`,
`supabase/migrations/20_member_display_names.sql`,
`supabase/migrations/21_competition_start_notifications.sql`,
`supabase/migrations/22_submission_upload_preflight.sql`, and
`supabase/migrations/23_my_overview.sql`,
`supabase/migrations/24_registered_email_invites.sql`, and
`supabase/migrations/25_prevent_self_voting.sql`, and
`supabase/migrations/26_own_entry_voting_gallery.sql`, once each, in that order.
Self-hosted deployments apply them automatically and record each one.
They expect Supabase's `auth.users` table and API roles and are not intended
for a plain PostgreSQL database without that infrastructure. For existing
projects, apply only migrations not already applied, in sequence. Apply
migrations as the database owner, as in the SQL Editor: security-definer
functions run with their owner's permissions to perform the otherwise-denied
writes.
Migration 15 adds competition description/rules and admin-only metadata editing
in every phase; existing draft-save calls may omit the two new optional arguments.
Migration 16 adds an admin-only competition deletion RPC that preserves
disqualification audit records.
Migration 17 adds default-disabled participant voting, configurable by admins
while a competition is a draft. Participants still cannot vote on their own entry.
Migration 18 adds HEIC/HEIF support for private submission media.
Migration 19 adds a read-only group overview RPC with member and competition counts.
Without it, groups still list but show no counts.
Migration 20 adds metadata names to the admin-only group member list.
Signed-in users can set or clear their optional name in the account menu.
The form updates only their own Supabase Auth `display_name` metadata; names
also appear in existing attendee and published-result projections.
Migration 21 adds optional competition-start emails. Notifications are skipped
by default; trusted servers need the [email configuration](deployment.md#optional-competition-start-emails)
before admins can opt in when opening submissions. The browser-only demo never sends emails.
Migration 22 fixes photo upload authorization during Storage's preflight check,
before completed file-size metadata is available. Existing deployments must
apply it to resolve upload policy failures.
Migration 23 adds the home page's personal totals and per-competition next steps.
Without it, the home page still lists open competitions without totals or highlights.
Competition setup and details support English and Finnish through `lib/i18n.tsx`.
Choose the language from the account menu; the preference is stored in the browser.
Translate interface labels and messages, not user-provided competition names,
descriptions, or rules.

Alternatively, with the Supabase CLI installed and Docker running, initialize a
local Supabase workspace with `supabase init`, then run `supabase start` and
`supabase db reset` from the repository root. The reset applies migrations and
**deletes existing local database data**. Use the local URL and anon key printed
by the CLI in `.env.local`. CLI workspace configuration is not included here.

See the [database model and lifecycle](database.md) and
[security prerequisites](security.md) before implementing database-backed features.
