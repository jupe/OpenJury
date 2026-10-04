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
lib/
  supabase.ts                   Lazy Supabase client
supabase/
  migrations/01_initial_schema.sql
  migrations/02_group_access.sql
  tests/group_access.sql        Rollback-only database access assertions
.env.example                    Public client configuration template
```

The landing, dashboard, and group routes render public shells with client-side
session gates. Authenticated clients fetch membership-authorized groups directly
from Supabase, or create a group through an atomic database RPC. No private
server-rendered data is exposed. Without configuration, safe demo navigation
remains available; no groups are queried.

Competition and admin routes still contain placeholders. Use
`/competition/demo` and `/competition/demo/admin` to preview them. Their actions
remain disabled, and the admin page is a public UI preview, not an authorized
admin area. Group invitations and competition features are future slices.
