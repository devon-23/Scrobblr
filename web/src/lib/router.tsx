/**
 * A ~50-line router on the History API. The app has a handful of routes, so a
 * routing library would be more code to learn than to write. Real paths (not
 * #hashes) are needed so NFC tag URLs like /t/<token> work in Phase 5.
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

const EVENT = 'app:navigate'

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb)
  window.addEventListener(EVENT, cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener(EVENT, cb)
  }
}

const snapshot = () => window.location.pathname + window.location.search

export function useLocation(): { path: string; query: URLSearchParams } {
  const full = useSyncExternalStore(subscribe, snapshot)
  const [path = '/', search = ''] = full.split('?')
  return { path, query: new URLSearchParams(search) }
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.scrollTo(0, 0)
  window.dispatchEvent(new Event(EVENT))
}

/** Matches "/album/:id" against "/album/123" → { id: "123" }, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(s[i]!)
    else if (seg !== s[i]) return null
  }
  return params
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return <a href={to} onClick={handle} {...rest} />
}
