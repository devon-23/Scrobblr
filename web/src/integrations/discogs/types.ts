/** The parts of Discogs API responses this app reads. https://www.discogs.com/developers */

export interface DgArtist {
  name: string
  /** "Artist name variation": the name as credited on this release. */
  anv?: string
  /** How this artist joins the next one: ",", "&", "Feat.", "Vs." … */
  join?: string
}

export interface DgFormat {
  name: string // "Vinyl", "CD", "Cassette", "Box Set" …
  qty?: string
  descriptions?: string[] // ["LP", "Album", "Reissue"]
  text?: string // free text, often a colour: "Red Translucent"
}

export interface DgLabel {
  name: string
  catno?: string
}

export interface DgTrack {
  position: string
  type_?: 'track' | 'heading' | 'index'
  title: string
  duration: string
  artists?: DgArtist[]
  sub_tracks?: DgTrack[]
}

export interface DgRelease {
  id: number
  title: string
  year?: number
  country?: string
  artists: DgArtist[]
  formats: DgFormat[]
  labels?: DgLabel[]
  identifiers?: { type: string; value: string; description?: string }[]
  tracklist: DgTrack[]
  master_id?: number
}

export interface DgCollectionItem {
  /** Unique per item in the collection (owning a release twice = two instances). */
  instance_id: number
  id: number // release id
  basic_information: {
    id: number
    title: string
    year?: number
    artists: DgArtist[]
    formats: DgFormat[]
    labels?: DgLabel[]
    cover_image?: string
    thumb?: string
  }
}
