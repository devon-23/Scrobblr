-- Phase 5: NFC tags.
--
-- A sticker holds https://<app>/t/<token>. The token is random and means
-- nothing on its own; this table maps it to a physical copy. Keeping the
-- mapping here (not in the sticker) means a tag can be moved to another copy,
-- or a lost sticker replaced, without rewriting anything.
--
-- * physical_copy_id is null for a tag that isn't linked to anything (yet, or
--   any more: deleting a copy unlinks its tags so the stickers can be reused).
-- * A copy may have several tags (e.g. one on the jacket, one on the sleeve).
-- * Tokens are unique across the whole table, and only the owner can read a
--   row, so knowing a token without being signed in reveals nothing.

create table public.nfc_tags (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token             text not null unique check (token ~ '^[A-Za-z0-9_-]{16,64}$'),
  physical_copy_id  uuid,
  created_at        timestamptz not null default now(),
  assigned_at       timestamptz,
  last_scanned_at   timestamptz,
  scan_count        integer not null default 0 check (scan_count >= 0),
  -- Owner-aware FK (see the listening migration): a tag can only point at one
  -- of its owner's own copies. Deleting the copy unlinks the tag.
  foreign key (physical_copy_id, owner_id)
    references public.physical_copies (id, owner_id) on delete set null (physical_copy_id)
);

create index nfc_tags_physical_copy_id_idx on public.nfc_tags (physical_copy_id);

alter table public.nfc_tags enable row level security;
create policy "owner can do everything" on public.nfc_tags
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.nfc_tags from anon;
grant select, insert, update, delete on public.nfc_tags to authenticated;

-- Looks up a scanned token and records the scan in one round trip.
-- Returns no row if the token is unknown (or belongs to someone else: RLS).
create function public.scan_nfc_tag(p_token text)
returns table (tag_id uuid, copy_id uuid)
language sql
security invoker
set search_path = ''
as $$
  update public.nfc_tags t
     set last_scanned_at = now(), scan_count = t.scan_count + 1
   where t.token = p_token
  returning t.id, t.physical_copy_id;
$$;

revoke execute on function public.scan_nfc_tag(text) from public, anon;
grant execute on function public.scan_nfc_tag(text) to authenticated;
