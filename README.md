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

The implementation supports **magic-link sign-in, group creation, draft
competition and category management, private submissions, and anonymous
category-based voting with ballot revisions, admin review and disqualification,
and atomic result publication**, plus group invitations, membership administration,
platform administration, and separate participant/audience competition roles.

It includes shared UI components, database-enforced authorization, and CI/CD
and infrastructure tooling. Entry and vote tables remain inaccessible directly;
private operations use guarded database functions described in the
[security guide](docs/security.md).

## Mobile experience

The interface is mobile-first, with safe-area spacing, large touch targets,
zoom-friendly form fields, and responsive participant and admin screens.
Private image galleries download only when near the viewport; tap **View image**
to inspect an uncropped image and tap again to close it. Uploads support JPEG,
PNG, and WebP (up to five images, 10 MB each).

`npm run test:e2e` exercises the workflows in desktop Chromium, Android Chromium,
and iPhone WebKit, including narrow screens and landscape forms. Browser
emulation does not replace testing on physical phones, particularly for camera
uploads, email-link handoff, on-screen keyboards, and low-memory performance.

## Tech stack

- **Next.js App Router**, React, and TypeScript for pages and application structure.
- **Tailwind CSS** for styling shared UI components.
- **Supabase**: PostgreSQL database, Auth (magic links; OAuth planned), private
  Storage for entry media, and authorized Realtime notifications.
- **Deployment**: tested Docker images published by GitHub-hosted CI; self-hosted
  deployments belong in a separate private deployment repository or controller.
  Supabase may be hosted or self-hosted; Vercel is an optional frontend host.

## Documentation

Start with [local development](docs/development.md) to run and configure the app.
All setup commands and detailed operational guidance live in the topic guides:

- [Local development](docs/development.md) — tool versions, commands, Supabase
  configuration, and schema setup.
- [Architecture](docs/architecture.md) — project structure, session gates, and routes.
- [Database](docs/database.md) — tables, constraints, and planned event lifecycle.
- [Security](docs/security.md) — RLS boundary and prerequisites for real features.
- [CI/CD](docs/ci-cd.md) — delivery flow, tested-image promotion, and merge protection.
- [Automation](docs/automation.md) — reviewed minor-PR merging and deployment notifications.
- [Deployment](docs/deployment.md) — Docker, runtime configuration, infrastructure,
  environments, preview cleanup, and recovery.
- [Proxmox VM setup](docs/proxmox.md) — provisioning, isolation, DNS/TLS, runners,
  backups, and recovery.

## Contributing

Follow [local development](docs/development.md) and open a focused pull request
with a description of the behavior change and tests. Run `npm run lint`,
`npm run typecheck`, and the relevant browser and database tests before submitting.
Use fictional fixtures, not production data, credentials, or private infrastructure
addresses. Workflow, deployment, dependency, and database changes require maintainer
review; passing CI alone does not authorize deployment. Fork contributions run on
GitHub-hosted runners and receive no deployment credentials or automatic previews.

Report suspected vulnerabilities privately using the
[security reporting policy](docs/security.md#reporting-a-vulnerability), not a public
issue. Operators should complete the
[public-release checklist](docs/security.md#before-making-the-repository-public)
before changing repository visibility.
