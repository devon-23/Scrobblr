# AnalogScrobbler — Roadmap

Status tracker. Each phase ends with a test checklist; the next phase starts only
after it passes on a real device.

| # | Phase | Status |
|---|---|---|
| 1 | Architecture & project setup | 🟡 In progress |
| 2 | Physical music library | ⬜ Not started |
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
Migrations + RLS · MusicBrainz search · Cover Art Archive artwork · albums ·
physical copies (vinyl/CD) · editable tracklists · sides.

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
- **MusicBrainz contact** for the User-Agent (needed before Phase 2).
- **Visual direction** (needed before Phase 2 screens).
