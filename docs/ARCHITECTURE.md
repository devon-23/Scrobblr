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
| `lib/` | Infrastructure: config loading, Supabase client |
| `auth/` | Sign-in state and screens |
| `engine/` *(Phase 3)* | Pure, UI-free session logic, unit-tested with a fake clock |
| `integrations/` *(Phase 2+)* | MusicBrainz / Cover Art Archive clients |
| `features/` *(Phase 2+)* | Screens: collection, listening, history, settings |

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
