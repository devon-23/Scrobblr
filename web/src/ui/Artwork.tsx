import { useState } from 'react'

/** Album artwork with a plain "no image" square when the URL is missing or 404s (Cover Art Archive often has none). */
export function Artwork({ urls, alt, className }: { urls: (string | null | undefined)[]; alt: string; className?: string }) {
  const candidates = urls.filter((u): u is string => !!u)
  const [index, setIndex] = useState(0)
  const src = candidates[index]

  if (!src) {
    return (
      <span className={`art missing ${className ?? ''}`} role="img" aria-label={alt}>
        no image
      </span>
    )
  }
  return (
    <img
      className={`art ${className ?? ''}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setIndex((i) => i + 1)}
    />
  )
}
