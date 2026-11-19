# AnalogScrobbler — Architecture

## Overview

```
iPhone ──(background NFC read of https URL)──► Safari / Home Screen web app
                                                  │
                         Cloudflare Pages: web/ (Vite + React + TypeScript)
                                                  │ supabase-js
                                    Supabase: Postgres + RLS + Auth
                                              Edge Functions (Last.fm signing)
                                              pg_cron (queued scrobble retries)
                                                  │
                                    Last.fm API · MusicBrainz · Cover Art Archive
```

## Why a web app instead of native iOS

iPhones (XS and later) read NFC tags in the background whenever the phone is
unlocked. A tag containing an `https://` URL shows a banner; tapping it opens the
URL in Safari. So tags can open the right album without a native app, an Apple
Developer membership, or Xcode.

Trade-offs accepted:
- Tags are written with a free tag-writing app (NFC Tools / NXP TagWriter), not from our app.
- No in-app "scan" button — background reading plus search covers it.
- Side-end alerts need Web Push (Home Screen install required).
- Tag links open in Safari, not the Home Screen app; session state therefore lives
  on the server so both contexts agree.

Tag URLs (`https://<domain>/t/<token>`) can later be claimed by a native app via
universal links, so tags written now stay valid.

## Separation of concerns (`web/src`)

| Folder | Responsibility |
|---|---|
| `lib/` | Infrastructure: config, Supabase client + context, router, durations |
| `auth/` | Sign-in state and screen |
| `library/` | Library types and Supabase data access (`api.ts`) |
| `integrations/musicbrainz/` | MusicBrainz client + pure mapping to drafts (tested with real fixtures) |
| `features/` | Screens: collection, album, add, copy editor, listening, settings |
| `ui/` | Shared layout pieces (page frame, boxes, artwork) |
| `engine/` | Pure, UI-free session logic, unit-tested with a fake clock |
| `listening/` | Session storage, sync, and the React provider (clock, wake lock) |

## Library data model (Phase 2)

```
albums ─┬─< physical_copies ─< copy_sides ─< copy_tracks >─ tracks
        └──────────────────────────────────────────────────────┘
```
- **albums** = the musical work (MusicBrainz release group). Unique per user + release group,
  so the same album on CD and vinyl is one row.
- **physical_copies** = a thing on the shelf (MusicBrainz release): format, edition, label, barcode.
- **tracks** = songs of an album, shared across copies (matched by MusicBrainz recording),
  so play counts merge across formats.
- **copy_sides** = ordered sides ("A", "B" / "Disc 1"). The listening engine stops between sides.
- **copy_tracks** = a track's position on a side of a copy, with an optional per-edition
  duration override.
- Composite foreign keys stop a copy_track pointing at another copy's side or another album's track.
- Saving a copy goes through `save_physical_copy(jsonb)`, which replaces the tracklist in one
  transaction (SECURITY INVOKER, so RLS still applies).

## Listening sessions (Phase 3)

- A session is an **append-only event log** (`start`, `pause`, `next`, `startSide`, `end`…), each
  event with a browser-generated id and UTC timestamp. `web/src/engine/engine.ts` replays the log
  against a frozen tracklist ("program") at a given time and derives the plays. No timers count
  anything; reopening the app just replays with the new time.
- Progress between events is an **estimate from durations** — the app can't hear the record. The
  engine takes the same events a future audio detector could emit.
- **Local first:** events go to `localStorage` before the network. A finished session waits in a
  local outbox until the server has everything. Uploads are idempotent (events by id, plays by
  `(session, seq)`), so retries can't duplicate.
- **One active session per user** is enforced by a partial unique index.
- **Stale returns:** if a side ran out with nobody checking in for 15+ minutes, its plays stay
  provisional (`final = false`) until the user confirms or picks where they stopped.
- `session_plays.counts` = meets Last.fm's rule; `final` = can no longer change. Phase 4 will only
  scrobble plays that are both.

## Last.fm (Phase 4)

```
play uploaded as final + counts ──trigger──► scrobbles (pending)
app: after each upload / on launch ──► lastfm function "flush"
  claim_scrobbles (atomic) → dry run? mark dry_run : signed track.scrobble (≤50)
  → per item: accepted | ignored (reason) | pending+backoff | failed
```
- `supabase/functions/_shared/lastfm.ts`: signing, batching, response parsing, error classes (pure).
- `supabase/functions/lastfm/handler.ts`: actions; takes its store/fetch as parameters for tests.
- `supabase/functions/lastfm/index.ts`: wires Supabase (service role) and validates the caller's JWT.
- The browser reads `user_settings`, `scrobbles` and `lastfm_connection()`; it can't write the
  queue or read the session key.

Server-side secrets (Last.fm API secret, session key) live only in Supabase Edge
Function secrets and a table the browser cannot read.

## Configuration

- `web/.env.local` (gitignored) — copy from `web/.env.example`.
  `VITE_*` values are compiled into the public bundle, so only public values go
  there (Supabase URL + publishable/anon key, which is safe because RLS protects data).
- Cloudflare Pages → project settings → environment variables: same `VITE_*` values.
- Supabase Edge Function secrets *(Phase 4)*: set with `supabase secrets set`, never in git.

## Auth model

Single Supabase Auth user (email + password), public sign-ups disabled. Every
table gets `owner_id = auth.uid()` RLS policies, which keeps the door open for
more users later at almost no cost.
