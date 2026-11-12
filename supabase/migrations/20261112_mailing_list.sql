-- Mailing list with double opt-in (maslovart.com).
-- Signups start as 'pending'; only pressing "Yes, add me to the list" on the confirm page makes them 'confirmed'.
create table if not exists public.subscribers (
  id bigint generated always as identity primary key,
  email text not null unique check (email = lower(email)),
  name text,
  status text not null default 'pending' check (status in ('pending','confirmed','unsubscribed')),
  token_hash text,             -- sha256 of the one-time confirm token (the token itself is only in the email)
  token_expires_at timestamptz,
  last_sent_at timestamptz,
  unsub_hash text,             -- sha256 of the unsubscribe token, set when confirmed
  ip_hash text,
  page text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz
);
create index if not exists subscribers_token_hash_idx on public.subscribers(token_hash);
create index if not exists subscribers_unsub_hash_idx on public.subscribers(unsub_hash);
alter table public.subscribers enable row level security;
create policy "Admins can read subscribers" on public.subscribers for select using (public.is_admin());
create policy "Admins can delete subscribers" on public.subscribers for delete using (public.is_admin());

-- Every signup attempt, for the limit per visitor (hashed IP). Only the "subscribe" function uses it.
create table if not exists public.signup_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists signup_attempts_ip_idx on public.signup_attempts(ip_hash, created_at);
alter table public.signup_attempts enable row level security;
