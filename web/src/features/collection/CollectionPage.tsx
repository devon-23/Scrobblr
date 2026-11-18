import { useMemo, useState } from 'react'
import { listCollection, type CollectionItem } from '../../library/api'
import type { MediaFormat } from '../../library/types'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Link } from '../../lib/router'
import { Box, ErrorBox, Loading } from '../../ui/Shell'
import { Artwork } from '../../ui/Artwork'

type Filter = 'all' | MediaFormat
type Sort = 'artist' | 'album' | 'added'

/** "The Beatles" sorts under B. */
function sortKey(s: string): string {
  return s.toLocaleLowerCase().replace(/^the\s+/, '')
}

export function CollectionPage() {
  const { supabase } = useSupabase()
  const state = useAsync(() => listCollection(supabase), [supabase])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('artist')

  const items = state.status === 'ready' ? state.data : []
  const counts = useMemo(() => {
    let vinyl = 0
    let cd = 0
    for (const a of items) for (const c of a.physical_copies) c.format === 'vinyl' ? vinyl++ : cd++
    return { vinyl, cd }
  }, [items])

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    const list = items.filter(
      (a) =>
        (filter === 'all' || a.physical_copies.some((c) => c.format === filter)) &&
        (!q || [a.title, a.artist, a.album_artist ?? ''].some((s) => s.toLocaleLowerCase().includes(q))),
    )
    const by: Record<Sort, (a: CollectionItem, b: CollectionItem) => number> = {
      artist: (a, b) =>
        sortKey(a.album_artist ?? a.artist).localeCompare(sortKey(b.album_artist ?? b.artist)) ||
        (a.release_year ?? 0) - (b.release_year ?? 0) ||
        sortKey(a.title).localeCompare(sortKey(b.title)),
      album: (a, b) => sortKey(a.title).localeCompare(sortKey(b.title)),
      added: (a, b) => lastAdded(b).localeCompare(lastAdded(a)),
    }
    return [...list].sort(by[sort])
  }, [items, query, filter, sort])

  const filterLink = (f: Filter, label: string) =>
    filter === f ? (
      <span>{label}</span>
    ) : (
      <a href="#" onClick={(e) => (e.preventDefault(), setFilter(f))}>
        {label}
      </a>
    )

  return (
    <Box
      title={`My Collection${state.status === 'ready' ? ` (${items.length})` : ''}`}
      actions={<Link to="/add">+ add album</Link>}
    >
      {state.status === 'loading' && <Loading what="your collection" />}
      {state.status === 'error' && <ErrorBox error={state.error} onRetry={state.reload} />}
      {state.status === 'ready' && items.length === 0 && (
        <p>
          Nothing here yet. <Link to="/add">Add your first record or CD</Link>.
        </p>
      )}
      {state.status === 'ready' && items.length > 0 && (
        <>
          <div className="toolbar">
            <input
              type="search"
              placeholder="search title or artist"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search collection"
            />
            <label className="small">
              sort:{' '}
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="artist">artist</option>
                <option value="album">album</option>
                <option value="added">recently added</option>
              </select>
            </label>
          </div>
          <div className="filters small">
            show: {filterLink('all', 'all')} | {filterLink('vinyl', `vinyl (${counts.vinyl})`)} |{' '}
            {filterLink('cd', `cds (${counts.cd})`)}
          </div>
          {shown.length === 0 ? (
            <p className="muted">No matches.</p>
          ) : (
            <div className="grid">
              {shown.map((a) => (
                <Link key={a.id} to={`/album/${a.id}`} className="item">
                  <Artwork key={a.artwork_url ?? ''} urls={[a.artwork_url]} alt={`${a.title} cover`} />
                  <span className="t">{a.title}</span>
                  <span className="a">{a.album_artist ?? a.artist}</span>
                  <span className="tags">{formatTags(a)}</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </Box>
  )
}

function lastAdded(a: CollectionItem): string {
  return a.physical_copies.reduce((max, c) => (c.created_at > max ? c.created_at : max), a.created_at)
}

function formatTags(a: CollectionItem): string {
  const v = a.physical_copies.filter((c) => c.format === 'vinyl').length
  const c = a.physical_copies.filter((c) => c.format === 'cd').length
  return [v && (v > 1 ? `${v}× vinyl` : 'vinyl'), c && (c > 1 ? `${c}× cd` : 'cd')].filter(Boolean).join(' · ')
}
