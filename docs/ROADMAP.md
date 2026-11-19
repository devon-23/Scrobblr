# AnalogScrobbler — Roadmap

Status tracker. Each phase ends with a test checklist; the next phase starts only
after it passes on a real device.

| # | Phase | Status |
|---|---|---|
| 1 | Architecture & project setup | 🟡 Built — waiting on your device test |
| 2 | Physical music library | 🟡 Built — waiting on your device test |
| 3 | Listening session engine | 🟡 Built — waiting on your device test |
| 4 | Last.fm integration | ⬜ Not started |
| 5 | NFC tags | ⬜ Not started |
| 6 | History, statistics, polish | ⬜ Not started |
| 7 | Field testing & refinement | ⬜ Not started |

## Phase 1 — Architecture & project setup

- [x] Decide platform: web app (Cloudflare Pages) + Supabase, not native iOS
- [x] Repo layout, `.gitignore`, env examples
- [x] Vite + React + TypeScript app in `web/`
- [x] Supabase email/password sign-in (single user, public sign-ups disabled)
- [x] Supabase CLI config in `supabase/`
- [x] Home Screen manifest + icons
- [ ] Supabase project: user created, sign-ups disabled
- [ ] Sign in works locally (`npm run dev`)
- [ ] Deployed to Cloudflare Pages, env vars set
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
  (VAPID keys + scheduled job). Built on Phase 4's Edge Functions/cron. Until then the prompt
  shows when you open the app, or live if "keep screen on" is enabled.
- **Gap between tracks.** Durations come from MusicBrainz; real vinyl adds a few seconds per
  track. Use Next / "wrong track?" for now; add a per-copy offset only if real use shows drift.

## Phase 4 — Last.fm
Web auth flow via Edge Function · Now Playing · eligibility rules · dry-run mode ·
local outbox + server queue · batching · retries · duplicate prevention.

## Phase 5 — NFC
Tag tokens · `/t/<token>` route · unknown/unassigned tags · reassignment ·
writing URLs with NFC Tools · real-tag testing.

## Phase 6 — History, statistics, polish

## Phase 7 — Field testing

## Open decisions
- **Domain written on tags** (needed before Phase 5): `*.pages.dev` subdomain or a custom domain.
- **Behaviour defaults** (needed before Phase 3): phone-asleep policy, when to scrobble,
  multi-disc prompts, scanning another album mid-session, starting mid-album.
- ~~MusicBrainz contact~~ — not needed: browsers can't set User-Agent and MusicBrainz accepts browser requests.
- ~~Visual direction~~ — simple early-2000s profile-page look.
