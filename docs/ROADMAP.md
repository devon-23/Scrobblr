# AnalogScrobbler — Roadmap

Status tracker. Each phase ends with a test checklist; the next phase starts only
after it passes on a real device.

| # | Phase | Status |
|---|---|---|
| 1 | Architecture & project setup | 🟡 Built — waiting on your device test |
| 2 | Physical music library | 🟡 Built — waiting on your device test |
| 3 | Listening session engine | ⬜ Not started |
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
- [ ] `supabase db push` applied to your project
- [ ] Add Blurryface (or similar) on CD **and** vinyl → one album, two copies
- [ ] Edit a tracklist (rename side, move/split/remove a track) and save
- [ ] Delete a copy; delete the last copy → album disappears
- [ ] Same checks on the iPhone Home Screen app

Phase 3 reminder: `save_physical_copy` / `delete_physical_copy` delete tracks no copy uses;
extend those checks so tracks with listening history are never deleted.

## Phase 3 — Listening session engine
Event-log session model · duration-based progression · pause/resume · side
flips · manual corrections · restore after closing the app · side-end alerts.

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
