-- Phase 4: Last.fm
--
-- * lastfm_accounts  the Last.fm session key per user. The browser can NEVER
--                    read this table; only the lastfm Edge Function (service
--                    role) can. The browser sees username/status through
--                    lastfm_connection().
-- * user_settings    scrobbling on/off and dry-run (default ON: nothing is sent
--                    to Last.fm until the user turns dry-run off).
-- * scrobbles        the submission queue. One row per play that counts and is
--                    final, created by a trigger, unique per (session, seq) — so
--                    the same listen can never be queued twice. Only the Edge
--                    Function changes it; the browser can read it to show status.

create table public.lastfm_accounts (
  owner_id      uuid primary key references auth.users (id) on delete cascade,
  username      text not null check (length(username) between 1 and 100),
  session_key   text not null check (length(session_key) between 1 and 200),
  needs_reauth  boolean not null default false,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger lastfm_accounts_updated_at before update on public.lastfm_accounts
  for each row execute function public.set_updated_at();

alter table public.lastfm_accounts enable row level security;
-- Deliberately no policies and no grants: signed-in users can't read session keys.
revoke all on public.lastfm_accounts from anon, authenticated;

/** Username and status of the caller's Last.fm connection, without the session key. */
create function public.lastfm_connection()
returns table (username text, needs_reauth boolean, connected_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.username, a.needs_reauth, a.connected_at
  from public.lastfm_accounts a
  where a.owner_id = auth.uid()
$$;

revoke execute on function public.lastfm_connection() from public, anon;
grant execute on function public.lastfm_connection() to authenticated;

-- ---------------------------------------------------------------------------
create table public.user_settings (
  owner_id            uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  scrobbling_enabled  boolean not null default true,
  dry_run             boolean not null default true,
  updated_at          timestamptz not null default now()
);

create trigger user_settings_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;
create policy "owner can do everything" on public.user_settings
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.user_settings from anon;
grant select, insert, update on public.user_settings to authenticated;

-- ---------------------------------------------------------------------------
create table public.scrobbles (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  session_id        uuid not null,
  seq               integer not null,
  artist            text not null,
  track             text not null,
  album             text not null,
  album_artist      text not null,
  duration_seconds  integer not null,
  track_number      smallint,
  mbid              uuid,
  -- When the track STARTED playing (what Last.fm wants), not when it was sent.
  played_at         timestamptz not null,
  status            text not null default 'pending'
                    check (status in ('pending', 'submitting', 'accepted', 'ignored', 'failed', 'dry_run', 'disabled')),
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error        text,
  last_error_code   integer,
  -- Last.fm's per-scrobble reply (corrections, ignored reason).
  lastfm_response   jsonb,
  submitted_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (session_id, seq),
  foreign key (session_id, seq) references public.session_plays (session_id, seq) on delete cascade
);

create index scrobbles_owner_queue_idx on public.scrobbles (owner_id, status, next_attempt_at);
create index scrobbles_owner_played_idx on public.scrobbles (owner_id, played_at desc);

create trigger scrobbles_updated_at before update on public.scrobbles
  for each row execute function public.set_updated_at();

alter table public.scrobbles enable row level security;
create policy "owner can read" on public.scrobbles
  for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.scrobbles from anon, authenticated;
grant select on public.scrobbles to authenticated;

-- Queue a scrobble the moment a play both counts and is final. Runs as the
-- table owner so it can write the queue the browser can't. ON CONFLICT makes
-- re-uploads of the same play harmless.
create function public.queue_scrobble() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.counts and new.final then
    insert into public.scrobbles (owner_id, session_id, seq, artist, track, album, album_artist,
                                  duration_seconds, track_number, mbid, played_at)
    select new.owner_id, new.session_id, new.seq, new.artist, new.title, new.album_title, new.album_artist,
           new.duration_seconds, new.track_position,
           (select t.musicbrainz_recording_id from public.tracks t where t.id = new.track_id),
           new.started_at
    on conflict (session_id, seq) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.queue_scrobble() from public, anon, authenticated;

create trigger session_plays_queue_scrobble
  after insert or update of counts, final on public.session_plays
  for each row execute function public.queue_scrobble();

-- A final play's content is frozen: later uploads of it keep the stored
-- values (silently — a re-sync must never get stuck), so what was queued for
-- Last.fm can't be rewritten. Only the track_id link may still change, which
-- Postgres does itself (SET NULL) when that library track is deleted.
create function public.protect_final_plays() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.final then
    new.side_label       := old.side_label;
    new.track_position   := old.track_position;
    new.title            := old.title;
    new.artist           := old.artist;
    new.album_title      := old.album_title;
    new.album_artist     := old.album_artist;
    new.duration_seconds := old.duration_seconds;
    new.started_at       := old.started_at;
    new.ended_at         := old.ended_at;
    new.listened_seconds := old.listened_seconds;
    new.end_reason       := old.end_reason;
    new.counts           := old.counts;
    new.final            := old.final;
  end if;
  return new;
end;
$$;

create trigger session_plays_protect_final
  before update on public.session_plays
  for each row execute function public.protect_final_plays();

-- ---------------------------------------------------------------------------
-- claim_scrobbles: atomically takes up to p_limit due items for one user and
-- marks them 'submitting', so two flushes running at once can't both send the
-- same scrobble. Items stuck in 'submitting' for 10+ minutes (the function
-- died mid-request) become claimable again — at-least-once, never silently lost.
-- Only the Edge Function (service_role) may call it.
-- ---------------------------------------------------------------------------
create function public.claim_scrobbles(p_owner uuid, p_limit integer)
returns setof public.scrobbles
language sql
security definer
set search_path = ''
as $$
  update public.scrobbles s
  set status = 'submitting', attempts = s.attempts + 1, next_attempt_at = now()
  where s.id in (
    select id from public.scrobbles
    where owner_id = p_owner
      and ((status = 'pending' and next_attempt_at <= now())
           or (status = 'submitting' and updated_at < now() - interval '10 minutes'))
    order by played_at
    limit least(greatest(p_limit, 1), 50)
    for update skip locked
  )
  returning s.*
$$;

revoke execute on function public.claim_scrobbles(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_scrobbles(uuid, integer) to service_role;

-- The lastfm Edge Function runs as service_role. It bypasses RLS but still
-- needs table privileges, which this project doesn't grant automatically.
grant select, insert, update, delete on public.lastfm_accounts to service_role;
grant select, update on public.scrobbles to service_role;
grant select on public.user_settings to service_role;
