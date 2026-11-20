-- Discogs import bookkeeping.
--
-- One row per Discogs collection item (instance) that was imported or that
-- you chose to skip, so running the import again never adds it twice and the
-- import page can show what's left. Discogs gives every item in a collection
-- its own instance id, so owning the same release twice is two rows.
--
-- The import itself goes through save_physical_copy() like any other add;
-- this table only remembers where a copy came from.

create table public.discogs_imports (
  owner_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  instance_id         bigint not null check (instance_id > 0),
  release_id          bigint not null check (release_id > 0),
  physical_copy_id    uuid,
  status              text not null check (status in ('imported', 'skipped')),
  created_at          timestamptz not null default now(),
  primary key (owner_id, instance_id),
  -- A skipped item never points at a copy (an imported one can lose its copy, see below).
  check (status = 'imported' or physical_copy_id is null),
  -- Owner-aware FK (see the listening migration). Deleting the copy keeps the
  -- row, unlinked, so the item doesn't silently reappear as "new" next import.
  foreign key (physical_copy_id, owner_id)
    references public.physical_copies (id, owner_id) on delete set null (physical_copy_id)
);

create index discogs_imports_copy_idx on public.discogs_imports (physical_copy_id);

alter table public.discogs_imports enable row level security;
create policy "owner can do everything" on public.discogs_imports
  for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
revoke all on public.discogs_imports from anon;
grant select, insert, update, delete on public.discogs_imports to authenticated;
