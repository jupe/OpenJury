begin;

-- Recreating the RPC in migration 14 restored Supabase's default service-role
-- grant. Restore the original restriction for already-migrated deployments.
revoke all on function public.get_published_competition_results(uuid)
  from public, anon, service_role;
grant execute on function public.get_published_competition_results(uuid)
  to authenticated;

commit;
