-- AI usage tracker tables. Paste into Supabase → SQL Editor → Run.
-- Safe to run in the same project as Homebase; it only adds two tables.

create table if not exists usage_buckets (
  machine     text not null,
  provider    text not null,
  account     text not null,
  model       text not null,
  hour        timestamptz not null,
  input       bigint not null default 0,
  output      bigint not null default 0,
  cache_read  bigint not null default 0,
  cache_write bigint not null default 0,
  messages    integer not null default 0,
  updated_at  timestamptz default now(),
  primary key (machine, provider, account, model, hour)
);
create index if not exists usage_buckets_hour on usage_buckets (hour);

create table if not exists usage_state (
  key        text primary key,
  data       jsonb,
  updated_at timestamptz default now()
);

alter table usage_buckets enable row level security;
alter table usage_state enable row level security;

drop policy if exists "tracker access" on usage_buckets;
create policy "tracker access" on usage_buckets for all using (true) with check (true);
drop policy if exists "tracker access" on usage_state;
create policy "tracker access" on usage_state for all using (true) with check (true);
