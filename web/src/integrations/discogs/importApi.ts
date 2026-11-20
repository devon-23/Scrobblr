/** Database side of the Discogs import (RLS: owner only). */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fail } from '../../library/api'
import type { AlbumRow } from '../../library/types'

export interface ImportRecord {
  instance_id: number
  release_id: number
  physical_copy_id: string | null
  status: 'imported' | 'skipped'
}

export async function listImportRecords(supabase: SupabaseClient): Promise<ImportRecord[]> {
  const { data, error } = await supabase.from('discogs_imports').select('instance_id, release_id, physical_copy_id, status')
  if (error) fail(error, 'Loading earlier imports')
  return data as ImportRecord[]
}

/** Remembers that a collection item was imported (or skipped), so it isn't offered again. */
export async function recordImport(supabase: SupabaseClient, r: ImportRecord): Promise<void> {
  const { error } = await supabase.from('discogs_imports').upsert(r, { onConflict: 'owner_id,instance_id' })
  if (error) fail(error, 'Saving import progress')
}

export async function forgetImport(supabase: SupabaseClient, instanceId: number): Promise<void> {
  const { error } = await supabase.from('discogs_imports').delete().eq('instance_id', instanceId)
  if (error) fail(error, 'Updating import progress')
}

/** MusicBrainz release ids of copies already in the collection (to spot ones added by hand earlier). */
export async function ownedMusicBrainzReleases(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('physical_copies').select('id, musicbrainz_release_id').not('musicbrainz_release_id', 'is', null)
  if (error) fail(error, 'Loading your collection')
  return new Map((data as { id: string; musicbrainz_release_id: string }[]).map((r) => [r.musicbrainz_release_id, r.id]))
}

/** An album with exactly this title and artist (any case), for drafts without a MusicBrainz id. */
export async function findAlbumByTitleArtist(supabase: SupabaseClient, title: string, artist: string): Promise<AlbumRow | null> {
  const esc = (s: string) => s.replace(/[%_\\]/g, (c) => `\\${c}`)
  const { data, error } = await supabase.from('albums').select('*').ilike('title', esc(title)).ilike('artist', esc(artist)).limit(1)
  if (error) fail(error, 'Checking your collection')
  return ((data as AlbumRow[])[0] ?? null)
}
