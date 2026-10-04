# Project architecture

[Project overview](../README.md) · [Local development](development.md) · [Database](database.md) · [Security](security.md)

## Project structure

Paths are relative to the repository root.

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
