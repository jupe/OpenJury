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
| `categories` | Competition grading criteria with a default maximum score of 5 |
| `entries` | Submission creator, title, media URLs, anonymous number, and disqualification flag |
| `votes` | Entry/category/user score, unique per entry, voter, and category |

UUID primary keys, foreign keys, allowed-value checks, and cascading deletion of
group-owned data are defined in the migration. Votes accept scores from 1–5.
Anonymous entry numbers are nullable until voting starts and unique within a
competition; assigning them is deferred. Category-specific score limits and
ensuring an entry and category belong to the same competition must be enforced
when implementing voting.

## Planned lifecycle

The planned lifecycle is:

```text
draft → submission → voting → review_pending → completed
```

Live events advance through admin controls; remote events will use deadlines.
Random numbering, deadline jobs, vote locking, moderation, result aggregation,
and Realtime subscriptions are intentionally left for future implementation.
