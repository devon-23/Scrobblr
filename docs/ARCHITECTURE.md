# AnalogScrobbler — Architecture

## Overview

```
iPhone ──(background NFC read of https URL)──► Safari / Home Screen web app
                                                  │
                         Cloudflare Workers:  web/ (Vite + React + TypeScript, static)
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
| `nfc/` | Tag tokens/URLs (pure, tested) and `nfc_tags` data access |
| `integrations/musicbrainz/` | MusicBrainz client + pure mapping to drafts (tested with real fixtures) |
| `features/` | Screens: home, collection, album, add, copy editor, tags, listening, history, stats, settings |
| `history/` | History queries, `listening_stats()` call, display helpers (tested) |
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
- **Auto-end:** with nothing playing (paused, side/album finished) for `AUTO_END_AFTER_MS` (40 min),
  `replay()` reports `autoEndAt`; the provider records an `end` event at exactly that time (on the
  next tick, or on next launch if the app was closed). Plays up to the end of the side count.
- **Replacing:** `start(…, { replaceActive })` ends the current session (this device's or one
  fetched from the server) at the same instant; the outbox syncs it before the new session.
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

## NFC tags (Phase 5)

```
sticker: https://<app>/t/<token>  ──iPhone background read──► Safari
/t/<token> ─► scan_nfc_tag(token)  (RLS: owner only; counts the tap)
   linked   → start(side 1, track 1, at = page open, replaceActive) → /listening
              (same copy already playing → just /listening; ?test=1 → only says what it opens)
   unknown/unlinked → pick a copy → upsert nfc_tags on token → /listen/<copyId> (Start screen)
```
- The token is 22 random base64url characters (128 bits) and carries no meaning; the
  `nfc_tags` row maps it to a copy, so tags can be moved or replaced without rewriting stickers.
- `physical_copy_id` uses the owner-aware FK with `on delete set null`, so deleting a copy
  leaves its stickers reusable instead of breaking them.
- Signed-out taps hit the sign-in screen and continue to the tag after sign-in; another
  user's token behaves exactly like an unknown one.

## History and statistics (Phase 6)

- History reads `session_plays` with its session (format) and scrobble (Last.fm status) embedded.
- Statistics come from one database function, `listening_stats(p_since, p_tz)`, so the browser
  never downloads every play. It runs as the caller (RLS), counts plays that meet the scrobble
  rule whether or not they were sent, and splits months in the caller's time zone.
- Chart colours: vinyl `#d9711c`, CD `#3f6fc0` (checked for colour-blind separation and contrast);
  every chart also has labels or a table, so colour is never the only cue.

## Configuration

- `web/.env.local` (gitignored) — copy from `web/.env.example`.
  `VITE_*` values are compiled into the public bundle, so only public values go
  there (Supabase URL + publishable/anon key, which is safe because RLS protects data).
- Cloudflare Worker → Settings → Build → build variables: same `VITE_*` values (baked in at build time).
- Supabase Edge Function secrets *(Phase 4)*: set with `supabase secrets set`, never in git.

## Auth model

Single Supabase Auth user (email + password), public sign-ups disabled. Every
table gets `owner_id = auth.uid()` RLS policies, which keeps the door open for
more users later at almost no cost.
