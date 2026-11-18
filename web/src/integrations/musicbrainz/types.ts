/** The subset of MusicBrainz JSON (ws/2) responses that AnalogScrobbler uses. */

export interface MbArtistCredit {
  name: string
  joinphrase?: string
  artist: { id: string; name: string }
}

export interface MbReleaseGroup {
  id: string
  title: string
  'primary-type'?: string | null
  'secondary-types'?: string[]
  'first-release-date'?: string
  'artist-credit'?: MbArtistCredit[]
  score?: number
}

export interface MbTrack {
  number: string
  position: number
  title: string
  length?: number | null
  'artist-credit'?: MbArtistCredit[]
  recording: { id: string; title: string; length?: number | null }
}

export interface MbMedium {
  position: number
  format?: string | null
  title?: string
  'track-count'?: number
  tracks?: MbTrack[]
}

export interface MbLabelInfo {
  'catalog-number'?: string | null
  label?: { name?: string | null } | null
}

export interface MbRelease {
  id: string
  title: string
  status?: string | null
  date?: string
  country?: string | null
  barcode?: string | null
  disambiguation?: string
  'cover-art-archive'?: { front?: boolean }
  'artist-credit'?: MbArtistCredit[]
  'release-group'?: Pick<MbReleaseGroup, 'id' | 'title' | 'first-release-date' | 'primary-type'>
  'label-info'?: MbLabelInfo[]
  media: MbMedium[]
}
