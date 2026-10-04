# Database model and lifecycle

[Project overview](../README.md) · [Schema setup](development.md#3-apply-the-schema) · [Security](security.md)

## Database model

Supabase Auth manages users in `auth.users`; application names can later be
stored in user metadata or a separate profile table.

| Table | Purpose |
| --- | --- |
| `groups` | Tenant name, creator, and creation time |
| `group_members` | Group/user membership with `admin` or `member` role |
| `competitions` | Group event, live/remote type, status, and optional deadlines |
| `categories` | Competition grading criteria with maximum scores from 1 to 5 |
| `entries` | Submission creator, title, private media keys, anonymous number, and disqualification flag |
| `votes` | Entry/category/user score, unique per entry, voter, and category |

UUID primary keys, foreign keys, allowed-value checks, and cascading deletion of
group-owned data are defined in the migration. Votes accept scores from 1–5.
Anonymous entry numbers are nullable until voting starts and unique within a
competition; the blind projection numbers eligible entries without exposing
their database IDs, creators, or titles. Category-specific score limits and
ensuring an entry and category belong to the same competition must be enforced
when implementing voting. Category maxima cannot exceed the existing fixed
1–5 vote scale.

## Planned lifecycle

The planned lifecycle is:

```text
draft → submission → voting → review_pending → completed
```

Live events advance through admin controls; remote events will use deadlines.
Random numbering, deadline jobs, vote locking, moderation, result aggregation,
and Realtime subscriptions are intentionally left for future implementation.

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

Migration `04_secure_submissions.sql` allows authenticated members to create
and edit one submission per competition through `save_submission`. It locks the
competition before validating its submission phase and deadline; direct entry
and vote reads/writes remain revoked. `get_my_submission`,
`get_admin_submissions`, and `get_blind_voting_entries` return distinct owner,
admin, and blind-voting projections. Private images are stored in the
`competition-submissions` bucket under random UUID filenames; uploads are
limited to JPEG/PNG/WebP and 10 MiB, and Storage authorization checks ownership
and phase. Clients download via authenticated requests rather than public or
signed URLs, and media removal is followed by Storage cleanup.

The `02_group_access.sql` migration grants authenticated
users membership-scoped group reads and reads of their own membership rows,
without recursive policies. The `create_group(group_name)` RPC validates and
trims a 1–100 character name, takes the creator from `auth.uid()`, and returns
the new UUID after atomically creating the group and its admin membership.
Direct client writes to groups and memberships are not allowed. Invitations,
roster visibility, and membership management are deferred. Entry and vote access
remain deny-by-default.

On a disposable Supabase database with all three migrations applied, run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/group_access.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/competition_setup.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/secure_submissions.sql
```

Use an owner connection (not an API client). The test creates fixed-ID users
and test data inside a transaction and rolls everything back; do not run it
against a production database.
