-- Phase 6: statistics about physical listening, computed from our own data
-- (session_plays + listening_sessions), not from Last.fm.
--
-- "Played" means a play that counts by Last.fm's rule (session_plays.counts),
-- whether or not it was actually sent (dry run, scrobbling off, not connected).
-- "Scrobbled" means Last.fm accepted it (scrobbles.status = 'accepted').
--
-- security invoker: Row Level Security applies, so this only ever sees the
-- caller's rows. p_since limits plays to a period (null = all time); p_tz is
-- the caller's IANA time zone so months split at local midnight.

create function public.listening_stats(p_since timestamptz default null, p_tz text default 'UTC')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with counted as (
    select p.session_id, p.title, p.artist, p.album_title, p.album_artist, p.started_at, p.listened_seconds,
           s.format, s.album_id
      from public.session_plays p
      join public.listening_sessions s on s.id = p.session_id
     where p.counts
       and (p_since is null or p.started_at >= p_since)
  ),
  albums_played as (
    select c.format,
           coalesce(c.album_id::text, lower(c.album_title) || '|' || lower(c.album_artist)) as album_key,
           (array_agg(c.album_id) filter (where c.album_id is not null))[1] as album_id,
           max(c.album_title) as title,
           max(c.album_artist) as artist,
           count(distinct c.session_id) as sessions,
           count(*) as tracks,
           sum(c.listened_seconds) as seconds
      from counted c
     group by 1, 2
  ),
  ranked_albums as (
    select a.*, row_number() over (partition by a.format order by a.sessions desc, a.tracks desc, a.title) as rn
      from albums_played a
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'sessions', (select count(distinct session_id) from counted),
      'tracks', (select count(*) from counted),
      'seconds', (select coalesce(sum(listened_seconds), 0) from counted),
      'albums', (select count(*) from albums_played),
      'artists', (select count(distinct lower(album_artist)) from counted),
      'scrobbled', (select count(*) from public.scrobbles sc
                     where sc.status = 'accepted' and (p_since is null or sc.played_at >= p_since))
    ),
    'by_format', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'format', f.format, 'sessions', f.sessions, 'tracks', f.tracks, 'seconds', f.seconds)
             order by f.format), '[]'::jsonb)
        from (select format, count(distinct session_id) as sessions, count(*) as tracks, sum(listened_seconds) as seconds
                from counted group by format) f
    ),
    'top_albums', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'format', r.format, 'album_id', r.album_id, 'title', r.title, 'artist', r.artist,
               'sessions', r.sessions, 'tracks', r.tracks, 'seconds', r.seconds,
               'artwork_url', (select al.artwork_url from public.albums al where al.id = r.album_id))
             order by r.format, r.rn), '[]'::jsonb)
        from ranked_albums r
       where r.rn <= 10
    ),
    'top_artists', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'artist', t.artist, 'tracks', t.tracks, 'sessions', t.sessions, 'seconds', t.seconds,
               'vinyl', t.vinyl, 'cd', t.cd)
             order by t.tracks desc, t.artist), '[]'::jsonb)
        from (select max(album_artist) as artist, count(*) as tracks, count(distinct session_id) as sessions,
                     sum(listened_seconds) as seconds,
                     count(*) filter (where format = 'vinyl') as vinyl,
                     count(*) filter (where format = 'cd') as cd
                from counted group by lower(album_artist)
               order by count(*) desc, max(album_artist)
               limit 10) t
    ),
    'top_tracks', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'title', t.title, 'artist', t.artist, 'album', t.album, 'plays', t.plays, 'vinyl', t.vinyl, 'cd', t.cd)
             order by t.plays desc, t.title), '[]'::jsonb)
        from (select max(title) as title, max(artist) as artist, max(album_title) as album, count(*) as plays,
                     count(*) filter (where format = 'vinyl') as vinyl,
                     count(*) filter (where format = 'cd') as cd
                from counted group by lower(title), lower(artist)
               order by count(*) desc, max(title)
               limit 15) t
    ),
    'by_month', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'month', to_char(m.month, 'YYYY-MM'), 'tracks', m.tracks, 'sessions', m.sessions,
               'vinyl', m.vinyl, 'cd', m.cd)
             order by m.month), '[]'::jsonb)
        from (select date_trunc('month', started_at at time zone p_tz) as month,
                     count(*) as tracks, count(distinct session_id) as sessions,
                     count(*) filter (where format = 'vinyl') as vinyl,
                     count(*) filter (where format = 'cd') as cd
                from counted group by 1) m
    ),
    'collection', jsonb_build_object(
      'albums', (select count(*) from public.albums),
      'vinyl', (select count(*) from public.physical_copies where format = 'vinyl'),
      'cd', (select count(*) from public.physical_copies where format = 'cd'),
      'tagged', (select count(distinct physical_copy_id) from public.nfc_tags where physical_copy_id is not null)
    )
  );
$$;

revoke execute on function public.listening_stats(timestamptz, text) from public, anon;
grant execute on function public.listening_stats(timestamptz, text) to authenticated;
