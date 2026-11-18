/**
 * Loads and validates public runtime configuration from Vite env variables.
 *
 * Validation fails loudly (the app shows a configuration screen) rather than
 * limping along with a half-working Supabase client.
 */

export interface AppConfig {
  supabaseUrl: string
  supabaseKey: string
}

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; problems: string[] }

/** Returns true if the key is a Supabase secret / service_role key, which must never ship to a browser. */
function looksLikeSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true

  // Legacy keys are JWTs; the payload's `role` claim tells anon from service_role.
  const parts = key.split('.')
  if (parts.length === 3 && parts[1]) {
    try {
      const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
      const payload: unknown = JSON.parse(json)
      if (typeof payload === 'object' && payload !== null && 'role' in payload) {
        return (payload as { role: unknown }).role === 'service_role'
      }
    } catch {
      // Not a decodable JWT — fall through.
    }
  }
  return false
}

export function loadConfig(env: ImportMetaEnv = import.meta.env): ConfigResult {
  const problems: string[] = []
  const url = env.VITE_SUPABASE_URL?.trim() ?? ''
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

  if (!url) {
    problems.push('VITE_SUPABASE_URL is not set.')
  } else {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        problems.push('VITE_SUPABASE_URL must use https.')
      }
      if (parsed.hostname.includes('your-project-ref')) {
        problems.push('VITE_SUPABASE_URL still contains the example value.')
      }
    } catch {
      problems.push(`VITE_SUPABASE_URL is not a valid URL: "${url}"`)
    }
  }

  if (!key) {
    problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is not set.')
  } else if (key.includes('xxxxxxxx')) {
    problems.push('VITE_SUPABASE_PUBLISHABLE_KEY still contains the example value.')
  } else if (looksLikeSecretKey(key)) {
    problems.push(
      'VITE_SUPABASE_PUBLISHABLE_KEY is a SECRET (service_role) key. Remove it immediately, ' +
        'rotate it in the Supabase dashboard, and use the publishable/anon key instead.',
    )
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, config: { supabaseUrl: url, supabaseKey: key } }
}
