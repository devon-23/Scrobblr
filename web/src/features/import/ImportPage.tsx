import { useMemo, useState, type FormEvent } from 'react'
import { saveCopy } from '../../library/api'
import type { CopyDraft } from '../../library/types'
import { Link } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { Artwork } from '../../ui/Artwork'
import { Box, ErrorBox, Loading } from '../../ui/Shell'
import { AddTabs } from '../add/AddTabs'
import { CopyEditor } from '../copy/CopyEditor'
import { blankModel, fromDraft, toDraft, type EditModel } from '../copy/editModel'
import { attachExistingAlbum, useDiscogsImport, type Row } from './useDiscogsImport'

type Filter = 'todo' | 'ready' | 'imported' | 'other' | 'all'

const STATUS: Record<Row['status'], string> = {
  pending: 'not checked yet',
  ready: 'ready',
  review: 'needs a look',
  not_found: 'not recognised',
  imported: 'imported',
  skipped: 'skipped',
  in_collection: 'already in your collection',
  unsupported: 'not vinyl / CD',
}

/** Import a Discogs collection; review or hand-enter whatever couldn't be matched. */
export function ImportPage() {
  const { supabase } = useSupabase()
  const imp = useDiscogsImport(supabase)
  const [name, setName] = useState(imp.username)
  const [filter, setFilter] = useState<Filter>('todo')
  const [editing, setEditing] = useState<{ row: Row; model: EditModel } | null>(null)
  const [opening, setOpening] = useState<number | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const counts = useMemo(() => {
    const c: Record<Row['status'], number> = { pending: 0, ready: 0, review: 0, not_found: 0, imported: 0, skipped: 0, in_collection: 0, unsupported: 0 }
    for (const r of imp.rows) c[r.status]++
    return c
  }, [imp.rows])

  const shown = imp.rows.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'todo'
        ? r.status === 'review' || r.status === 'not_found' || r.status === 'pending'
        : filter === 'ready'
          ? r.status === 'ready'
          : filter === 'imported'
            ? r.status === 'imported'
            : r.status === 'skipped' || r.status === 'in_collection' || r.status === 'unsupported',
  )

  function submit(e: FormEvent) {
    e.preventDefault()
    if (name.trim()) void imp.load(name)
  }

  /** Opens the editor: the matched draft, or a blank one with the title/artist filled in. */
  async function open(row: Row, blank = false) {
    setOpening(row.instanceId)
    setRowError(null)
    try {
      let model: EditModel
      if (blank || row.status === 'not_found') {
        const blankOne = blankModel(row.format ?? 'vinyl')
        model = {
          ...blankOne,
          album: { ...blankOne.album, title: row.title, artist: row.artist, release_year: row.year, artwork_url: row.coverUrl },
          copy: { ...blankOne.copy, artwork_url: row.coverUrl, notes: `From Discogs: https://www.discogs.com/release/${row.releaseId}` },
        }
      } else {
        const { draft, albumExists } = await attachExistingAlbum(supabase, await imp.draftFor(row))
        model = fromDraft(draft as CopyDraft, albumExists)
      }
      setEditing({ row, model })
      window.scrollTo(0, 0)
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening(null)
    }
  }

  if (editing) {
    return (
      <>
        <AddTabs current="discogs" />
        <p>
          {editing.row.status === 'not_found' ? 'Entering' : 'Reviewing'} <b>{editing.row.title}</b>
          {editing.row.status === 'not_found' ? ' by hand' : ''} from your Discogs collection.{' '}
          <a href={`https://www.discogs.com/release/${editing.row.releaseId}`} target="_blank" rel="noreferrer">
            see it on Discogs
          </a>
        </p>
        <CopyEditor
          initial={editing.model}
          saveLabel="Save to collection"
          onSave={async (m) => {
            const copyId = await saveCopy(supabase, toDraft(m))
            await imp.finishImport(editing.row, copyId)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      </>
    )
  }

  const busy = imp.busy
  return (
    <>
      <AddTabs current="discogs" />
      <Box title="Import from Discogs">
        <form onSubmit={submit} className="row">
          <input type="text" placeholder="your Discogs username" value={name} onChange={(e) => setName(e.target.value)} aria-label="Discogs username" autoCapitalize="none" autoCorrect="off" />
          <button type="submit" disabled={!!busy || !name.trim()}>
            {imp.rows.length ? 'Reload collection' : 'Load collection'}
          </button>
        </form>
        <p className="small muted">
          Reads your <b>public</b> Discogs collection: no password or token. Vinyl and CDs are matched to MusicBrainz (exact edition,
          sides and track lengths) or else Discogs' own tracklist. Anything incomplete waits here for you to check or enter by hand.
        </p>
        {imp.error && <ErrorBox error={imp.error} />}
        {rowError && <ErrorBox error={rowError} />}
        {busy && (
          <div className="notice">
            {busy.kind === 'loading' && `Loading your collection… ${busy.total ? `${busy.done} of ${busy.total}` : ''}`}
            {busy.kind === 'matching' && `Matching tracklists… ${busy.done} of ${busy.total}`}
            {busy.kind === 'importing' && `Importing… ${busy.done} of ${busy.total}`}
            {busy.total > 0 && (
              <div className="progress" style={{ marginTop: 4 }}>
                <div className="fill" style={{ width: `${(100 * busy.done) / busy.total}%` }} />
              </div>
            )}
            <p className="small" style={{ marginTop: 4 }}>
              Discogs allows 25 lookups a minute, so a big collection takes a while. You can leave this page; progress is kept.{' '}
              <button className="linkish" onClick={imp.stop}>
                stop
              </button>
            </p>
          </div>
        )}
        {!busy && counts.pending > 0 && (
          <p>
            <button onClick={() => void imp.continueMatching()}>Continue matching ({counts.pending} left)</button>
          </p>
        )}
        {imp.rows.length > 0 && (
          <>
            <dl className="details small">
              <dt>In your Discogs collection</dt>
              <dd>{imp.rows.length}</dd>
              <dt>Ready to import</dt>
              <dd>{counts.ready}</dd>
              <dt>Need you</dt>
              <dd>{counts.review + counts.not_found}</dd>
              <dt>Imported</dt>
              <dd>{counts.imported}</dd>
              <dt>Already here / skipped / other formats</dt>
              <dd>
                {counts.in_collection} / {counts.skipped} / {counts.unsupported}
              </dd>
            </dl>
            {counts.ready > 0 && (
              <p>
                <button className="big" onClick={() => void imp.importReady()} disabled={!!busy}>
                  Import {counts.ready} ready {counts.ready === 1 ? 'album' : 'albums'}
                </button>
              </p>
            )}
          </>
        )}
      </Box>

      {imp.rows.length > 0 && (
        <Box title="Your Discogs collection">
          <div className="filters small">
            show: {tab('todo', `need you (${counts.review + counts.not_found + counts.pending})`)} | {tab('ready', `ready (${counts.ready})`)} |{' '}
            {tab('imported', `imported (${counts.imported})`)} | {tab('other', 'other')} | {tab('all', 'all')}
          </div>
          {shown.length === 0 ? (
            <p className="muted">Nothing here.</p>
          ) : (
            <table className="list">
              <tbody>
                {shown.map((r) => (
                  <tr key={r.instanceId}>
                    <td style={{ width: 40 }}>
                      <Artwork urls={[r.coverUrl]} alt="" />
                    </td>
                    <td>
                      <b>{r.title}</b>
                      <div className="small">{r.artist}</div>
                      <div className="small muted">
                        {r.formatText}
                        {r.year ? ` · ${r.year}` : ''}
                      </div>
                    </td>
                    <td className="right small" style={{ width: '34%' }}>
                      <div className={r.status === 'ready' || r.status === 'imported' ? 'good' : r.status === 'review' || r.status === 'not_found' ? 'bad' : 'muted'}>
                        {STATUS[r.status]}
                      </div>
                      {r.note && <div className="muted">{r.note}</div>}
                      <div className="row-actions">{actions(r)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted">
            <button className="linkish" onClick={() => window.confirm('Forget this import list on this device? Imported albums stay in your collection.') && imp.reset()}>
              clear this list
            </button>
          </p>
        </Box>
      )}
      {imp.rows.length === 0 && busy?.kind === 'loading' && <Loading what="collection" />}
    </>
  )

  function tab(f: Filter, label: string) {
    return filter === f ? (
      <span>{label}</span>
    ) : (
      <a href="#" onClick={(e) => (e.preventDefault(), setFilter(f))}>
        {label}
      </a>
    )
  }

  function actions(r: Row) {
    const dis = !!busy || opening !== null
    const link = (label: string, fn: () => void) => (
      <button className="linkish" onClick={fn} disabled={dis}>
        {opening === r.instanceId ? 'opening…' : label}
      </button>
    )
    const sep = ' · '
    switch (r.status) {
      case 'ready':
        return <>{link('import', () => void imp.importReady(r))}{sep}{link('review first', () => void open(r))}{sep}{link('skip', () => void imp.skip(r))}</>
      case 'review':
        return <>{link('review', () => void open(r))}{sep}{link('skip', () => void imp.skip(r))}</>
      case 'not_found':
        return (
          <>
            {link('enter by hand', () => void open(r, true))}
            {sep}
            <Link to={`/add?title=${encodeURIComponent(r.title)}&artist=${encodeURIComponent(r.artist)}`}>search</Link>
            {sep}
            {link('skip', () => void imp.skip(r))}
          </>
        )
      case 'imported':
        return r.albumId ? <Link to={`/album/${r.albumId}`}>view</Link> : null
      case 'skipped':
        return link('un-skip', () => void imp.unskip(r))
      case 'in_collection':
        return link('import another copy', () => imp.importAnyway(r))
      default:
        return null
    }
  }
}
