# Security boundary and next steps

[Project overview](../README.md) · [Database](database.md) · [Deployment isolation](deployment.md#prepare-self-hosted-infrastructure)

**Row Level Security is enabled on application tables.** After migration
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
Migration `15_competition_details.sql` adds optional description/rules to atomic
draft saves and the metadata-only `save_competition_details` RPC for every phase.
Both are authenticated-only security-definer functions with empty search paths
and current group-admin checks. Metadata edits lock the competition and update
only name, description, and rules; they cannot alter categories, deadlines, or
status. Names are trimmed to 1–100 characters; optional details are trimmed,
blank-to-null, and limited to 10,000 characters each, also enforced by table checks.
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
vote count, snapshots rankings, and marks results `results_published` atomically. The
published-results RPC reveals entry titles and internal creator IDs only to group members
after completion; the lifecycle RPC cannot bypass publication.
Migration `10_competition_attendees.sql` adds an admin-only attendee RPC with an
empty security-definer search path and authenticated-only execution. It checks
`auth.uid()` against current admin membership, includes all current group members
and only this competition's historical creators/voters, and excludes audit-only
departed admins. It returns names, current/former roles, and submission/voting
participation flags, never scores or ballot contents. Trimmed metadata names
fall back to email only in this admin projection, then to `Participant`, never
to UUIDs. The published-results RPC appends metadata-only `creator_name` labels
with a `Participant` fallback; no email fallback is exposed to members.
Migration `11_review_enhancements.sql` adds admin-only category review projections,
disqualification dispositions, audited reinstatement, and an admin-editable
publication schedule. Content removal clears the entry's title and media references,
then authorizes the admin to delete those private Storage objects during review;
the entry, votes, and audit remain for accountability. Scheduled publication is
service-role-only and uses the same locked atomic publication function as manual
publication. Category and overall snapshots remain inaccessible until publication.
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

Migration `12_roles_and_invites.sql` adds confirmed-email platform administration,
admin-controlled link/email invitations and membership management, and separate
participant/audience competition roles. Direct invitation and platform-admin table
access remains revoked. A group admin role alone does not replace the competition
role required for submission or voting.

The `competition-submissions` Storage bucket is private, limits uploads to
JPEG/PNG/WebP images up to 10 MiB, and uses random UUID filenames without user
identifiers or original filenames. Storage policies bind each object to its
entry owner and competition phase. The UI downloads protected objects through
the authenticated Storage client into temporary in-memory Blob URLs; it does
not create public or signed media URLs. Removed media and failed uploads are
deleted through Storage and failed cleanup can be retried.

CI runs `bash supabase/test.sh` against a disposable real Supabase stack. It applies
all migrations and executes every `supabase/tests/*.sql` file, including platform
administration, invitations and participant/audience role tests. Its dedicated
Docker bridge publishes no ports and cleanup removes only uniquely named test resources.
For manual verification, run `supabase/tests/group_access.sql`,
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

Migration `16_published_result_permissions.sql` revokes the `service_role` EXECUTE
grant inherited from real Supabase default privileges when migration 14 recreated
the published-results function. Apply it to existing deployments as well; changing
an already-recorded migration would not repair their grants.

Operational safeguards are covered alongside the procedures they protect:
[public client configuration](development.md#2-configure-supabase),
[merge protection](ci-cd.md#enable-merge-protection-first),
[automation permissions](automation.md), [deployment isolation](deployment.md),
and [Proxmox trust boundaries](proxmox.md#prerequisites-and-trust-boundaries).

## Reporting a vulnerability

Do not publish credentials, participant data, or exploit details in an issue or
pull request. Use this repository's **Security → Report a vulnerability** private
reporting feature when enabled. If it is unavailable, ask the maintainer to enable
private reporting without including sensitive details. There is no monitored
security email address published by this project.

Include the affected revision, impact, and a minimal reproduction using a local
disposable environment and fictional data. Do not probe the maintainer's machines,
production service, or other participants' accounts without explicit authorization.
Fixes target the current maintained `main` revision; older deployments should be
updated after review. No response-time guarantee is offered.

## Before making the repository public

These are operator requirements, not settings enforced by a code commit:

- Stop and unregister **all** runners attached to this source repository, including
  organization runners whose groups permit it. Disable queued legacy deployment
  runs and destroy old previews from a trusted administrator session.
- Create a private, maintainer-only deployment repository or controller; migrate
  runner registrations and environment secrets there. Do not expose it to public
  PRs through dispatch tokens or reusable self-hosted workflows.
- Protect `main`: require PRs, current-revision maintainer/code-owner approval,
  dismiss stale approvals, require `checks`, and prevent unreviewed bypasses.
  CODEOWNERS alone does not enforce reviews. Require approval for all outside
  contributors' Actions runs, keep fork tokens read-only, and never send fork
  workflows secrets. Retain production deployment approval in the private boundary.
- Audit **all accessible history, branches and tags**, issues, PR discussions,
  screenshots, deployment summaries, Actions logs/artifacts, and package layers.
  A clean checkout or `.gitignore` does not prove that history is safe. Scan binary
  artifacts/backups separately. Avoid publishing raw scanner output containing
  suspected credentials. Revoke/rotate exposed credentials before any history
  cleanup; cleanup does not invalidate a leaked credential.
- Enable GitHub secret scanning/push protection and private vulnerability reporting
  where available. Check repository, environment, App and package permissions.
  Public source visibility does not automatically make GHCR packages public.
- Verify VM and upstream firewall policies against private and public/NAT aliases,
  IPv6, metadata endpoints, hypervisor, backup and other environment networks.
  Keep dev/staging behind VPN or ingress authentication and Mailpit loopback-only.
- Exercise a fork PR: CI must pass without secrets and without any self-hosted
  runner job. Verify backups through an isolated restore with runners stopped.

Deleted refs, inaccessible logs, private configuration and live firewall/GitHub
settings require an administrator audit. Do not claim a complete exposure audit
based only on the repository's available refs.

## Public service abuse controls

Publishing source does not require opening account registration. Before allowing
unrestricted service access, configure the self-hosted Auth email budget with
`AUTH_RATE_LIMIT_EMAIL_SENT` (default 10 per hour), real SMTP delivery and monitoring.
Use supported Supabase Auth CAPTCHA and per-IP limits where appropriate; CAPTCHA
requires both backend/provider configuration and a client token integration.

At the upstream HTTPS terminator, enforce request/body/connection limits, restrict
accepted hostnames, overwrite untrusted forwarded headers, and allow backend VM
HTTP access only from that proxy or approved administrators. Add HSTS only after
HTTPS is reliable, `X-Content-Type-Options: nosniff`, a suitable Referrer-Policy,
frame restrictions, and a tested Content-Security-Policy compatible with Next.js,
Supabase connections and private blob image previews. Do not blindly deploy a
policy that breaks sign-in or voting. Keep WebSocket upgrades for Realtime.

The per-image bucket limit is not a per-user storage quota. Set operational
storage/account quotas, monitor disk and database growth, and alert on email/auth
abuse and unusual traffic. These external controls must be verified on the live
service; this repository does not implement a WAF, CAPTCHA UI, or quota service.
