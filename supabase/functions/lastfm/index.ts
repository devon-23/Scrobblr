/**
 * lastfm Edge Function entry point: wires the handler to Supabase.
 *
 * Secrets (set with `supabase secrets set`, never committed):
 *   LASTFM_API_KEY, LASTFM_SHARED_SECRET, ALLOWED_ORIGINS
 * Provided by Supabase automatically:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { createHandler, type QueuePatch, type QueueRow, type Store } from './handler.ts'

function env(name: string, ...fallbacks: string[]): string {
  for (const n of [name, ...fallbacks]) {
    const v = Deno.env.get(n)
    if (v) return v
  }
  throw new Error(`Missing environment variable ${name}. Set it with: supabase secrets set ${name}=...`)
}

const url = env('SUPABASE_URL')
const anonKey = env('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY')
const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY')
// Service-role client: bypasses RLS. Used only for the tables the browser may not write.
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const fail = (what: string, error: { message: string } | null) => {
  if (error) throw new Error(`${what}: ${error.message}`)
}

const store: Store = {
  async getAccount(userId) {
    const { data, error } = await admin
      .from('lastfm_accounts')
      .select('username, session_key, needs_reauth')
      .eq('owner_id', userId)
      .maybeSingle()
    fail('Reading Last.fm account', error)
    return data ? { username: data.username, sessionKey: data.session_key, needsReauth: data.needs_reauth } : null
  },
  async saveAccount(userId, username, sessionKey) {
    const { error } = await admin
      .from('lastfm_accounts')
      .upsert({ owner_id: userId, username, session_key: sessionKey, needs_reauth: false, connected_at: new Date().toISOString() })
    fail('Saving Last.fm account', error)
  },
  async deleteAccount(userId) {
    const { error } = await admin.from('lastfm_accounts').delete().eq('owner_id', userId)
    fail('Removing Last.fm account', error)
  },
  async setNeedsReauth(userId, value) {
    const { error } = await admin.from('lastfm_accounts').update({ needs_reauth: value }).eq('owner_id', userId)
    fail('Updating Last.fm account', error)
  },
  async getSettings(userId) {
    const { data, error } = await admin.from('user_settings').select('scrobbling_enabled, dry_run').eq('owner_id', userId).maybeSingle()
    fail('Reading settings', error)
    // No row yet = defaults: enabled, DRY RUN.
    return { scrobblingEnabled: data?.scrobbling_enabled ?? true, dryRun: data?.dry_run ?? true }
  },
  async countDue(userId) {
    const { count, error } = await admin
      .from('scrobbles')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .eq('status', 'pending')
    fail('Counting queue', error)
    return count ?? 0
  },
  async claim(userId, limit) {
    const { data, error } = await admin.rpc('claim_scrobbles', { p_owner: userId, p_limit: limit })
    fail('Claiming queue items', error)
    return (data ?? []) as QueueRow[]
  },
  async update(id, patch: QueuePatch) {
    const { error } = await admin.from('scrobbles').update(patch).eq('id', id)
    fail('Updating queue item', error)
  },
  async requeueFailed(userId, ids) {
    if (ids.length === 0) return 0
    const { data, error } = await admin
      .from('scrobbles')
      .update({ status: 'pending', next_attempt_at: new Date().toISOString(), last_error: null })
      .eq('owner_id', userId)
      .eq('status', 'failed')
      .in('id', ids)
      .select('id')
    fail('Requeueing', error)
    return data?.length ?? 0
  },
}

const handler = createHandler({
  store,
  apiKey: env('LASTFM_API_KEY'),
  secret: env('LASTFM_SHARED_SECRET'),
  allowedOrigins: env('ALLOWED_ORIGINS')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
  async authenticate(authorization) {
    const jwt = authorization?.replace(/^Bearer\s+/i, '')
    if (!jwt) return null
    // Validates the JWT with Supabase Auth (works with both legacy and new signing keys).
    const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await client.auth.getUser(jwt)
    return error || !data.user ? null : data.user.id
  },
})

Deno.serve(handler)
