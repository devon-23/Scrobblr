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
    <main className="screen center">
      <div className="record-mark" aria-hidden="true" />
      <h1 className="wordmark">AnalogScrobbler</h1>
      <p className="muted">Your records and CDs, scrobbled.</p>

      <form className="card form" onSubmit={onSubmit}>
        <label>
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
