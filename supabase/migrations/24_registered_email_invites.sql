begin;

-- Email invitations are for addresses that do not yet have an account.
-- Pending invitations remain idempotent so admins can resend their email.
create or replace function public.invite_group_member_by_email(p_group_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(p_email));
begin
  perform public.require_group_admin(p_group_id);
  if normalized_email is null
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+$'
     or char_length(normalized_email) > 320 then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if exists (
    select 1 from auth.users as account
    where lower(account.email) = normalized_email
  ) then
    raise exception 'This email is already registered. Use an invite link instead.'
      using errcode = 'P0001';
  end if;
  insert into public.group_email_invites (group_id, email, invited_by)
  values (p_group_id, normalized_email, auth.uid())
  on conflict (group_id, email) do nothing;
end;
$$;

commit;
