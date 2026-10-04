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
Migration `04_secure_submissions.sql` keeps direct entry and vote table access
revoked. Authenticated members create or edit only their own entry through an
RPC that locks the competition row and enforces submission phase and deadline.
Separate RPC projections expose identity and title only to group admins; the
blind-voting projection contains only anonymous entry numbers and opaque media
keys. Entry and vote tables are excluded from the Realtime publication.
Migration `05_transactional_lifecycle.sql` adds admin-only, row-locked adjacent
phase transitions and persistent shuffled entry numbers. Its vote RPC uses the
same competition lock as submissions and transitions, checks membership,
category ownership, phase, deadline, and score limits, and permits members to
update their own existing vote. Remote deadlines are processed by a
security-definer function executable by `service_role` only; invoke it from a
trusted scheduled process. Its status checks and row locks make repeated or
concurrent processing safe.
The browser session gates protect the UI experience, not the database: all
private reads and writes must remain authorized by PostgreSQL. Pages are public
shells and do not render private data on the server.

Remaining security work:

1. Implement invitations and authorized membership management, including admin
   authorization. An initial admin role alone does not grant competition access.
2. Implement result aggregation and publication, moderation, and Realtime updates
   with equivalent database authorization.

The `competition-submissions` Storage bucket is private, limits uploads to
JPEG/PNG/WebP images up to 10 MiB, and uses random UUID filenames without user
identifiers or original filenames. Storage policies bind each object to its
entry owner and competition phase. The UI downloads protected objects through
the authenticated Storage client into temporary in-memory Blob URLs; it does
not create public or signed media URLs. Removed media and failed uploads are
deleted through Storage and failed cleanup can be retried.

Run `supabase/tests/group_access.sql`,
`supabase/tests/competition_setup.sql`,
`supabase/tests/secure_submissions.sql`, and
`supabase/tests/transactional_lifecycle.sql` as the database owner on a disposable
Supabase database after applying all migrations. The assertions cover tenant
isolation, admin-only draft setup, deadline and score constraints, frozen
criteria after submission opens, submission ownership and deadline enforcement,
media validation, separate admin/blind projections, and continued denial of
direct entry and vote access, lifecycle authorization, vote limits, stable entry
numbers, and idempotent deadline processing. Fixtures roll back.

Operational safeguards are covered alongside the procedures they protect:
[public client configuration](development.md#2-configure-supabase),
[merge protection](ci-cd.md#enable-merge-protection-first),
[automation permissions](automation.md), [deployment isolation](deployment.md),
and [Proxmox trust boundaries](proxmox.md#prerequisites-and-trust-boundaries).
