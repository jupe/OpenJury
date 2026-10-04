# Security boundary and next steps

[Project overview](../README.md) · [Database](database.md) · [Deployment isolation](deployment.md#prepare-self-hosted-infrastructure)

**Row Level Security is enabled on all six tables.** After migration
`02_group_access.sql`, authenticated users can read only their own membership
rows and the groups those memberships grant access to. Anonymous clients have
no group access. Group creation uses the `create_group` RPC, which creates the
group and its initial admin membership in one transaction. Its security-definer
function has an empty search path, explicitly checks `auth.uid()`, and is
executable only by authenticated clients. Direct group and membership writes
are revoked; users cannot join arbitrary groups or promote themselves.

Migration `03_competition_setup.sql` grants authenticated group members read
access to their competitions and categories. Competition creation and draft
updates are restricted to group admins through a security-definer RPC; direct
table writes remain revoked. The RPC validates deadline ordering and 1–5
category maxima, and locks the competition row before allowing a draft edit.
Entries and votes remain deny-by-default. Do not add permissive policies just
to make the remaining placeholders functional.
The browser session gates protect the UI experience, not the database: all
private reads and writes must remain authorized by PostgreSQL. Pages are public
shells and do not render private data on the server.

Before enabling submissions, voting, and publication:

1. Implement invitations and authorized membership management, including admin
   authorization. An initial admin role alone does not grant competition access.
2. Keep lifecycle transitions and draft edits serialized on the competition row.
3. Provide a safe blind-voting view or RPC that omits `creator_id` and `title`
   for non-admins until results are published. **RLS filters rows, not columns**;
   RLS alone cannot hide those fields while exposing the same entry row.
4. Enforce voter identity, membership, competition/category consistency,
   category score limits, voting status, and deadlines in the database.
5. Add private Storage buckets and appropriate upload/read policies.
6. Implement lifecycle transitions, results publishing, and Realtime updates
   only after the access model is secured.

Run `supabase/tests/group_access.sql` and
`supabase/tests/competition_setup.sql` as the database owner on a disposable
Supabase database after applying all migrations. The assertions cover tenant
isolation, admin-only draft setup, deadline and score constraints, frozen
criteria after submission opens, and continued denial of entries and votes.
Fixtures roll back.

Operational safeguards are covered alongside the procedures they protect:
[public client configuration](development.md#2-configure-supabase),
[merge protection](ci-cd.md#enable-merge-protection-first),
[automation permissions](automation.md), [deployment isolation](deployment.md),
and [Proxmox trust boundaries](proxmox.md#prerequisites-and-trust-boundaries).
