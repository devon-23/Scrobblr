# AnalogScrobbler — Roadmap

Status tracker. Each phase ends with a test checklist; the next phase starts only
after it passes on a real device.

| # | Phase | Status |
|---|---|---|
| 1 | Architecture & project setup | 🟡 Built — waiting on your device test |
| 2 | Physical music library | 🟡 Built — waiting on your device test |
| 3 | Listening session engine | 🟡 Built — waiting on your device test |
| 4 | Last.fm integration | ✅ Working — first real scrobbles accepted 2026-11-20 |
| 5 | NFC tags | 🟡 Built, migration applied — waiting on stickers |
| 6 | History, statistics, polish | 🟡 Built — waiting on your test |
| 7 | Field testing & refinement | ⬜ Not started |

## Phase 1 — Architecture & project setup

- [x] Decide platform: web app (Cloudflare Workers static assets) + Supabase, not native iOS
- [x] Repo layout, `.gitignore`, env examples
- [x] Vite + React + TypeScript app in `web/`
- [x] Supabase email/password sign-in (single user, public sign-ups disabled)
- [x] Supabase CLI config in `supabase/`
- [x] Home Screen manifest + icons
- [ ] Supabase project: user created, sign-ups disabled
- [ ] Sign in works locally (`npm run dev`)
- [ ] Deployed to Cloudflare (Worker `scrobblr`, workers.dev), build vars set, `/settings` loads (not 404)
- [ ] Opened on iPhone 16, added to Home Screen, signed in

## Phase 2 — Physical music library

- [x] Migration `supabase/migrations/20261118000000_library.sql`: albums, physical_copies,
      tracks, copy_sides, copy_tracks, RLS, `save_physical_copy` / `delete_physical_copy`
- [x] Migration verified on Postgres (PGlite): 24 checks incl. RLS isolation, transactional saves
- [x] MusicBrainz client (rate-limited queue, retries on "server busy"); tested live from a browser
- [x] Sides derived from sleeve numbering (A1/B2…, ONE 1/TWO 1…), with warnings when unknown
- [x] Collection grid (search, vinyl/CD filter, sort), album page, add flow, copy/tracklist editor
- [x] Early-2000s visual style
- [ ] `supabase db push --remote` applied to your project
- [ ] Add Blurryface (or similar) on CD **and** vinyl → one album, two copies
- [ ] Edit a tracklist (rename side, move/split/remove a track) and save
- [ ] Delete a copy; delete the last copy → album disappears
- [ ] Same checks on the iPhone Home Screen app


## Phase 3 — Listening session engine

- [x] Migration `20261118100000_listening.sql`: listening_sessions (one active per user),
      session_events, session_plays; played tracks are never deleted by tracklist cleanup
- [x] Owner-consistent foreign keys on every table (fixes cross-user references that RLS alone
      allowed — found by the SQL tests); redundant FKs dropped so PostgREST embeds stay unambiguous
- [x] Pure engine (`web/src/engine/`): replay events → plays, Last.fm eligibility, side stops,
      pause/resume, next/prev/skip/restart/select/"wrong track", flip prompt, stale-return check
- [x] Local-first storage with an outbox; idempotent sync to Supabase; offline works end to end
- [x] Ready screen (Start Listening) and Now Listening screen; optional keep-screen-on
- [ ] `supabase db push --remote` (second migration)
- [ ] Real record: start, let a side run with the phone locked, unlock → correct track; flip → Side B
- [ ] Pause/resume, next, skip, wrong track on a real session
- [ ] Close the app mid-side, reopen → same position; reopen >15 min after a side ended → prompt
- [ ] Airplane mode: listen, end, start another record, reconnect → both sessions upload
- [ ] Safari tab vs Home Screen app show the same session

Decisions taken (defaults, change any time):
- Real time counts while the phone sleeps; vinyl stops at each side end, CD plays through,
  multi-disc stops between discs.
- If nobody checked in and a side ended > 15 min ago, plays wait for "yes, I heard it" /
  "I stopped after…".
- Skip and Restart never count; Next/Prev/End count if enough was heard.

Deferred, on purpose:
- **Lock-screen "flip the record" alert.** Needs Web Push sent by the server at the right time
  (VAPID keys + scheduled job), on top of Phase 4's Edge Function. Until then the prompt
  shows when you open the app, or live if "keep screen on" is enabled.
- **Gap between tracks.** Durations come from MusicBrainz; real vinyl adds a few seconds per
  track. Use Next / "wrong track?" for now; add a per-copy offset only if real use shows drift.

## Phase 4 — Last.fm

- [x] Migration `20261118300000_lastfm.sql`: lastfm_accounts (browser can't read keys),
      user_settings (dry run ON by default), scrobbles queue (one per final counted play, unique),
      atomic `claim_scrobbles`, final plays frozen, explicit service_role grants
- [x] `lastfm` Edge Function: auth URL, connect (auth.getSession), disconnect, Now Playing,
      batched flush (≤50), requeue; signs server-side; inspects response bodies, not just HTTP codes
- [x] Retry rules: temporary errors/rate limits/daily limit → backoff; invalid session key → keep
      queue, ask to reconnect; invalid request → split batch, mark only the bad item failed
- [x] Settings: connect/disconnect, scrobbling on/off, dry run, scrobble log with retry
- [x] Now Listening: per-track Last.fm status, Now Playing status
- [x] Tests: 35 Deno (signing vs Python md5, fake Last.fm end to end), SQL checks for queue/RLS/claim
- [ ] Register Last.fm API account; set secrets; `db push --remote`; `functions deploy lastfm`
- [ ] Connect in Safari; confirm username shows
- [ ] Dry run ON: listen to a few tracks → log shows "dry run (not sent)", Last.fm profile unchanged
- [ ] Dry run OFF: one track → appears on your Last.fm profile with the right time
- [ ] Airplane mode during a session → reconnect → queued scrobbles go out once (no duplicates)

Known limits:
- **Now Playing only while the app is open.** iOS suspends web pages; scrobbles still go out with the
  right timestamps when you next open the app.
- **Sending needs the app open** (it asks the function to flush after each upload, and on launch).
  A server-side scheduled flush (pg_cron) can come later if wanted.
- **At-least-once in one narrow case:** if Last.fm accepts a batch but the reply is lost, the batch is
  retried after 10 minutes and could appear twice. Everything else is exactly-once.
- **Last.fm reply formats** are implemented from Last.fm's documentation and tested against a fake;
  the first real connection is the real test. Unexpected shapes are treated as "retry later".

## Phase 5 — NFC
Tags hold `https://scrobblr.cbark1313.workers.dev/t/<token>` (NTAG213/215, left unlocked while testing).

- [x] Migration `20261119000000_nfc_tags.sql`: `nfc_tags` (random token → copy, owner-only RLS,
      owner-aware FK, deleting a copy unlinks its tags), `scan_nfc_tag()` looks up + counts a tap
- [x] `/t/<token>`: linked tag → that copy's Start Listening screen (never auto-starts), or Now
      Listening if that record is already on; unknown/unlinked tag → "which record is it on?" picker
- [x] Album page: "tag" link + tag summary per copy; tag page: make link, Copy, try it, unlink,
      NFC Tools instructions, warning when making links from localhost
- [x] Tests: 25 SQL checks (isolation, upsert takeover refused, unlinking on delete), token tests,
      browser run of every flow against a fake backend
- [ ] `supabase db push --remote` (new migration), push to deploy
- [ ] Safari on iPhone: sign in once (tags open in Safari, not the Home Screen app)
- [ ] One copy → tag → Make a tag link → Copy → NFC Tools write → tap → Start Listening opens
- [ ] Tap it again while that record is playing → Now Listening
- [ ] A sticker written with a link for a copy you then unlink → tap → picker → link to another copy
- [ ] Find a sticker spot per format (jacket / inner sleeve / CD tray) that reads first time

Known limits:
- **Tags open in Safari**, not the Home Screen app (iOS doesn't let Home Screen apps claim links).
  Safari needs its own sign-in once; sessions sync between the two through the server.
- **Needs a connection** to look up a tag (same as loading a record).

## Phase 6 — History, statistics, polish

- [x] Migration `20261120000000_stats.sql`: `listening_stats(p_since, p_tz)` — totals, vinyl vs CD,
      most played vinyl / CDs, top artists, top songs, by month (local time zone), collection counts.
      Computed from our own plays (security invoker, RLS); "played" = counts, "scrobbled" = accepted
- [x] Home: now playing card, recently played albums, recently scrobbled, collection tiles
- [x] History: every play grouped by session, vinyl/CD filter, counted-only, search (' matches ’),
      Last.fm status per track with failure/skip reasons inline, paging
- [x] Stats: period filter, tiles, vinyl/CD split, monthly chart (+ table view), top lists
- [x] Settings: NFC box (untagged copies → tag it), album data note
- [x] Polish: nav home | collection | history | stats | settings; long-pause notice (2 h+) with
      End session; start time shows the date when it wasn't today
- [x] Tests: 21 SQL checks (formats, case-merged songs, time zones, period, isolation), helper
      tests, query run read-only against the real database, browser run of every page
- [ ] `supabase db push --remote` (new migration), push to deploy
- [ ] Home / History / Stats show your real plays; numbers match what you listened to
- [ ] History vinyl/CD filter and search on the phone

## Phase 7 — Field testing

## Open decisions
- ~~Domain written on tags~~ — decided 2026-11-19: `https://scrobblr.cbark1313.workers.dev/t/<token>`.
  Tags can't change once written, so moving to a custom domain later means rewriting every tag.
- **Behaviour defaults** (needed before Phase 3): phone-asleep policy, when to scrobble,
  multi-disc prompts, scanning another album mid-session, starting mid-album.
- ~~MusicBrainz contact~~ — not needed: browsers can't set User-Agent and MusicBrainz accepts browser requests.
- ~~Visual direction~~ — simple early-2000s profile-page look.
