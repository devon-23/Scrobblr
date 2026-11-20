import { useEffect, useRef, useState } from 'react'
import { listHistory, PAGE, type HistoryFilter, type HistoryRow } from '../../history/api'
import { STATUS_LABEL } from '../../integrations/lastfm/api'
import { formatDuration } from '../../lib/duration'
import { Link } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

type Load = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; rows: HistoryRow[]; more: boolean }

/** Every track played, newest first, grouped by listening session. */
export function HistoryPage() {
  const { supabase } = useSupabase()
  const [filter, setFilter] = useState<HistoryFilter>({ format: 'all', countedOnly: false, search: '' })
  const [typed, setTyped] = useState('')
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setFilter((f) => (f.search === typed ? f : { ...f, search: typed })), 300)
    return () => window.clearTimeout(t)
  }, [typed])

  useEffect(() => {
    const gen = ++generation.current
    setLoad({ status: 'loading' })
    listHistory(supabase, filter).then(
      (rows) => gen === generation.current && setLoad({ status: 'ready', rows, more: rows.length === PAGE }),
      (e: unknown) => gen === generation.current && setLoad({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
    )
  }, [supabase, filter, attempt])

  async function more() {
    if (load.status !== 'ready') return
    const gen = generation.current
    setLoadingMore(true)
    try {
      const next = await listHistory(supabase, filter, load.rows.length)
      if (gen === generation.current) setLoad({ status: 'ready', rows: [...load.rows, ...next], more: next.length === PAGE })
    } catch (e) {
      if (gen === generation.current) setLoad({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoadingMore(false)
    }
  }

  const fmtLink = (f: HistoryFilter['format'], label: string) =>
    filter.format === f ? (
      <span>{label}</span>
    ) : (
      <a href="#" onClick={(e) => (e.preventDefault(), setFilter({ ...filter, format: f }))}>
        {label}
      </a>
    )

  return (
    <Box title="Listening History">
      <div className="toolbar">
        <input type="search" placeholder="search track, artist or album" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search history" />
        <label className="small" style={{ fontWeight: 'normal' }}>
          <input type="checkbox" checked={filter.countedOnly} onChange={(e) => setFilter({ ...filter, countedOnly: e.target.checked })} /> counted
          only
        </label>
      </div>
      <div className="filters small">
        show: {fmtLink('all', 'all')} | {fmtLink('vinyl', 'vinyl')} | {fmtLink('cd', 'cds')}
      </div>
      {load.status === 'loading' && <Loading what="history" />}
      {load.status === 'error' && <ErrorBox error={load.error} onRetry={() => setAttempt((n) => n + 1)} />}
      {load.status === 'ready' && load.rows.length === 0 && (
        <p className="muted">
          {filter.search || filter.format !== 'all' || filter.countedOnly ? (
            'Nothing matches.'
          ) : (
            <>
              Nothing played yet. Pick a record in your <Link to="/collection">collection</Link> and press <b>listen</b>.
            </>
          )}
        </p>
      )}
      {load.status === 'ready' && load.rows.length > 0 && (
        <>
          <HistoryTable rows={load.rows} />
          {load.more && (
            <p>
              <button onClick={() => void more()} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show older'}
              </button>
            </p>
          )}
          <p className="small muted">
            Status is Last.fm's: <b>scrobbled</b> = on your profile. A track counts when it's over 30 s and you heard half of it (or
            4 minutes) without skipping. Failed ones can be retried in <Link to="/settings">settings</Link>.
          </p>
        </>
      )}
    </Box>
  )
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  // Consecutive rows from the same session share a header.
  const groups: { id: string; rows: HistoryRow[] }[] = []
  for (const r of rows) {
    const last = groups[groups.length - 1]
    if (last && last.id === r.session_id) last.rows.push(r)
    else groups.push({ id: r.session_id, rows: [r] })
  }
  return (
    <table className="list history">
      <tbody>
        {groups.map((g) => {
          const first = g.rows[g.rows.length - 1]! // oldest in this group
          const start = new Date(first.started_at)
          return [
            <tr key={g.id + '-h'} className="side-row">
              <td colSpan={3}>
                <span className={`fmt fmt-${first.format}`}>{first.format === 'cd' ? 'CD' : 'Vinyl'}</span>{' '}
                {first.album_id ? <Link to={`/album/${first.album_id}`}>{first.album_title}</Link> : first.album_title}
                <span style={{ fontWeight: 'normal' }}>
                  {' '}
                  — {first.album_artist} · {dayFmt.format(start)}
                </span>
              </td>
            </tr>,
            ...g.rows.map((r) => <HistoryLine key={`${r.session_id}-${r.seq}`} r={r} />),
          ]
        })}
      </tbody>
    </table>
  )
}

function HistoryLine({ r }: { r: HistoryRow }) {
  const st = playStatus(r)
  return (
    <tr className={r.counts ? '' : 'dim'}>
      <td className="num">{timeFmt.format(new Date(r.started_at))}</td>
      <td>
        {r.title}
        {r.artist !== r.album_artist && <span className="small muted"> — {r.artist}</span>}
        <div className="small muted">
          {r.format === 'vinyl' ? `side ${r.side_label}` : r.side_label} · heard {formatDuration(r.listened_seconds)} of{' '}
          {formatDuration(r.duration_seconds)}
        </div>
      </td>
      <td className="right nowrap small">
        <span className={st.cls}>{st.label}</span>
        {st.detail && <div className={st.cls === 'bad' ? 'bad detail' : 'muted detail'}>{st.detail}</div>}
      </td>
    </tr>
  )
}

const REASON: Record<string, string> = {
  skipped: 'skipped',
  restarted: 'restarted',
  next: 'moved on early',
  previous: 'went back early',
  selected: 'switched track early',
  ended: 'session ended early',
}

export function playStatus(r: Pick<HistoryRow, 'counts' | 'final' | 'end_reason' | 'duration_seconds' | 'scrobble'>): {
  label: string
  cls: string
  detail: string | null
} {
  if (!r.counts) {
    const why = r.duration_seconds <= 30 ? '30 s or shorter' : (REASON[r.end_reason] ?? 'not heard long enough')
    return { label: "didn't count", cls: 'muted', detail: why }
  }
  if (!r.final) return { label: 'waiting', cls: 'muted', detail: 'until the side is confirmed' }
  if (!r.scrobble) return { label: 'not queued yet', cls: 'muted', detail: null }
  const s = r.scrobble.status
  const cls = s === 'accepted' ? 'good' : s === 'failed' ? 'bad' : 'muted'
  return { label: STATUS_LABEL[s], cls, detail: s === 'failed' || s === 'ignored' ? r.scrobble.last_error : null }
}
