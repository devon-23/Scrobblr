import { useEffect, useState } from 'react'
import { useSupabase } from '../../lib/supabaseContext'
import { Box } from '../../ui/Shell'
import { LastfmSettings } from './LastfmSettings'

type ServerCheck = { status: 'checking' } | { status: 'ok'; at: Date } | { status: 'failed'; message: string }

export function SettingsPage() {
  const { supabase, session, config } = useSupabase()
  const [check, setCheck] = useState<ServerCheck>({ status: 'checking' })

  async function runCheck() {
    setCheck({ status: 'checking' })
    // getUser() validates the session with the server (getSession() only reads local storage).
    const { data, error } = await supabase.auth.getUser()
    if (error) setCheck({ status: 'failed', message: error.message })
    else if (!data.user) setCheck({ status: 'failed', message: 'Server returned no user.' })
    else setCheck({ status: 'ok', at: new Date() })
  }

  useEffect(() => {
    void runCheck()
  }, [])

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true

  return (
    <>
      <Box title="Account">
        <dl className="details">
          <dt>Signed in as</dt>
          <dd>{session.user.email}</dd>
          <dt>Supabase</dt>
          <dd>{new URL(config.supabaseUrl).hostname}</dd>
          <dt>Server check</dt>
          <dd>
            {check.status === 'checking' && <span className="muted">checking…</span>}
            {check.status === 'ok' && <span className="good">OK ({check.at.toLocaleTimeString()})</span>}
            {check.status === 'failed' && <span className="bad">{check.message}</span>}{' '}
            <button className="linkish" onClick={() => void runCheck()} disabled={check.status === 'checking'}>
              re-check
            </button>
          </dd>
          <dt>Running as</dt>
          <dd>{standalone ? 'Home Screen app' : 'browser tab'}</dd>
        </dl>
        <p>
          <button onClick={() => void supabase.auth.signOut()}>Sign out</button>
        </p>
      </Box>
      <LastfmSettings />
    </>
  )
}
