# Security boundary and next steps

[Project overview](../README.md) · [Database](database.md) · [Deployment isolation](deployment.md#prepare-self-hosted-infrastructure)

**Row Level Security is enabled on all six tables with no access policies.**
Anonymous and authenticated API clients therefore have no row access by
default. This is intentional: do not expose data or add permissive policies
just to make the placeholders functional.

Before enabling real functionality:

1. Implement Auth and group membership checks, including admin authorization.
2. Add tenant-aware RLS policies based on `auth.uid()` and group membership.
3. Provide a safe blind-voting view or RPC that omits `creator_id` and `title`
   for non-admins until results are published. **RLS filters rows, not columns**;
   RLS alone cannot hide those fields while exposing the same entry row.
4. Enforce voter identity, membership, competition/category consistency,
   category score limits, voting status, and deadlines in the database.
5. Add private Storage buckets and appropriate upload/read policies.
6. Implement lifecycle transitions, results publishing, and Realtime updates
   only after the access model is secured.

Operational safeguards are covered alongside the procedures they protect:
[public client configuration](development.md#2-configure-supabase),
[merge protection](ci-cd.md#enable-merge-protection-first),
[automation permissions](automation.md), [deployment isolation](deployment.md),
and [Proxmox trust boundaries](proxmox.md#prerequisites-and-trust-boundaries).
