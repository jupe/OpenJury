begin;

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  primary key (group_id, user_id)
);

create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null,
  event_type text not null check (event_type in ('live', 'remote')),
  status text not null default 'draft'
    check (status in ('draft', 'submission', 'voting', 'review_pending', 'completed')),
  submission_deadline timestamptz,
  voting_deadline timestamptz
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  name text not null,
  max_score integer not null default 5 check (max_score > 0)
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  creator_id uuid not null references auth.users(id),
  title text not null,
  media_urls text[] not null default '{}',
  random_number integer check (random_number > 0),
  is_disqualified boolean not null default false,
  unique (competition_id, random_number)
);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.entries(id) on delete cascade,
  voter_id uuid not null references auth.users(id),
  category_id uuid not null references public.categories(id) on delete cascade,
  score integer not null check (score between 1 and 5),
  unique (entry_id, voter_id, category_id)
);

create index group_members_user_id_idx on public.group_members(user_id);
create index competitions_group_id_idx on public.competitions(group_id);
create index categories_competition_id_idx on public.categories(competition_id);
create index votes_category_id_idx on public.votes(category_id);

-- Deny API access until tenant-aware policies and a safe blind-voting projection exist.
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.competitions enable row level security;
alter table public.categories enable row level security;
alter table public.entries enable row level security;
alter table public.votes enable row level security;

commit;
