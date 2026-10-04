# Project architecture

[Project overview](../README.md) · [Local development](development.md) · [Database](database.md) · [Security](security.md)

## Project structure

Paths are relative to the repository root.

```text
app/
  layout.tsx                    Root document and shared layout
  globals.css                   Tailwind import and base styles
  page.tsx                      / — landing and magic-link sign-in
  dashboard/page.tsx            /dashboard — list and create groups
  group/[id]/page.tsx            /group/[id] — authorized group details
  competition/[id]/page.tsx      /competition/[id] — submissions and voting
  competition/[id]/admin/page.tsx
                                /competition/[id]/admin — review and publishing
components/
  Layout.tsx                    Shared navigation and page container
  Card.tsx                      Content section
  Button.tsx                    Styled native button
  AuthBoundary.tsx              Browser session gate, sign-in, and sign-out
  Groups.tsx                    Authorized group queries and creation form
  EntryWorkspace.tsx            Member submission, blind media, admin review
lib/
  supabase.ts                   Lazy Supabase client
supabase/
  migrations/01_initial_schema.sql
  migrations/02_group_access.sql
  migrations/03_competition_setup.sql
  migrations/04_secure_submissions.sql
  migrations/05_transactional_lifecycle.sql
  tests/group_access.sql        Rollback-only database access assertions
.env.example                    Public client configuration template
```

The landing, dashboard, group, competition, and admin routes render public shells
with client-side session gates. Authenticated clients fetch membership-authorized
groups directly from Supabase, or create a group through an atomic database RPC.
No private server-rendered data is exposed. Without configuration, each route
shows fictional, read-only sample content with links across the demo views; no
groups, submissions, or votes are queried or saved.

Competition and admin routes require an authenticated session for real private
content. Members can submit and edit entries while the submission phase is open;
voting shows an anonymous projection. Admin submission review is authorized by
the database. When Supabase is not configured, `/dashboard`, `/group/demo`,
`/competition/demo`, and `/competition/demo/admin` show linked, read-only demo
views with fictional data. Demo interactions are disabled and never reach
Supabase.
