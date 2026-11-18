import { useEffect, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { loadConfig, type AppConfig } from './lib/config'
import { getSupabase } from './lib/supabase'
import { useSession } from './auth/useSession'
import { SignIn } from './auth/SignIn'

export function App() {
  const result = loadConfig()
  if (!result.ok) return <ConfigError problems={result.problems} />
  return <AuthedApp config={result.config} />
}

function AuthedApp({ config }: { config: AppConfig }) {
  const supabase = getSupabase(config)
  const state = useSession(supabase)

  if (state.status === 'loading') {
    return (
      <main className="screen center">
        <div className="record-mark spinning" aria-label="Loading" />
      </main>
    )
  }
  if (state.status === 'signedOut') return <SignIn supabase={supabase} />
  return <ConnectionStatus supabase={supabase} session={state.session} config={config} />
}

type ServerCheck =
  | { status: 'checking' }
  | { status: 'ok'; checkedAt: Date }
  | { status: 'failed'; message: string }

/**
 * Phase 1 home screen: proves the deployed app can reach Supabase and that the
 * stored session is accepted by the server. Replaced by the real Home screen in Phase 2+.
 */
function ConnectionStatus({
  supabase,
  session,
  config,
}: {
  supabase: SupabaseClient
  session: Session
  config: AppConfig
}) {
  const [check, setCheck] = useState<ServerCheck>({ status: 'checking' })

  async function runCheck() {
    setCheck({ status: 'checking' })
    // getUser() makes a network request and validates the JWT server-side,
    // unlike getSession() which only reads local storage.
    const { data, error } = await supabase.auth.getUser()
    if (error) setCheck({ status: 'failed', message: error.message })
    else if (!data.user) setCheck({ status: 'failed', message: 'Server returned no user.' })
    else setCheck({ status: 'ok', checkedAt: new Date() })
  }

  useEffect(() => {
    void runCheck()
  }, [])

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true

  return (
    <main className="screen">
      <header className="top">
        <h1 className="wordmark small">AnalogScrobbler</h1>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>

      <section className="card">
        <h2>Setup check</h2>
        <dl className="checks">
          <dt>Signed in as</dt>
          <dd>{session.user.email}</dd>

          <dt>Supabase project</dt>
          <dd>{new URL(config.supabaseUrl).hostname}</dd>

          <dt>Server session check</dt>
          <dd>
            {check.status === 'checking' && <span className="muted">Checking…</span>}
            {check.status === 'ok' && (
              <span className="good">✓ Verified at {check.checkedAt.toLocaleTimeString()}</span>
            )}
            {check.status === 'failed' && <span className="error">✗ {check.message}</span>}
          </dd>

          <dt>Running as</dt>
          <dd>{standalone ? 'Home Screen app' : 'Browser tab'}</dd>
        </dl>
        <button className="secondary" onClick={() => void runCheck()} disabled={check.status === 'checking'}>
          Re-check
        </button>
      </section>

      <p className="muted footnote">Phase 1 · The collection arrives in Phase 2.</p>
    </main>
  )
}

function ConfigError({ problems }: { problems: string[] }) {
  return (
    <main className="screen center">
      <section className="card">
        <h2>Configuration needed</h2>
        <ul className="problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="muted">
          Locally: copy <code>web/.env.example</code> to <code>web/.env.local</code> and restart <code>npm run dev</code>.
          <br />
          On Cloudflare Pages: set the variables in project settings and redeploy.
        </p>
      </section>
    </main>
  )
}
