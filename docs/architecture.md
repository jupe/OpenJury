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
  invite/[token]/page.tsx       /invite/[token] — join a group from an invite link
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
  Membership.tsx                Invites, group members, platform admin, competition roles
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

## Roles

| Role | Who | Can |
| --- | --- | --- |
| Platform admin | Emails in the deployment's `PLATFORM_ADMIN_EMAILS` | See every group on the dashboard and become an admin of any of them (**Manage as admin**), after which they have all group admin rights |
| Group admin | The group's creator, and members other admins promote | Rename or remove the group, invite and remove members, promote or demote admins (a group always keeps at least one), and create and run competitions |
| Member | Anyone who joined through an invite link or an email invite | See the group's competitions and choose a role in each |
| Participant | A member who joined a competition as participant | Submit and edit their own entry; vote on other entries only if enabled for the competition |
| Audience | A member who joined a competition as audience | Vote on anonymous entries; never submit |

Members choose participant or audience on the competition page and can switch
until voting starts, except that submitting an entry makes the choice final.
Newcomers may still join the audience during voting. Email invitations send a
notification through the app server's configured SMTP server, then wait
until someone signs in with that confirmed address. Failed delivery is reported
and pending invitations can be resent. Demo invitations send no email. The
database enforces every rule; the UI only hides what a role cannot use.

Competition and admin routes require an authenticated session for real private
content. Members can submit and edit entries while the submission phase is open;
voting shows an anonymous projection. Admin submission review is authorized by
the database. When Supabase is not configured, `/dashboard`, `/group/demo`,
`/competition/demo`, and `/competition/demo/admin` show linked, read-only demo
views with fictional data. Demo interactions are disabled and never reach
Supabase.

Group admins can expand **Invite people** on the group page to create invite
links and show a QR code for each link. Scanning opens the same `/invite/[token]`
sign-in and joining flow as the copied link. QR codes are generated locally in
the browser; invite tokens are not sent to an external QR service. Revoking a
link also invalidates its QR code for people who have not joined yet.
