# Security boundary and next steps

[Project overview](../README.md) · [Database](database.md) · [Deployment isolation](deployment.md#prepare-self-hosted-infrastructure)

**Row Level Security is enabled on all six tables.** After migration
`02_group_access.sql`, authenticated users can read only their own membership
rows and the groups those memberships grant access to. Anonymous clients have
no group access. Group creation uses the `create_group` RPC, which creates the
group and its initial admin membership in one transaction. Its security-definer
function has an empty search path, explicitly checks `auth.uid()`, and is
executable only by authenticated clients. Direct group and membership writes
are revoked; users cannot join arbitrary groups or promote themselves. Migration
`09_group_management.sql` adds admin-only rename and removal RPCs; removal
cascades through group-owned data, but groups with disqualification audit records
cannot be removed so those records remain intact.

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
Migration `06_secure_ballots.sql` exposes complete category ballots only through
a row-locked RPC and an own-ballot-only projection. PostgreSQL rejects self-votes,
checks every category and score, excludes each voter's own entry from the blind
projection, and permits revisions only before the voting deadline. Members have
no RPC to read other ballots or preliminary results.
Migration `07_admin_review_and_publication.sql` makes preliminary results and
disqualification available only to group admins during review. The disqualification
RPC records a reason/admin/timestamp event and does not delete the entry or its
votes. Direct reads of audit and published snapshot tables are
revoked. A row-locked publication RPC validates complete ballots and the minimum
vote count, snapshots rankings, and completes the competition atomically. The
published-results RPC reveals entry titles and internal creator IDs only to group members
after completion; the lifecycle RPC cannot bypass publication.
Migration `11_review_enhancements.sql` adds admin-only category review projections,
disqualification dispositions, audited reinstatement, and an admin-editable
publication schedule. Content removal clears the entry's title and media references,
then authorizes the admin to delete those private Storage objects during review;
the entry, votes, and audit remain for accountability. Scheduled publication is
service-role-only and uses the same locked atomic publication function as manual
publication. Category and overall snapshots remain inaccessible until completion.
Migration `10_competition_attendees.sql` adds an admin-only attendee RPC with an
empty security-definer search path and authenticated-only execution. It checks
`auth.uid()` against current admin membership, includes all current group members
and only this competition's historical creators/voters, and excludes audit-only
departed admins. It returns names, current/former roles, and submission/voting
participation flags, never scores or ballot contents. Trimmed metadata names
fall back to email only in this admin projection, then to `Participant`, never
to UUIDs. The published-results RPC appends metadata-only `creator_name` labels
with a `Participant` fallback; no email fallback is exposed to members.
Direct profile, entry, vote, audit, and result-table access is not granted.
The browser session gates protect the UI experience, not the database: all
private reads and writes must remain authorized by PostgreSQL. Pages are public
shells and do not render private data on the server.

Migration `08_realtime_notifications.sql` sends private, payload-minimal
notifications on group and per-user topics. Realtime message reads are
authorized against current group membership; a per-user membership notification
lets a revoked member refetch and lose access without exposing membership
details. Triggers notify after changes to user-visible data, but broadcast only
a fixed version marker. Entries, votes, audit events, and result rows are not
added to the Realtime publication. Clients refetch their existing RLS/RPC
projections on notifications, reconnection, network recovery, tab visibility,
and local deadlines; token refresh/sign-out remains managed by Supabase Auth.
A trusted scheduled service must invoke
`process_scheduled_competition_publications()` periodically using the service-role
credential; never expose that credential to the browser.

Remaining security work:

1. Implement invitations and authorized membership management, including admin
   authorization. An initial admin role alone does not grant competition access.

The `competition-submissions` Storage bucket is private, limits uploads to
JPEG/PNG/WebP images up to 10 MiB, and uses random UUID filenames without user
identifiers or original filenames. Storage policies bind each object to its
entry owner and competition phase. The UI downloads protected objects through
the authenticated Storage client into temporary in-memory Blob URLs; it does
not create public or signed media URLs. Removed media and failed uploads are
deleted through Storage and failed cleanup can be retried.

Run `supabase/tests/group_access.sql`,
`supabase/tests/group_management.sql`,
`supabase/tests/competition_setup.sql`,
`supabase/tests/secure_submissions.sql`,
`supabase/tests/transactional_lifecycle.sql`,
`supabase/tests/admin_review_and_publication.sql`,
`supabase/tests/competition_attendees.sql`, and
`supabase/tests/realtime_notifications.sql` as the database owner on a
disposable Supabase database after applying all migrations. The assertions cover tenant
isolation, admin-only draft setup, deadline and score constraints, frozen
criteria after submission opens, submission ownership and deadline enforcement,
media validation, separate admin/blind projections, and continued denial of
direct entry and vote access, lifecycle authorization, vote limits, stable entry
numbers, ballot revisions and self-vote protection, and idempotent deadline
processing. The lifecycle test also guards the shared row locks and skip-locked
deadline worker used to serialize concurrent operations. The realtime test covers private topic membership, tenant isolation,
revocation, message-forgery denial, safe payloads, and publication exclusions.
The admin review/publication test covers role-gated preliminary
results, disqualification audit retention, ballot aggregation/ties/minimums, and
post-publication identity access. The attendee test covers inactive/current and
historical participants, role/label fallbacks, email-free published labels,
anonymous/member/other-tenant denial, membership revocation, and denied direct
sensitive-table access. Fixtures roll back.

Operational safeguards are covered alongside the procedures they protect:
[public client configuration](development.md#2-configure-supabase),
[merge protection](ci-cd.md#enable-merge-protection-first),
[automation permissions](automation.md), [deployment isolation](deployment.md),
and [Proxmox trust boundaries](proxmox.md#prerequisites-and-trust-boundaries).
