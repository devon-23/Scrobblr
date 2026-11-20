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

export interface OwnedCopies {
  /** Discogs release id → copy ids (from the "From Discogs: …/release/<id>" note). */
  byDiscogs: Map<number, string[]>
  /** MusicBrainz release id → copy ids. */
  byMb: Map<string, string[]>
}

/** Copies already in the collection that came from (or match) a Discogs/MusicBrainz release. */
export async function ownedCopies(supabase: SupabaseClient): Promise<OwnedCopies> {
  const { data, error } = await supabase.from('physical_copies').select('id, musicbrainz_release_id, notes')
  if (error) fail(error, 'Loading your collection')
  const byDiscogs = new Map<number, string[]>()
  const byMb = new Map<string, string[]>()
  const add = <K>(m: Map<K, string[]>, k: K, v: string) => m.set(k, [...(m.get(k) ?? []), v])
  for (const c of data as { id: string; musicbrainz_release_id: string | null; notes: string | null }[]) {
    if (c.musicbrainz_release_id) add(byMb, c.musicbrainz_release_id, c.id)
    const rel = /discogs\.com\/release\/(\d+)/.exec(c.notes ?? '')?.[1]
    if (rel) add(byDiscogs, Number(rel), c.id)
  }
  return { byDiscogs, byMb }
}

/**
 * Claims a collection item before saving it, so two tabs/devices (or a
 * double tap) can never import it twice: the database allows one row per item.
 * Returns false if it was already claimed.
 */
export async function claimImport(supabase: SupabaseClient, instanceId: number, releaseId: number): Promise<boolean> {
  const { error } = await supabase
    .from('discogs_imports')
    .insert({ instance_id: instanceId, release_id: releaseId, physical_copy_id: null, status: 'imported' })
  if (!error) return true
  if (error.code === '23505') return false
  fail(error, 'Saving import progress')
}

/** Points a claimed item at the copy that was saved (or that already existed). */
export async function linkImport(supabase: SupabaseClient, instanceId: number, copyId: string): Promise<void> {
  const { error } = await supabase.from('discogs_imports').update({ physical_copy_id: copyId, status: 'imported' }).eq('instance_id', instanceId)
  if (error) fail(error, 'Saving import progress')
}

/** An album with exactly this title and artist (any case), for drafts without a MusicBrainz id. */
export async function findAlbumByTitleArtist(supabase: SupabaseClient, title: string, artist: string): Promise<AlbumRow | null> {
  const esc = (s: string) => s.replace(/[%_\\]/g, (c) => `\\${c}`)
  const { data, error } = await supabase.from('albums').select('*').ilike('title', esc(title)).ilike('artist', esc(artist)).limit(1)
  if (error) fail(error, 'Checking your collection')
  return ((data as AlbumRow[])[0] ?? null)
}
