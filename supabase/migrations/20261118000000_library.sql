-- Phase 2: physical music library
--
-- albums ─┬─< physical_copies ─< copy_sides ─< copy_tracks >─ tracks >─┐
--         └────────────────────────────────────────────────────────────┘
--
-- * albums          one per musical work (MusicBrainz release group)
-- * physical_copies one per thing on your shelf (MusicBrainz release), vinyl or CD
-- * tracks          songs of an album, shared by all copies (MusicBrainz recording)
-- * copy_sides      ordered sides of a copy: "A", "B" for vinyl, "Disc 1" for CDs
-- * copy_tracks     which track plays at which position on which side of a copy,
--                   with an optional per-edition duration override
--
-- Every table carries owner_id so Row Level Security can restrict rows to the
-- signed-in user. Composite foreign keys make it impossible for a copy_track to
-- point at a side of a different copy, or a track of a different album.

create type public.media_format as enum ('vinyl', 'cd');

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create function public.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- albums
-- ---------------------------------------------------------------------------
create table public.albums (
  id                            uuid primary key default gen_random_uuid(),
  owner_id                      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title                         text not null check (length(btrim(title)) between 1 and 500),
  artist                        text not null check (length(btrim(artist)) between 1 and 500),
  album_artist                  text check (album_artist is null or length(btrim(album_artist)) between 1 and 500),
  release_year                  smallint check (release_year between 1880 and 2100),
  artwork_url                   text check (artwork_url is null or artwork_url ~ '^https://'),
  musicbrainz_release_group_id  uuid,
  musicbrainz_artist_id         uuid,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

comment on column public.albums.album_artist is 'NULL means same as artist.';

-- One album entry per MusicBrainz release group per user: owning Blurryface on
-- CD and vinyl gives one album with two copies, never two albums.
create unique index albums_owner_release_group_key
  on public.albums (owner_id, musicbrainz_release_group_id)
  where musicbrainz_release_group_id is not null;
create index albums_owner_created_idx on public.albums (owner_id, created_at desc);

create trigger albums_updated_at before update on public.albums
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- physical_copies
-- ---------------------------------------------------------------------------
create table public.physical_copies (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade,
  album_id                 uuid not null references public.albums (id) on delete cascade,
  format                   public.media_format not null,
  edition_name             text check (edition_name is null or length(edition_name) <= 200),
  label                    text check (label is null or length(label) <= 200),
  catalog_number           text check (catalog_number is null or length(catalog_number) <= 100),
  barcode                  text check (barcode is null or barcode ~ '^[0-9A-Za-z -]{1,40}$'),
  release_country          text check (release_country is null or length(release_country) <= 10),
  release_year             smallint check (release_year between 1880 and 2100),
  artwork_url              text check (artwork_url is null or artwork_url ~ '^https://'),
  musicbrainz_release_id   uuid,
  notes                    text check (notes is null or length(notes) <= 2000),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (id, album_id)    -- target for copy_tracks' composite FK
);

create index physical_copies_album_idx on public.physical_copies (album_id);
create index physical_copies_owner_idx on public.physical_copies (owner_id);

create trigger physical_copies_updated_at before update on public.physical_copies
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tracks (album-level; shared across copies)
-- ---------------------------------------------------------------------------
create table public.tracks (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  album_id                  uuid not null references public.albums (id) on delete cascade,
  title                     text not null check (length(btrim(title)) between 1 and 500),
  artist                    text not null check (length(btrim(artist)) between 1 and 500),
  duration_seconds          integer check (duration_seconds between 1 and 86399),
  musicbrainz_recording_id  uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (id, album_id)     -- target for copy_tracks' composite FK
);

comment on column public.tracks.duration_seconds is
  'Default duration. A copy can override it in copy_tracks.duration_override. NULL = unknown.';

-- The same recording on CD and vinyl is the same track row, so play counts merge.
create unique index tracks_album_recording_key
  on public.tracks (album_id, musicbrainz_recording_id)
  where musicbrainz_recording_id is not null;
create index tracks_owner_idx on public.tracks (owner_id);

create trigger tracks_updated_at before update on public.tracks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- copy_sides
-- ---------------------------------------------------------------------------
create table public.copy_sides (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  physical_copy_id   uuid not null references public.physical_copies (id) on delete cascade,
  position           smallint not null check (position between 1 and 52),
  label              text not null check (length(btrim(label)) between 1 and 20),
  unique (physical_copy_id, position) deferrable initially deferred,
  unique (physical_copy_id, label) deferrable initially deferred,
  unique (id, physical_copy_id)  -- target for copy_tracks' composite FK
);

create index copy_sides_owner_idx on public.copy_sides (owner_id);

-- ---------------------------------------------------------------------------
-- copy_tracks
-- ---------------------------------------------------------------------------
create table public.copy_tracks (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  physical_copy_id   uuid not null,
  album_id           uuid not null,
  side_id            uuid not null,
  track_id           uuid not null,
  position           smallint not null check (position between 1 and 200),
  display_number     text check (display_number is null or length(display_number) <= 10),
  duration_override  integer check (duration_override between 1 and 86399),
  foreign key (physical_copy_id, album_id) references public.physical_copies (id, album_id) on delete cascade,
  foreign key (side_id, physical_copy_id) references public.copy_sides (id, physical_copy_id) on delete cascade,
  -- NO ACTION (not RESTRICT) so deleting a whole album, which cascades to both
  -- copy_tracks and tracks, succeeds; deleting a track still in use fails.
  foreign key (track_id, album_id) references public.tracks (id, album_id),
  unique (side_id, position) deferrable initially deferred
);

comment on column public.copy_tracks.display_number is 'As printed on the sleeve, e.g. "A1" or "3".';

create index copy_tracks_copy_idx on public.copy_tracks (physical_copy_id);
create index copy_tracks_track_idx on public.copy_tracks (track_id);
create index copy_tracks_owner_idx on public.copy_tracks (owner_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: each user sees and changes only their own rows.
-- anon gets nothing at all.
-- ---------------------------------------------------------------------------
alter table public.albums          enable row level security;
alter table public.physical_copies enable row level security;
alter table public.tracks          enable row level security;
alter table public.copy_sides      enable row level security;
alter table public.copy_tracks     enable row level security;

create policy "owner can do everything" on public.albums
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner can do everything" on public.physical_copies
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner can do everything" on public.tracks
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner can do everything" on public.copy_sides
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner can do everything" on public.copy_tracks
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

revoke all on public.albums, public.physical_copies, public.tracks, public.copy_sides, public.copy_tracks from anon;

-- ---------------------------------------------------------------------------
-- save_physical_copy: create or update a copy and replace its whole tracklist
-- in ONE transaction, so a half-saved tracklist can never exist.
--
-- Runs as the caller (SECURITY INVOKER), so RLS applies to every statement.
--
-- p = {
--   "copy_id": uuid | null,              -- null = create a new copy
--   "album":   { "id"?, "title", "artist", "album_artist"?, "release_year"?,
--                "artwork_url"?, "musicbrainz_release_group_id"?, "musicbrainz_artist_id"? },
--   "copy":    { "format", "edition_name"?, "label"?, "catalog_number"?, "barcode"?,
--                "release_country"?, "release_year"?, "artwork_url"?,
--                "musicbrainz_release_id"?, "notes"? },
--   "sides":   [ { "label", "tracks": [ { "track_id"?, "title", "artist",
--                  "duration_seconds"?, "musicbrainz_recording_id"?, "display_number"? } ] } ]
-- }
--
-- Album fields are only used when a NEW album is created; edit existing albums
-- with a normal UPDATE. Track title/artist edits apply to the shared track row.
-- A track's duration is stored on the track unless another copy already uses
-- that track with a different duration, in which case it becomes this copy's
-- duration_override.
-- ---------------------------------------------------------------------------
create function public.save_physical_copy(p jsonb) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_album      jsonb := coalesce(p -> 'album', '{}'::jsonb);
  v_copy       jsonb := coalesce(p -> 'copy', '{}'::jsonb);
  v_sides      jsonb := coalesce(p -> 'sides', '[]'::jsonb);
  v_album_id   uuid;
  v_copy_id    uuid := nullif(p ->> 'copy_id', '')::uuid;
  v_rg_id      uuid := nullif(v_album ->> 'musicbrainz_release_group_id', '')::uuid;
  v_side       jsonb;
  v_side_pos   int := 0;
  v_side_id    uuid;
  v_track      jsonb;
  v_track_pos  int;
  v_track_id   uuid;
  v_rec_id     uuid;
  v_duration   int;
  v_existing   public.tracks%rowtype;
  v_override   int;
  v_total      int := 0;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if jsonb_typeof(v_sides) <> 'array' then
    raise exception 'sides must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(v_sides) > 52 then
    raise exception 'Too many sides (max 52)' using errcode = '22023';
  end if;

  -- 1. Resolve the album -----------------------------------------------------
  if v_copy_id is not null then
    select album_id into v_album_id from public.physical_copies where id = v_copy_id;
    if v_album_id is null then
      raise exception 'Copy % not found', v_copy_id using errcode = 'P0002';
    end if;
  elsif nullif(v_album ->> 'id', '') is not null then
    select id into v_album_id from public.albums where id = (v_album ->> 'id')::uuid;
    if v_album_id is null then
      raise exception 'Album % not found', v_album ->> 'id' using errcode = 'P0002';
    end if;
  else
    if v_rg_id is not null then
      select id into v_album_id from public.albums
        where owner_id = v_uid and musicbrainz_release_group_id = v_rg_id;
    end if;
    if v_album_id is null then
      insert into public.albums (title, artist, album_artist, release_year, artwork_url,
                                 musicbrainz_release_group_id, musicbrainz_artist_id)
      values (
        btrim(v_album ->> 'title'),
        btrim(v_album ->> 'artist'),
        nullif(btrim(v_album ->> 'album_artist'), ''),
        nullif(v_album ->> 'release_year', '')::smallint,
        nullif(v_album ->> 'artwork_url', ''),
        v_rg_id,
        nullif(v_album ->> 'musicbrainz_artist_id', '')::uuid
      )
      returning id into v_album_id;
    end if;
  end if;

  -- 2. Create or update the copy --------------------------------------------
  if v_copy_id is null then
    insert into public.physical_copies (album_id, format) values (v_album_id, (v_copy ->> 'format')::public.media_format)
      returning id into v_copy_id;
  end if;

  update public.physical_copies set
    format                 = (v_copy ->> 'format')::public.media_format,
    edition_name           = nullif(btrim(v_copy ->> 'edition_name'), ''),
    label                  = nullif(btrim(v_copy ->> 'label'), ''),
    catalog_number         = nullif(btrim(v_copy ->> 'catalog_number'), ''),
    barcode                = nullif(btrim(v_copy ->> 'barcode'), ''),
    release_country        = nullif(btrim(v_copy ->> 'release_country'), ''),
    release_year           = nullif(v_copy ->> 'release_year', '')::smallint,
    artwork_url            = nullif(v_copy ->> 'artwork_url', ''),
    musicbrainz_release_id = nullif(v_copy ->> 'musicbrainz_release_id', '')::uuid,
    notes                  = nullif(btrim(v_copy ->> 'notes'), '')
  where id = v_copy_id;

  -- 3. Replace the tracklist -------------------------------------------------
  delete from public.copy_sides where physical_copy_id = v_copy_id;  -- cascades to copy_tracks

  for v_side in select value from jsonb_array_elements(v_sides) loop
    v_side_pos := v_side_pos + 1;
    insert into public.copy_sides (physical_copy_id, position, label)
      values (v_copy_id, v_side_pos, btrim(v_side ->> 'label'))
      returning id into v_side_id;

    v_track_pos := 0;
    for v_track in select value from jsonb_array_elements(coalesce(v_side -> 'tracks', '[]'::jsonb)) loop
      v_track_pos := v_track_pos + 1;
      v_total := v_total + 1;
      if v_total > 400 then
        raise exception 'Too many tracks (max 400)' using errcode = '22023';
      end if;

      v_track_id := nullif(v_track ->> 'track_id', '')::uuid;
      v_rec_id   := nullif(v_track ->> 'musicbrainz_recording_id', '')::uuid;
      v_duration := nullif(v_track ->> 'duration_seconds', '')::int;
      v_override := null;

      -- Reuse an existing album track by id, or by MusicBrainz recording.
      v_existing := null;
      if v_track_id is not null then
        select * into v_existing from public.tracks where id = v_track_id and album_id = v_album_id;
        if v_existing.id is null then
          raise exception 'Track % does not belong to this album', v_track_id using errcode = '22023';
        end if;
      elsif v_rec_id is not null then
        select * into v_existing from public.tracks where album_id = v_album_id and musicbrainz_recording_id = v_rec_id;
      end if;

      if v_existing.id is null then
        insert into public.tracks (album_id, title, artist, duration_seconds, musicbrainz_recording_id)
          values (v_album_id, btrim(v_track ->> 'title'), btrim(v_track ->> 'artist'), v_duration, v_rec_id)
          returning id into v_track_id;
      else
        v_track_id := v_existing.id;
        if v_duration is not null
           and v_existing.duration_seconds is not null
           and v_duration <> v_existing.duration_seconds
           and exists (select 1 from public.copy_tracks
                       where track_id = v_track_id and physical_copy_id <> v_copy_id) then
          -- Another copy relies on the shared duration: keep it, override here.
          v_override := v_duration;
          v_duration := v_existing.duration_seconds;
        end if;
        update public.tracks set
          title            = btrim(v_track ->> 'title'),
          artist           = btrim(v_track ->> 'artist'),
          duration_seconds = coalesce(v_duration, duration_seconds)
        where id = v_track_id;
      end if;

      insert into public.copy_tracks (physical_copy_id, album_id, side_id, track_id, position,
                                      display_number, duration_override)
        values (v_copy_id, v_album_id, v_side_id, v_track_id, v_track_pos,
                nullif(btrim(v_track ->> 'display_number'), ''), v_override);
    end loop;
  end loop;

  -- 4. Remove album tracks no copy uses any more.
  -- NOTE (Phase 3): listening history will also reference tracks; extend this
  -- NOT EXISTS so played tracks are never deleted.
  delete from public.tracks t
  where t.album_id = v_album_id
    and not exists (select 1 from public.copy_tracks ct where ct.track_id = t.id);

  return v_copy_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_physical_copy: delete a copy, tidy unused tracks, and delete the album
-- too if this was its last copy. Returns true if the album was deleted.
-- ---------------------------------------------------------------------------
create function public.delete_physical_copy(p_copy_id uuid) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_album_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  delete from public.physical_copies where id = p_copy_id returning album_id into v_album_id;
  if v_album_id is null then
    raise exception 'Copy % not found', p_copy_id using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.physical_copies where album_id = v_album_id) then
    delete from public.albums where id = v_album_id;
    return true;
  end if;

  delete from public.tracks t
  where t.album_id = v_album_id
    and not exists (select 1 from public.copy_tracks ct where ct.track_id = t.id);
  return false;
end;
$$;

revoke execute on function public.save_physical_copy(jsonb) from public, anon;
revoke execute on function public.delete_physical_copy(uuid) from public, anon;
grant execute on function public.save_physical_copy(jsonb) to authenticated;
grant execute on function public.delete_physical_copy(uuid) to authenticated;
