import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { getRelease, listReleases, MusicBrainzError, searchReleaseGroups } from '../../integrations/musicbrainz/client'
import { artistCreditText, coverArtUrl, mediaSummary, releaseFormat, releaseToDraft, yearOf } from '../../integrations/musicbrainz/mapping'
import type { MbRelease, MbReleaseGroup } from '../../integrations/musicbrainz/types'
import { albumIdOfCopy, findAlbumByReleaseGroup, getAlbumRow, saveCopy } from '../../library/api'
import type { AlbumRow, MediaFormat } from '../../library/types'
import { useSupabase } from '../../lib/supabaseContext'
import { Link, navigate, useLocation } from '../../lib/router'
import { Box, ErrorBox, Loading } from '../../ui/Shell'
import { Artwork } from '../../ui/Artwork'
import { CopyEditor } from '../copy/CopyEditor'
import { AddTabs } from './AddTabs'
import { blankModel, fromDraft, toDraft, type EditModel } from '../copy/editModel'

type Step =
  | { kind: 'search' }
  | { kind: 'editions'; group: Pick<MbReleaseGroup, 'id' | 'title'> & { artist: string } }
  | { kind: 'review'; model: EditModel }

/**
 * Add a physical copy: search MusicBrainz → pick the exact edition → review and
 * correct → save. "Enter manually" skips MusicBrainz entirely.
 * ?album=<id>[&rg=<release group id>] adds another copy to an existing album.
 */
export function AddPage() {
  const { supabase } = useSupabase()
  const { query } = useLocation()
  const albumParam = query.get('album')
  const rgParam = query.get('rg')
  // From the Discogs importer's "search" link.
  const titleParam = query.get('title') ?? ''
  const artistParam = query.get('artist') ?? ''

  const [existing, setExisting] = useState<AlbumRow | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'search' })
  const [loadError, setLoadError] = useState<string | null>(null)

  // Adding a copy to an album already in the collection.
  useEffect(() => {
    if (!albumParam) return
    getAlbumRow(supabase, albumParam).then(
      (a) => {
        setExisting(a)
        if (a && rgParam) setStep({ kind: 'editions', group: { id: rgParam, title: a.title, artist: a.artist } })
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
    )
  }, [supabase, albumParam, rgParam])

  async function save(model: EditModel) {
    const copyId = await saveCopy(supabase, toDraft(model))
    const albumId = await albumIdOfCopy(supabase, copyId)
    navigate(`/album/${albumId}`, { replace: true })
  }

  const manual = (format: MediaFormat) => setStep({ kind: 'review', model: blankModel(format, existing ?? undefined) })

  if (loadError) return <ErrorBox error={loadError} />
  if (albumParam && !existing) return <Loading what="album" />

  return (
    <>
      {!existing && <AddTabs current="search" />}
      {existing && (
        <p>
          Adding another copy of <b>{existing.title}</b>. <Link to={`/album/${existing.id}`}>back to album</Link>
        </p>
      )}

      {step.kind === 'search' && (
        <SearchStep
          initialAlbum={existing?.title ?? titleParam}
          initialArtist={existing?.artist ?? artistParam}
          onPick={(group) => setStep({ kind: 'editions', group })}
          onManual={manual}
        />
      )}

      {step.kind === 'editions' && (
        <EditionsStep
          group={step.group}
          onBack={() => setStep({ kind: 'search' })}
          onManual={manual}
          onPick={async (release, format) => {
            const draft = releaseToDraft(release, format)
            const rgId = draft.album.musicbrainz_release_group_id
            const match = existing ?? (rgId ? await findAlbumByReleaseGroup(supabase, rgId) : null)
            if (match) draft.album = { ...draft.album, id: match.id, title: match.title, artist: match.artist }
            setStep({ kind: 'review', model: fromDraft(draft, !!match) })
          }}
        />
      )}

      {step.kind === 'review' && (
        <CopyEditor
          initial={step.model}
          saveLabel="Save to collection"
          onSave={save}
          onCancel={() => (existing ? navigate(`/album/${existing.id}`) : setStep({ kind: 'search' }))}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

function SearchStep({
  initialAlbum,
  initialArtist,
  onPick,
  onManual,
}: {
  initialAlbum: string
  initialArtist: string
  onPick: (g: Pick<MbReleaseGroup, 'id' | 'title'> & { artist: string }) => void
  onManual: (f: MediaFormat) => void
}) {
  const [album, setAlbum] = useState(initialAlbum)
  const [artist, setArtist] = useState(initialArtist)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<MbReleaseGroup[] | null>(null)

  async function search(e: FormEvent) {
    e.preventDefault()
    if (!album.trim() && !artist.trim()) return
    setBusy(true)
    setError(null)
    try {
      setResults(await searchReleaseGroups(album, artist))
    } catch (err) {
      setError(err instanceof MusicBrainzError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Box title="Add an album: search MusicBrainz">
        <form onSubmit={search}>
          <div className="form-grid">
            <label htmlFor="s-album">Album</label>
            <input id="s-album" value={album} onChange={(e) => setAlbum(e.target.value)} autoFocus />
            <label htmlFor="s-artist">Artist</label>
            <input id="s-artist" value={artist} onChange={(e) => setArtist(e.target.value)} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy || (!album.trim() && !artist.trim())}>
              {busy ? 'Searching…' : 'Search'}
            </button>
            <span className="small muted">
              or enter it manually:{' '}
              <button type="button" className="linkish" onClick={() => onManual('vinyl')}>
                vinyl
              </button>{' '}
              |{' '}
              <button type="button" className="linkish" onClick={() => onManual('cd')}>
                cd
              </button>
            </span>
          </div>
        </form>
        {error && <ErrorBox error={error} />}
      </Box>

      {results && (
        <Box title={`Results (${results.length})`}>
          {results.length === 0 ? (
            <p className="muted">Nothing found. Try fewer words, check spelling, or enter it manually.</p>
          ) : (
            <table className="list">
              <tbody>
                {results.map((g) => {
                  const credit = artistCreditText(g['artist-credit'])
                  const kind = [g['primary-type'], ...(g['secondary-types'] ?? [])].filter(Boolean).join(' + ')
                  return (
                    <tr key={g.id} className="clickable" onClick={() => onPick({ id: g.id, title: g.title, artist: credit })}>
                      <td style={{ width: 44 }}>
                        <Artwork urls={[coverArtUrl('release-group', g.id, 250)]} alt="" />
                      </td>
                      <td>
                        <a href="#" onClick={(e) => e.preventDefault()}>
                          {g.title}
                        </a>
                        <div className="small">{credit}</div>
                        <div className="small muted">
                          {[yearOf(g['first-release-date']), kind].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Box>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

function EditionsStep({
  group,
  onBack,
  onPick,
  onManual,
}: {
  group: Pick<MbReleaseGroup, 'id' | 'title'> & { artist: string }
  onBack: () => void
  onPick: (release: MbRelease, format: MediaFormat) => Promise<void>
  onManual: (f: MediaFormat) => void
}) {
  const [releases, setReleases] = useState<MbRelease[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showOther, setShowOther] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setReleases(null)
    setError(null)
    listReleases(group.id).then(
      (r) => live && setReleases(r),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, [group.id, attempt])

  const rows = useMemo(() => {
    const list = (releases ?? []).map((r) => ({ r, format: releaseFormat(r) }))
    const physical = list.filter((x) => x.format !== null)
    const shown = showOther ? list : physical
    const order = (f: MediaFormat | null) => (f === 'vinyl' ? 0 : f === 'cd' ? 1 : 2)
    return {
      hidden: list.length - physical.length,
      shown: [...shown].sort((a, b) => order(a.format) - order(b.format) || (a.r.date ?? '9').localeCompare(b.r.date ?? '9')),
    }
  }, [releases, showOther])

  async function open(release: MbRelease, format: MediaFormat) {
    setOpening(release.id)
    setError(null)
    try {
      await onPick(await getRelease(release.id), format)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setOpening(null)
    }
  }

  return (
    <Box
      title={`Which edition do you own? — ${group.title}`}
      actions={
        <a href="#" onClick={(e) => (e.preventDefault(), onBack())}>
          back to search
        </a>
      }
    >
      <p className="small">
        {group.artist}. Pick the one that matches your copy (check the label, catalog number or barcode on the sleeve).
        Not listed?{' '}
        <button type="button" className="linkish" onClick={() => onManual('vinyl')}>
          enter vinyl manually
        </button>{' '}
        |{' '}
        <button type="button" className="linkish" onClick={() => onManual('cd')}>
          enter cd manually
        </button>
      </p>
      {error && <ErrorBox error={error} onRetry={releases ? undefined : () => setAttempt((n) => n + 1)} />}
      {!releases && !error && <Loading what="editions from MusicBrainz (this can take a few seconds)" />}
      {releases && (
        <>
          {rows.shown.length === 0 && <p className="muted">No vinyl or CD editions listed on MusicBrainz.</p>}
          {rows.shown.length > 0 && (
            <table className="list">
              <thead>
                <tr>
                  <th>Format</th>
                  <th>Release</th>
                  <th>Label / Cat#</th>
                </tr>
              </thead>
              <tbody>
                {rows.shown.map(({ r, format }) => {
                  const label = r['label-info']?.[0]
                  return (
                    <tr
                      key={r.id}
                      className="clickable"
                      onClick={() => format && opening === null && void open(r, format)}
                      aria-disabled={!format}
                    >
                      <td>
                        <b>{format === 'vinyl' ? 'Vinyl' : format === 'cd' ? 'CD' : '—'}</b>
                        <div className="small muted">{mediaSummary(r.media)}</div>
                        <div className="small muted">{r.media.map((m) => m['track-count'] ?? '?').join('+')} tracks</div>
                      </td>
                      <td>
                        {opening === r.id ? <i>opening…</i> : [r.country, r.date].filter(Boolean).join(' · ') || '—'}
                        {r.disambiguation && <div className="small">{r.disambiguation}</div>}
                        {r.status && r.status !== 'Official' && <div className="small muted">{r.status}</div>}
                      </td>
                      <td className="small">
                        {label?.label?.name ?? '—'}
                        {label?.['catalog-number'] && label['catalog-number'] !== '[none]' && <div className="muted">{label['catalog-number']}</div>}
                        {r.barcode && <div className="muted">{r.barcode}</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          {rows.hidden > 0 && (
            <p className="small muted">
              {showOther ? 'Showing' : 'Hiding'} {rows.hidden} digital/cassette/other edition(s).{' '}
              <button type="button" className="linkish" onClick={() => setShowOther((s) => !s)}>
                {showOther ? 'hide them' : 'show them'}
              </button>
              {showOther && ' (they can still be added as vinyl or CD if MusicBrainz has the format wrong — choose manually instead)'}
            </p>
          )}
        </>
      )}
    </Box>
  )
}

