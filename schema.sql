-- Run once in Supabase > SQL Editor
create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique not null,
  email text not null,
  nickname text not null,
  sid text not null,
  cred_enc text,                       -- encrypted outside-account password (bot-only)
  tokens int not null default 1,       -- 1 free trial token
  status text not null default 'active', -- active | paused | revoked
  created_at timestamptz default now()
);
create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  status text not null default 'running', -- running | done | failed
  created_at timestamptz default now()
);
create table requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  kind text not null,                  -- schedule | help
  message text,
  run_at timestamptz,
  status text not null default 'pending', -- pending | approved | denied
  created_at timestamptz default now()
);
create table schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  run_at timestamptz not null,
  override boolean not null default false,
  status text not null default 'pending', -- pending | fired
  created_at timestamptz default now()
);
create table codes (hash text primary key, n int);   -- only hashes of token codes
create table settings (key text primary key, value text);

-- Lock everything: only the server (service key) may touch these tables
alter table users enable row level security;
alter table jobs enable row level security;
alter table requests enable row level security;
alter table schedules enable row level security;
alter table codes enable row level security;
alter table settings enable row level security;

create or replace function use_token(uid uuid) returns boolean language plpgsql as $$
begin
  update users set tokens = tokens - 1 where id = uid and tokens > 0 and status = 'active';
  return found;
end $$;
create or replace function add_token(uid uuid, amt int) returns void language sql as $$
  update users set tokens = tokens + amt where id = uid;
$$;
revoke execute on function use_token(uuid), add_token(uuid,int) from anon, authenticated, public;
revoke execute on function add_token(uuid,int) from anon, authenticated, public;
