/**
 * Tag tokens and URLs. A sticker holds `<origin>/t/<token>`; the token is a
 * random lookup key with no meaning of its own (the database maps it to a copy).
 */

/** Same rule as the database check: 16–64 URL-safe characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

export const isValidToken = (t: string) => TOKEN_RE.test(t)

/**
 * 16 random bytes → 22 base64url characters (128 bits, unguessable). The full
 * URL is ~63 characters, well within an NTAG213's 144 bytes.
 */
export function newToken(random: (a: Uint8Array<ArrayBuffer>) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  const bytes = random(new Uint8Array(16))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function tagUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/t/${token}`
}

/** A URL written now only works where the app is reachable, so warn about local addresses. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local') || /^192\.168\.|^10\./.test(host)
  } catch {
    return true
  }
}
