/**
 * NFC tag data access. Tags live in `nfc_tags` (RLS: owner only); the sticker
 * itself only holds a random token, so moving or replacing a tag never means
 * rewriting the sticker for the record it's on.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fail } from '../library/api'
import type { MediaFormat } from '../library/types'
import { newToken } from './tokens'

export interface TagRow {
  id: string
  token: string
  physical_copy_id: string | null
  created_at: string
  assigned_at: string | null
  last_scanned_at: string | null
  scan_count: number
}

const TAG_COLS = 'id, token, physical_copy_id, created_at, assigned_at, last_scanned_at, scan_count'

/**
 * Looks up a scanned token and records the scan.
 * Returns null for a token the database doesn't know; copyId null for a tag
 * that exists but isn't linked to a copy (e.g. its copy was deleted).
 */
export async function scanTag(supabase: SupabaseClient, token: string): Promise<{ tagId: string; copyId: string | null } | null> {
  const { data, error } = await supabase.rpc('scan_nfc_tag', { p_token: token })
  if (error) fail(error, 'Looking up the tag')
  const row = (data as { tag_id: string; copy_id: string | null }[] | null)?.[0]
  return row ? { tagId: row.tag_id, copyId: row.copy_id } : null
}

export async function listTagsForCopy(supabase: SupabaseClient, copyId: string): Promise<TagRow[]> {
  const { data, error } = await supabase.from('nfc_tags').select(TAG_COLS).eq('physical_copy_id', copyId).order('created_at')
  if (error) fail(error, 'Loading tags')
  return data as TagRow[]
}

/** Makes a fresh token linked to a copy (for a new sticker). */
export async function createTag(supabase: SupabaseClient, copyId: string): Promise<TagRow> {
  const { data, error } = await supabase
    .from('nfc_tags')
    .insert({ token: newToken(), physical_copy_id: copyId, assigned_at: new Date().toISOString() })
    .select(TAG_COLS)
    .single()
  if (error) fail(error, 'Creating the tag')
  return data as TagRow
}

/**
 * Links a scanned token to a copy: creates the row if the token is unknown,
 * otherwise moves it. owner_id comes from the database default (the caller).
 */
export async function linkToken(supabase: SupabaseClient, token: string, copyId: string): Promise<void> {
  const { error } = await supabase
    .from('nfc_tags')
    .upsert({ token, physical_copy_id: copyId, assigned_at: new Date().toISOString() }, { onConflict: 'token' })
  if (error) fail(error, 'Linking the tag')
}

/** Forgets a tag. Tapping that sticker afterwards offers to link it again. */
export async function deleteTag(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('nfc_tags').delete().eq('id', id)
  if (error) fail(error, 'Removing the tag')
}

export interface CopyChoice {
  copyId: string
  albumId: string
  title: string
  artist: string
  format: MediaFormat
  editionName: string | null
  artworkUrl: string | null
  tagCount: number
}

/** Every copy in the collection, for "which record is this tag on?". */
export async function listCopyChoices(supabase: SupabaseClient): Promise<CopyChoice[]> {
  const { data, error } = await supabase
    .from('albums')
    .select('id, title, artist, album_artist, artwork_url, physical_copies ( id, format, edition_name, artwork_url, created_at, nfc_tags ( id ) )')
  if (error) fail(error, 'Loading your collection')
  type Row = {
    id: string
    title: string
    artist: string
    album_artist: string | null
    artwork_url: string | null
    physical_copies: { id: string; format: MediaFormat; edition_name: string | null; artwork_url: string | null; created_at: string; nfc_tags: { id: string }[] }[]
  }
  return (data as Row[])
    .flatMap((a) =>
      a.physical_copies
        .sort((x, y) => x.created_at.localeCompare(y.created_at))
        .map((c) => ({
          copyId: c.id,
          albumId: a.id,
          title: a.title,
          artist: a.album_artist ?? a.artist,
          format: c.format,
          editionName: c.edition_name,
          artworkUrl: c.artwork_url ?? a.artwork_url,
          tagCount: c.nfc_tags.length,
        })),
    )
    .sort((x, y) => sortKey(x.artist).localeCompare(sortKey(y.artist)) || x.title.localeCompare(y.title))
}

const sortKey = (s: string) => s.replace(/^the\s+/i, '').toLowerCase()
