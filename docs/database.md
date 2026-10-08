# Database model and lifecycle

[Project overview](../README.md) · [Schema setup](development.md#3-apply-the-schema) · [Security](security.md)

## Database model

Supabase Auth manages users in `auth.users`; application display names come from
the `display_name`, `full_name`, or `name` fields in user metadata.

| Table | Purpose |
| --- | --- |
| `groups` | Tenant name, creator, and creation time |
| `group_members` | Group/user membership with `admin` or `member` role |
| `competitions` | Group event, optional description/rules, live/remote type, status, deadlines, and submission photo limit |
| `categories` | Competition grading criteria with maximum scores from 1 to 5 |
| `entries` | Submission creator, title, private media keys, anonymous number, and disqualification flag |
| `votes` | Entry/category/user score, unique per entry, voter, and category |

UUID primary keys, foreign keys, allowed-value checks, and cascading deletion of
group-owned data are defined in the migration. Votes accept scores from 1–5.
Anonymous entry numbers are nullable until voting starts and unique within a
competition; the blind projection numbers eligible entries without exposing
their database IDs, creators, or titles. Category-specific score limits and
ensuring an entry and category belong to the same competition must be enforced
by the voting RPC. Category maxima cannot exceed the existing fixed 1–5 vote
scale.

## Competition lifecycle

The lifecycle is:

```text
draft → submission → voting → review_pending → results_published
```

Authenticated group admins advance competitions one phase at a time through
`transition_competition`. The RPC locks the competition row and assigns each
entry a shuffled, persistent number when voting starts. Remote competitions
advance from submission to voting and from voting to review_pending when their
respective deadlines pass; live competitions use admin transitions. A trusted
scheduled caller or service-role process should invoke
`process_remote_competition_deadlines()` periodically. It locks eligible remote
competitions, skips rows already being processed, and is safe to call repeatedly.
The move from review to `results_published` is only available through atomic result
publication.

Migration `21_competition_start_notifications.sql` adds
`start_competition(id, notify default false)`. Opt-in locks the draft competition,
invokes the existing transition to submission, and atomically snapshots current
members with verified Auth email addresses into the RLS-private
`competition_start_email_outbox`, unique per competition/user. Default-skip still
uses the unchanged `transition_competition(id, 'submission')` and creates no mail.
Only the original starter, while still an admin, can retry an existing outbox;
retries never add later members. Service-role-only claim and acknowledgement
RPCs lease recipients and record delivery, while the authenticated start API
returns only start/delivery status.
`get_my_pending_competition_start_emails(id)` lets the starting admin restore
pending retries after navigation or a lost response. It returns only a boolean,
is false for other admins or an empty/completed queue, and denies non-admins.
See [email configuration and bounded delivery
recovery](deployment.md#optional-competition-start-emails).

Members submit or revise complete category ballots through `save_ballot`. It
locks the same competition row as submissions and transitions, verifies the
member, voting phase, deadline, anonymous entry, every category, and each category
score limit, then inserts or updates that member's votes atomically. Voters may
not score their own entries; their own entries are omitted from the blind voting
projection. Revisions are allowed until the voting deadline, and the unique
entry/voter/category constraint protects against duplicate votes. `get_my_ballot`
returns only the caller's own scores; there is no member-facing ballot or
preliminary-results projection. Direct entry and vote table access remains
revoked. Migration `25_prevent_self_voting.sql` also rejects self-votes at the
database level for vote inserts and updates. Migration
`26_own_entry_voting_gallery.sql` lets an owner view their own linked media while
voting is open; the ballot UI displays it separately without score controls.

Migration `17_participant_voting.sql` adds `allow_participant_voting`, disabled
by default. Group admins can enable **Allow participants to vote** when creating
or editing a draft competition. The setting is fixed once submissions open.
When enabled, participants may score other entries and revise their ballots until
voting closes; self-voting remains prohibited and their own entry stays hidden
from the blind ballot. Audience voting is unchanged. PostgreSQL enforces this
eligibility, not just the interface.

Migration `25_submission_photo_limit.sql` adds an admin-configurable photo cap
per entry, from 1 to 20 images (default 5). Admins can set it in the draft form
or competition details; submission saves and Storage upload preflight enforce
the configured limit, and a cap cannot be lowered below an existing entry's
image count.

Migration `19_group_overview.sql` adds `get_my_groups()`, which returns each of
the caller's groups with their role, member and admin counts, and the number of
competitions in total and currently open for entries or voting. It exposes only
aggregate counts, never other members' identities, so members can see how big
their group is while direct membership reads stay limited to their own row.

Migration `23_my_overview.sql` adds `get_my_overview()` for the signed-in home
page. It returns only the caller's own totals: groups, competitions open for
entries or voting in those groups, entries submitted, distinct entries voted on,
and published wins (rank 1) and podium finishes (rank 3 or better), excluding
disqualified entries. Published results and ballots stay unreadable directly.
`get_my_competition_actions()` lists the caller's open competitions that need
them: `join` without a role, `submit` as a participant without an entry before
the deadline, and `vote` while eligible under the blind-voting rules with another
eligible entry still unscored by the caller.

## Admin review and publication

After voting closes, group admins can access preliminary rankings and
disqualification controls only while a competition is in `review_pending`.
Disqualification requires a 1–500 character reason, records the acting admin
and timestamp. Admins can exclude an entry from results, retain it at the bottom
with a disqualification label, or remove its title and media while retaining the
entry, votes, and moderation audit. Removed media is deleted from private Storage.
An admin can reinstate a disqualified entry during review unless its content was
removed; reinstatement is also recorded in the audit. Preliminary overall and
category rankings recalculate after moderation.

A ballot counts for an entry only when it contains a score for every category.
Partial single-score votes and entries without complete ballots do not affect
preliminary scores. Each category's complete-ballot scores are averaged after
normalizing by that category's maximum to a percentage; the category
percentages are then averaged with equal weight. Entries are ranked by this
score in descending order; exact ties share a rank using standard competition
ranking after scores are rounded to four decimal percentage points (for example,
1, 1, 3). Before publication, each eligible entry must
have at least one complete ballot. Admins may disqualify an entry that does not
meet that minimum; publication otherwise fails without changing competition
status or writing a partial snapshot.

`publish_competition_results` locks the competition, validates the minimum
ballot rule, stores the final rankings, and marks the competition `results_published` in
one transaction. Only then can group members read final results, which include
entry titles, internal creator IDs, and `creator_name` labels. Names use the first
nonblank trimmed metadata `display_name`, `full_name`, or `name`, falling back to
`Participant`; this member-facing projection never falls back to an email or UUID.
Users set or clear their own `display_name` through the account menu and
Supabase Auth's `updateUser` API. Migration `20_member_display_names.sql` adds
the same metadata-name priority to the admin-only `get_group_members` list,
which retains email for administration and as a fallback when no name is given.
Preliminary rankings and disqualification audit
data remain admin-only; direct access to result and audit tables is revoked.
Disqualification audit rows prevent deletion of the associated entries.

Admins can set, replace, or clear `results_publish_at` at any time while review is
pending. Times must be in the future. Manual publishing remains available and
publishes immediately. A trusted service-role scheduler must invoke
`process_scheduled_competition_publications()` periodically; it publishes due
competitions atomically and clients use private Realtime change notifications to
refetch the published projections. If a device misses a notification, it refetches
on reconnect and when the page becomes visible.

Category scores use the same complete ballots and category-max normalization as
overall scores. Ties share category rank. Category rankings are snapshotted with
the overall results and exposed to members only after publication.

## Roles and invitations

Migration `12_roles_and_invites.sql` adds the [roles](architecture.md#roles):

- `platform_admins` holds the deployment's `PLATFORM_ADMIN_EMAILS`, replaced on
  every self-hosted deploy. `is_platform_admin()` matches the signed-in user's
  confirmed email. Platform admins list every group with `get_platform_groups()`
  and become a group admin with `platform_admin_join_group()`; all other admin
  checks are unchanged.
- `group_invites` holds revocable link tokens; `accept_group_invite(token)` joins
  as a member. `group_email_invites` holds addresses that
  `claim_group_invites()` turns into memberships once that confirmed address
  signs in. Email invitations are rejected for addresses that already have an
  account; invite links can be used to invite those people instead. Repeating
  an invitation for a pending address is allowed so its email can be resent.
- Group admins list members with `get_group_members()`, change roles with
  `set_group_member_role()`, and remove members with `remove_group_member()`.
  A group always keeps at least one admin.
- `competition_participants` records each member's `participant` or `audience`
  role, set through `join_competition()`. `save_submission` requires
  participant; `save_ballot` and `get_blind_voting_entries` require audience.
  The legacy `cast_vote` RPC is no longer executable. Existing entry creators
  and voters were backfilled as participants and audience.

None of these tables are directly writable; members read only their own
competition role rows.

## Admin competition attendees

Migration `10_competition_attendees.sql` adds the admin-only
`get_admin_competition_attendees(p_competition_id uuid)` RPC for every competition
phase. It includes all current group members, even those with no activity, plus
historical creators and voters from that competition only. Departed participants
have role `former member`; current roles are `admin` or `member`. Audit-only
former admins and participants from other competitions are not included.

Each row contains `user_id` as an internal key, `display_name`, `role`,
`has_submission`, and `has_voted`. Participation flags include disqualified
submissions and any recorded vote, including partial ballots, without exposing
scores or ballot contents. Labels use trimmed metadata `display_name`, then
`full_name`, then `name`, then email, and finally `Participant`; UUIDs are never
used as fallback labels. Email fallback is admin-only. The same migration appends
the metadata-only `creator_name` to published results without changing their
completion/membership checks, rankings, or ordering.

## Implemented group access

Apply `02_group_access.sql` after the initial migration, then
`03_competition_setup.sql`. The latter grants authenticated group members read
access to their competitions and categories; an admin-only RPC creates or edits
draft competitions and replaces their scoring categories atomically. Competition
and category names are trimmed and limited to 100 characters, category names are
unique within a competition, and voting deadlines must follow submission
deadlines when both are set. Category maxima are constrained to 1–5. Draft
updates lock the competition row and are rejected after it leaves the draft
status, so lifecycle transitions must use the same row lock.

Migration `15_competition_details.sql` adds nullable `description` and `rules`,
each limited to 10,000 characters. Both save RPCs trim these fields and store blank
values as null. `save_draft_competition` accepts trailing optional `p_description`
and `p_rules` arguments (default null), saving details and categories atomically;
existing seven-argument calls remain valid and clear those optional fields.
`save_competition_details(p_competition_id, p_name, p_description, p_rules)` lets
current group admins change only the name and those details in any phase under
the same row lock. Categories, event type, deadlines, and lifecycle state are
unchanged. Names remain trimmed and limited to 1–100 characters.

Migration `09_group_management.sql` adds `rename_group` and `delete_group` RPCs.
Only group admins may rename or remove a group, and names are trimmed and limited
to 1–100 characters. Removing a group deletes its group-owned data, but is
blocked when disqualification audit records exist so the audit trail is retained.

Migration `16_competition_deletion.sql` adds the admin-only,
row-locked `delete_competition` RPC. Competition deletion cascades to its
database-owned data and is blocked when disqualification audit records exist.
Group admins can remove a competition from its group's competition list; the
existing group settings also let admins remove an entire group.

Migration `04_secure_submissions.sql` allows authenticated members to create
and edit one submission per competition through `save_submission`. It locks the
competition before validating its submission phase and deadline; direct entry
and vote reads/writes remain revoked. `get_my_submission`,
`get_admin_submissions`, and `get_blind_voting_entries` return distinct owner,
admin, and blind-voting projections. Private images are stored in the
`competition-submissions` bucket under random UUID filenames; uploads are
limited to JPEG/PNG/WebP/HEIC/HEIF and 10 MiB, and Storage authorization checks
ownership and phase. Clients download via authenticated requests rather than
public or signed URLs, and media removal is followed by Storage cleanup.

Migration `05_transactional_lifecycle.sql` adds admin-only lifecycle transitions,
voting, stable entry numbering, and service-role-only remote deadline processing.
Migration `06_secure_ballots.sql` adds atomic category ballots and a private
own-ballot projection, excludes the voter's own entry, and applies the same
self-voting prohibition to the single-score `cast_vote` RPC. Migration
`07_admin_review_and_publication.sql` adds admin-only preliminary results,
reasoned disqualification with audit retention, and atomic publication.
`11_review_enhancements.sql` adds category winner snapshots, reversible and
configurable moderation, the editable publication schedule, and a service-role
scheduled publisher. Migration `25_prevent_self_voting.sql` independently
enforces the self-voting prohibition on vote inserts and updates.

The `02_group_access.sql` migration grants authenticated
users membership-scoped group reads and reads of their own membership rows,
without recursive policies. The `create_group(group_name)` RPC validates and
trims a 1–100 character name, takes the creator from `auth.uid()`, and returns
the new UUID after atomically creating the group and its admin membership.
Direct client writes to groups and memberships are not allowed. Group email
invites and membership management use admin-authorized RPCs; competition
attendees are visible only through the admin RPC. Entry and vote access remain
deny-by-default.

On a disposable Supabase database with all migrations applied, run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/group_access.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/group_management.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/group_email_invites.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/group_overview.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/my_overview.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/competition_deletion.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/competition_setup.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/secure_submissions.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/transactional_lifecycle.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/competition_start_notifications.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/admin_review_and_publication.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/competition_attendees.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/realtime_notifications.sql
```

Use an owner connection (not an API client). The test creates fixed-ID users
and test data inside a transaction and rolls everything back; do not run it
against a production database. The competition setup test covers optional detail
creation/clearing, length limits, authorization/revocation, and metadata-only
edits across every phase without changing scoring or lifecycle fields.
The lifecycle test covers role authorization,
legal transitions, ballot creation and revision, self-voting and membership
denial, stable numbering, and idempotent remote deadline processing. The
start-notification test covers opt-in recipient snapshots, both default-skip
paths, admin-only retries and pending-status recovery, private outbox permissions, immutable payloads,
exclusive claims, token-guarded acknowledgements, and expired provider retention.
The mocked-upstream route tests live in `tests/competition-start-api.spec.ts` and
use the existing Playwright runner without requiring real Supabase/SMTP credentials.
The
review/publication test covers admin-only access, complete-ballot aggregation,
category winners, ties, minimum votes, schedule replacement/cancellation, moderation
outcomes and reinstatement, retained audit data, and atomic publication.
The attendee test covers admin-only authorization, tenant isolation, inactive and
departed participants, name fallbacks, email-free published labels, revoked
membership, and continued denial of direct sensitive-table access.
The realtime test verifies per-group and per-user channel authorization,
membership revocation, rejection of forged broadcasts, and that sensitive row
data remains excluded from Realtime.
