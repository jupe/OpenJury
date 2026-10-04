# OpenJury

OpenJury is a starter architecture for a serverless, real-time, multi-tenant
competition and blind-voting platform. Communities create isolated **groups** and
host competitions such as baking contests, karaoke nights, or hackathons. Each
competition has configurable grading categories, participant entries, and votes.
Events can be live (synchronous) or remote (asynchronous).

The planned experience spans group membership, submissions, anonymous voting,
admin review, and published results. Live events advance through admin controls;
remote events use deadlines.

## Current status

This repository is **scaffolding, not a working voting service**. Pages contain
placeholder UI; no authentication, database queries, media uploads, voting,
moderation, or lifecycle automation is implemented.

It includes shared UI components, an initial database schema, and CI/CD and
infrastructure tooling. Database access is deny-by-default; real features need
the [security prerequisites](docs/security.md) implemented first.

## Tech stack

- **Next.js App Router**, React, and TypeScript for pages and application structure.
- **Tailwind CSS** for styling shared UI components.
- **Supabase**: PostgreSQL database, Auth (planned magic links / OAuth), Storage
  (planned entry media), and Realtime (planned state updates).
- **Deployment**: Docker images with optional GitHub Actions deployments to
  self-hosted Docker hosts; Supabase Cloud for the persistent backend.

## Documentation

Start with [local development](docs/development.md) to run the placeholder app.
All setup commands and detailed operational guidance live in the topic guides:

- [Local development](docs/development.md) — tool versions, commands, Supabase
  configuration, and schema setup.
- [Architecture](docs/architecture.md) — project structure and placeholder routes.
- [Database](docs/database.md) — tables, constraints, and planned event lifecycle.
- [Security](docs/security.md) — RLS boundary and prerequisites for real features.
- [CI/CD](docs/ci-cd.md) — delivery flow, tested-image promotion, and merge protection.
- [Automation](docs/automation.md) — reviewed minor-PR merging and deployment notifications.
- [Deployment](docs/deployment.md) — Docker, runtime configuration, infrastructure,
  environments, preview cleanup, and recovery.
- [Proxmox VM setup](docs/proxmox.md) — provisioning, isolation, DNS/TLS, runners,
  backups, and recovery.
