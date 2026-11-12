-- "New subscriber" alert emails: each admin user can be switched on or off in admin > Users.
alter table public.admins add column if not exists subscriber_alerts boolean not null default false;
update public.admins set subscriber_alerts = true where role = 'admin';

-- Admins can switch anyone; everyone else only themselves.
create or replace function public.set_subscriber_alerts(target_email text, on_off boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.is_admin() then raise exception 'Not allowed'; end if;
  if public.my_role() <> 'admin' and lower(target_email) <> me then raise exception 'Only an Admin can change this for someone else'; end if;
  update public.admins set subscriber_alerts = on_off where lower(email) = lower(target_email);
end $$;
revoke all on function public.set_subscriber_alerts(text, boolean) from public, anon;
grant execute on function public.set_subscriber_alerts(text, boolean) to authenticated;
