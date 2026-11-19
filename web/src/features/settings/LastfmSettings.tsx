import { useState } from 'react'
import {
  disconnect,
  flush,
  getAuthUrl,
  getConnection,
  getSettings,
  queueCounts,
  recentScrobbles,
  requeue,
  saveSettings,
  STATUS_LABEL,
  type FlushSummary,
  type ScrobbleSettings,
} from '../../integrations/lastfm/api'
import { useSupabase } from '../../lib/supabaseContext'
import { useAsync } from '../../lib/useAsync'
import { Box, ErrorBox, Loading } from '../../ui/Shell'

export const STATE_KEY = 'analogscrobbler.lastfmState'

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function LastfmSettings() {
  const { supabase } = useSupabase()
  const data = useAsync(
    async () => {
      const [connection, settings] = await Promise.all([getConnection(supabase), getSettings(supabase)])
      return { connection, settings }
    },
    [supabase],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function startConnect() {
    setBusy(true)
    setError(null)
    try {
      // A one-time value checked on return, so only a login YOU started can connect an account.
      const state = crypto.randomUUID()
      localStorage.setItem(STATE_KEY, state)
      const { url } = await getAuthUrl(supabase, `${window.location.origin}/lastfm/callback?state=${state}`)
      window.location.assign(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function doDisconnect() {
    if (!window.confirm('Disconnect Last.fm? Queued scrobbles stay queued until you reconnect.')) return
    setBusy(true)
    try {
      await disconnect(supabase)
      data.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function update(s: ScrobbleSettings) {
    setError(null)
    try {
      await saveSettings(supabase, s)
      data.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <Box title="Last.fm">
        {data.status === 'loading' && <Loading what="Last.fm status" />}
        {data.status === 'error' && <ErrorBox error={data.error} onRetry={data.reload} />}
        {data.status === 'ready' && (
          <>
            {data.data.connection ? (
              <>
                <p>
                  Connected as{' '}
                  <a href={`https://www.last.fm/user/${encodeURIComponent(data.data.connection.username)}`} target="_blank" rel="noreferrer">
                    <b>{data.data.connection.username}</b>
                  </a>{' '}
                  <span className="muted small">since {when(data.data.connection.connected_at)}</span>
                </p>
                {data.data.connection.needs_reauth && (
                  <div className="errorbox">
                    Last.fm no longer accepts this connection (it may have been revoked). Scrobbles are kept in the queue.{' '}
                    <button className="linkish" onClick={() => void startConnect()} disabled={busy}>
                      reconnect
                    </button>
                  </div>
                )}
                <p className="small">
                  <button className="linkish" onClick={() => void doDisconnect()} disabled={busy}>
                    disconnect
                  </button>{' '}
                  <span className="muted">
                    (to fully revoke access, also remove AnalogScrobbler at last.fm → Settings → Applications)
                  </span>
                </p>
              </>
            ) : (
              <>
                <p>Not connected. You'll sign in on last.fm itself — AnalogScrobbler never sees your password.</p>
                <p>
                  <button onClick={() => void startConnect()} disabled={busy}>
                    {busy ? 'Opening Last.fm…' : 'Connect Last.fm'}
                  </button>
                </p>
                <p className="small muted">
                  Tip: do this in Safari rather than the Home Screen app. iPhone Home Screen apps open other sites in a
                  separate window, which can lose the way back.
                </p>
              </>
            )}

            <div className="form-grid" style={{ marginTop: 8 }}>
              <span className="small" style={{ fontWeight: 'bold' }}>
                Scrobbling
              </span>
              <label style={{ fontWeight: 'normal' }}>
                <input
                  type="checkbox"
                  checked={data.data.settings.scrobbling_enabled}
                  onChange={(e) => void update({ ...data.data.settings, scrobbling_enabled: e.target.checked })}
                />{' '}
                send plays to Last.fm
              </label>
              <span className="small" style={{ fontWeight: 'bold' }}>
                Dry run
              </span>
              <label style={{ fontWeight: 'normal' }}>
                <input
                  type="checkbox"
                  checked={data.data.settings.dry_run}
                  onChange={(e) => {
                    const on = e.target.checked
                    if (!on && !window.confirm('Turn off dry run? From now on, plays that count will be sent to your real Last.fm profile.')) return
                    void update({ ...data.data.settings, dry_run: on })
                  }}
                />{' '}
                log what would be sent, but don't send
              </label>
            </div>
            {data.data.settings.dry_run && (
              <p className="notice small" style={{ marginTop: 8 }}>
                <b>Dry run is on.</b> Nothing is sent to Last.fm. Plays that count are logged below as "dry run" — they
                won't be sent later when you turn it off.
              </p>
            )}
          </>
        )}
        {error && <ErrorBox error={error} />}
      </Box>
      <ScrobbleLog />
    </>
  )
}

function ScrobbleLog() {
  const { supabase } = useSupabase()
  const data = useAsync(async () => {
    const [counts, rows] = await Promise.all([queueCounts(supabase), recentScrobbles(supabase, 40)])
    return { counts, rows }
  }, [supabase])
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<FlushSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function sendNow() {
    setSending(true)
    setError(null)
    try {
      setResult(await flush(supabase))
      data.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  async function retry(id: string) {
    try {
      await requeue(supabase, [id])
      await sendNow()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Box
      title="Scrobble log"
      actions={
        <a href="#" onClick={(e) => (e.preventDefault(), data.reload())}>
          refresh
        </a>
      }
    >
      {data.status === 'loading' && <Loading what="scrobbles" />}
      {data.status === 'error' && <ErrorBox error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && (
        <>
          <p className="small">
            {data.data.counts.accepted} scrobbled · {data.data.counts.pending + data.data.counts.submitting} queued ·{' '}
            {data.data.counts.dry_run} dry run · {data.data.counts.ignored} ignored · {data.data.counts.failed} failed
          </p>
          <p>
            <button onClick={() => void sendNow()} disabled={sending}>
              {sending ? 'Sending…' : 'Send queued now'}
            </button>
          </p>
          {result && <FlushResult r={result} />}
          {error && <ErrorBox error={error} />}
          {data.data.rows.length === 0 ? (
            <p className="muted">Nothing yet. Plays that count are queued here when a track finishes.</p>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Played</th>
                  <th>Track</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="small nowrap">{when(r.played_at)}</td>
                    <td>
                      {r.track}
                      <div className="small muted">{r.artist}</div>
                    </td>
                    <td className="small">
                      <span className={r.status === 'accepted' ? 'good' : r.status === 'failed' ? 'bad' : ''}>{STATUS_LABEL[r.status]}</span>
                      {r.last_error && r.status !== 'accepted' && <div className="muted">{r.last_error}</div>}
                      {r.status === 'failed' && (
                        <button className="linkish" onClick={() => void retry(r.id)}>
                          retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Box>
  )
}

function FlushResult({ r }: { r: FlushSummary }) {
  if (r.notConnected) return <p className="notice small">Not connected to Last.fm — {r.waiting ?? 0} scrobble(s) waiting.</p>
  if (r.needsReauth) return <p className="errorbox small">Last.fm rejected the connection. Reconnect above; nothing was lost.</p>
  if (r.claimed === 0) return <p className="small muted">Nothing due right now (items that failed temporarily wait before retrying).</p>
  const parts = [
    r.accepted && `${r.accepted} scrobbled`,
    r.dryRun && `${r.dryRun} logged as dry run`,
    r.ignored && `${r.ignored} ignored by Last.fm`,
    r.retryLater && `${r.retryLater} will retry`,
    r.failed && `${r.failed} failed`,
    r.disabled && `${r.disabled} skipped (scrobbling off)`,
  ].filter(Boolean)
  return <p className="small good">{parts.join(' · ')}</p>
}
