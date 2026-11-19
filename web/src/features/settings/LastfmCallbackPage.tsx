import { useEffect, useRef, useState } from 'react'
import { connect, flush } from '../../integrations/lastfm/api'
import { Link, navigate, useLocation } from '../../lib/router'
import { useSupabase } from '../../lib/supabaseContext'
import { Box, ErrorBox } from '../../ui/Shell'
import { STATE_KEY } from './LastfmSettings'

/** Last.fm sends you back here with ?token=… after you approve access. */
export function LastfmCallbackPage() {
  const { supabase } = useSupabase()
  const { query } = useLocation()
  const [result, setResult] = useState<{ ok: true; username: string } | { ok: false; error: string } | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const token = query.get('token')
    const state = query.get('state')
    const expected = localStorage.getItem(STATE_KEY)
    localStorage.removeItem(STATE_KEY)
    // Drop the token from the address bar and history.
    window.history.replaceState(null, '', '/lastfm/callback')

    if (!token) return setResult({ ok: false, error: 'Last.fm did not send a token (did you cancel?).' })
    if (!state || state !== expected) {
      return setResult({
        ok: false,
        error:
          "This sign-in wasn't started from this browser, so it was ignored. Start again from Settings → Connect Last.fm (in Safari if you're on iPhone).",
      })
    }
    connect(supabase, token).then(
      ({ username }) => {
        setResult({ ok: true, username })
        // Send anything that was waiting for a connection (respects dry run).
        void flush(supabase).catch(() => undefined)
      },
      (e: unknown) => setResult({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
  }, [supabase, query])

  return (
    <Box title="Connecting Last.fm">
      {!result && <p className="muted">Talking to Last.fm…</p>}
      {result?.ok && (
        <>
          <p className="good">Connected as {result.username}.</p>
          <p>
            <button onClick={() => navigate('/settings', { replace: true })}>Back to settings</button>
          </p>
        </>
      )}
      {result && !result.ok && (
        <>
          <ErrorBox error={result.error} />
          <p>
            <Link to="/settings">Back to settings</Link>
          </p>
        </>
      )}
    </Box>
  )
}
