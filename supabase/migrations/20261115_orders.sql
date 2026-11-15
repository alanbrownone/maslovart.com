-- Online orders (Stripe Checkout). Rows are written only by the "stripe-webhook" edge function
-- (service role) after Stripe confirms the payment. Signed-in admin users can read them and
-- update the status / notes in admin > Orders. Nothing here is readable by the public.
create table if not exists public.orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  stripe_session_id text not null unique,
  payment_intent text,
  livemode boolean not null default false,
  status text not null default 'paid' check (status in ('paid', 'shipped', 'cancelled')),
  customer_name text,
  email text,
  phone text,
  ship_name text,
  ship_address jsonb,
  items jsonb not null default '[]'::jsonb,
  subtotal_cents integer not null default 0,
  shipping_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  currency text not null default 'usd',
  emails_sent boolean not null default false,
  notes text,
  shipped_at timestamptz
);
alter table public.orders enable row level security;
drop policy if exists "admins read orders" on public.orders;
create policy "admins read orders" on public.orders for select to authenticated using (public.is_admin());
drop policy if exists "admins update orders" on public.orders;
create policy "admins update orders" on public.orders for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Vintage prints are one of a kind: once paid for, the print's photo address is listed here and the
-- site shows it as Sold. The list holds only photo addresses, so anyone may read it.
-- Admin users can remove a row ("Make available again").
create table if not exists public.vintage_sold (
  src text primary key,
  order_id bigint references public.orders(id) on delete set null,
  sold_at timestamptz not null default now()
);
alter table public.vintage_sold enable row level security;
drop policy if exists "anyone reads sold list" on public.vintage_sold;
create policy "anyone reads sold list" on public.vintage_sold for select to anon, authenticated using (true);
drop policy if exists "admins delete sold" on public.vintage_sold;
create policy "admins delete sold" on public.vintage_sold for delete to authenticated using (public.is_admin());
grant select on public.vintage_sold to anon, authenticated;
grant delete on public.vintage_sold to authenticated;
grant select, update on public.orders to authenticated;
