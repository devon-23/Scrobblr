-- Explicit table privileges for signed-in users.
--
-- The earlier migrations relied on Supabase granting new tables to the API
-- roles automatically. Projects that don't do that (yours) answer every query
-- with "permission denied for table …". Grant exactly what the app needs to
-- `authenticated`; Row Level Security still limits each user to their own rows.
-- `anon` (signed out) keeps no access at all.

grant usage on schema public to authenticated;

grant select, insert, update, delete on table
  public.albums,
  public.physical_copies,
  public.tracks,
  public.copy_sides,
  public.copy_tracks,
  public.listening_sessions,
  public.session_events,
  public.session_plays
to authenticated;

-- Already granted in the library migration; repeated so this file alone
-- describes everything the API role can do.
grant execute on function public.save_physical_copy(jsonb) to authenticated;
grant execute on function public.delete_physical_copy(uuid) to authenticated;
