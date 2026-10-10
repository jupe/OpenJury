begin;

alter table public.web_push_subscriptions
  drop constraint web_push_subscriptions_endpoint_check,
  add constraint web_push_subscriptions_endpoint_check check (
    length(endpoint) <= 2048 and endpoint ~ '^https://(([a-z0-9-]+\.)+push\.apple\.com/[^[:space:]\\#]+|fcm\.googleapis\.com/(fcm/send|wp)/[^[:space:]\\#?]+)$'
  );

create or replace function public.save_my_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_locale text)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_endpoint is null or length(p_endpoint) > 2048
    or p_endpoint !~ '^https://(([a-z0-9-]+\.)+push\.apple\.com/[^[:space:]\\#]+|fcm\.googleapis\.com/(fcm/send|wp)/[^[:space:]\\#?]+)$'
    or not public.valid_push_key(p_p256dh, 65)
    or not public.valid_push_key(p_auth, 16)
    or p_locale is null or p_locale not in ('en', 'fi') then
    raise exception 'Invalid subscription' using errcode = '22023';
  end if;
  -- Serialize even concurrent registrations for this user; no cap race.
  perform 1 from auth.users where id = actor for update;
  if exists (select 1 from public.web_push_subscriptions where endpoint = p_endpoint and user_id <> actor) then
    raise exception 'Endpoint unavailable' using errcode = '23505';
  end if;
  if not exists (select 1 from public.web_push_subscriptions where endpoint = p_endpoint and user_id = actor)
    and (select count(*) from public.web_push_subscriptions where user_id = actor) >= 5 then
    raise exception 'Subscription limit reached' using errcode = '54000';
  end if;
  insert into public.web_push_subscriptions(user_id, endpoint, p256dh, auth, locale)
    values (actor, p_endpoint, p_p256dh, p_auth, p_locale)
    on conflict (endpoint) do update
      set p256dh = excluded.p256dh, auth = excluded.auth, locale = excluded.locale,
        revision = gen_random_uuid()
      where public.web_push_subscriptions.user_id = actor;
  if not found then
    raise exception 'Endpoint unavailable' using errcode = '23505';
  end if;
end;
$$;

commit;
