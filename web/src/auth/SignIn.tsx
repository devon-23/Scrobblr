import { useState, type FormEvent } from 'react'
import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js'

export function SignIn({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    // On success, useSession picks up the new session via onAuthStateChange.
    if (error) {
      setError(
        isAuthRetryableFetchError(error)
          ? `Couldn't reach Supabase (${error.message}). Check your connection and VITE_SUPABASE_URL.`
          : error.message,
      )
    }
    setBusy(false)
  }

  return (
    <div className="signin">
      <header className="masthead">
        <span className="name">AnalogScrobbler</span>
        <span className="tag">records &amp; cds, scrobbled</span>
      </header>
      <section className="box">
        <div className="box-head">
          <h2>Member Login</h2>
        </div>
        <div className="box-body">
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              <label htmlFor="email">E-Mail</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <p className="errorbox" role="alert" style={{ marginTop: 8 }}>
                {error}
              </p>
            )}
            <p style={{ marginTop: 8 }}>
              <button type="submit" disabled={busy}>
                {busy ? 'Logging in…' : 'Login'}
              </button>
            </p>
          </form>
        </div>
      </section>
    </div>
  )
}
