# AnalogScrobbler

Scrobble vinyl records and CDs to Last.fm. Tap an NFC sticker on the sleeve and the app
starts following the tracklist and scrobbling for you (or pick a record in the app and press
**Start Listening**). A session with nothing playing for 40 minutes ends itself.

A personal web app: **Cloudflare Workers** (static front end) + **Supabase** (database, auth,
server functions). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ROADMAP.md](docs/ROADMAP.md).

```
web/        Vite + React + TypeScript app (deployed to Cloudflare Workers, see web/wrangler.jsonc)
supabase/   Supabase CLI config, migrations, Edge Functions
docs/       Architecture and roadmap
```

## Setup

### 1. Supabase project
1. In the [Supabase dashboard](https://supabase.com/dashboard), create a project
   (name it e.g. `analogscrobbler`). Save the database password in your password manager.
2. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   This app has exactly one user.
3. **Authentication → Users → Add user → Create new user**: your email + a strong password,
   with **Auto Confirm User** checked.
4. **Project Settings → API Keys**: note the **Project URL** and the **Publishable key**.
   Never use the secret / `service_role` key in the web app.

### 2. Run locally
```bash
cd web
cp .env.example .env.local   # then fill in the two values
npm install
npm run dev
```
Open http://localhost:5173 and sign in. The setup screen should show
**Server session check: ✓ Verified**.

### 3. Supabase CLI + database tables
```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --remote
```
The project ref is the `xxxx` in `https://xxxx.supabase.co`. `--remote` targets your linked project
(newer CLI versions default to a local Docker stack, which this project doesn't use). It applies everything in
`supabase/migrations/` that your project doesn't have yet; run it again whenever a phase adds one.

### 4. Deploy to Cloudflare (Workers)
1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the repo.
3. Build settings (on an existing Worker: **Settings → Build**):
   - Project/Worker name: `scrobblr` (must match `name` in `web/wrangler.jsonc`)
   - Root directory (path): `web`
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
4. **Build variables** (Settings → Build → Variables and secrets, *not* the runtime
   "Variables and Secrets" section): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
   and `NODE_VERSION` = `22`. Vite bakes these into the bundle at build time, so changing
   them needs a new build (Deployments → retry, or push a commit).
5. Deploy. The app is served at `https://scrobblr.<your-account>.workers.dev`.
   `web/wrangler.jsonc` publishes only `dist/` and serves `index.html` for every unknown
   path, which lets `/settings`, `/lastfm/callback` and later tag URLs (`/t/<token>`) reach the app.

Check it worked: `https://<your-url>/settings` should load the app (not a 404), and the page
source should reference `/assets/index-….js`, not `/src/main.tsx`.

### 5. On your iPhone
Open the `workers.dev` URL in Safari → Share → **Add to Home Screen**. Launch it from
the Home Screen and sign in; the setup screen should say **Running as: Home Screen app**.

### 6. Last.fm (Phase 4)
1. Create an API account at https://www.last.fm/api/account/create (any name/description; the
   callback URL can be left blank). You get an **API key** and a **shared secret**. Never paste the
   secret into the app, chat, or git.
2. Put them in `supabase/functions/.env` (gitignored), copying `supabase/functions/.env.example`,
   and set `ALLOWED_ORIGINS` to where the app runs (e.g. `http://localhost:5173,https://scrobblr.<your-account>.workers.dev`).
3. Upload the secrets, apply the migration, deploy the function:
   ```bash
   supabase secrets set --env-file supabase/functions/.env
   supabase db push --remote
   supabase functions deploy lastfm
   ```
4. In the app: Settings → **Connect Last.fm** (in Safari on iPhone). **Dry run is on** by default —
   nothing reaches your profile until you untick it.

### 7. NFC tags (Phase 5)
1. `supabase db push --remote` (adds the `nfc_tags` table), and push to deploy the app.
2. Buy NTAG213 or NTAG215 stickers and install **NFC Tools** (free) on your iPhone.
3. In the app on your phone: an album → **tag** next to a copy → **Make a tag link** → **Copy**.
4. NFC Tools → Write → Add a record → URL / URI → paste → Write → hold the phone to the sticker.
   Don't lock the tag while testing.
5. Tap the sticker with the phone's top edge: Safari opens and the record starts playing in the app.
   Use **test link** on the tag page to check a tag without starting a session.

### 8. History and stats (Phase 6)
`supabase db push --remote` (adds `listening_stats()`), then push to deploy. Home, History and
Stats read your existing plays; nothing to set up.

### 9. Import from Discogs
`supabase db push --remote` (adds `discogs_imports`), then push to deploy. In the app: **add →
Import from Discogs**, enter your Discogs username. Your Discogs collection must be **public**
(discogs.com → Settings → Privacy); no password or token is used. Vinyl and CDs are matched to
MusicBrainz (exact edition), else Discogs' tracklist; incomplete ones wait for you to review or
enter by hand. Running it again only offers what's new.

## Tests
```bash
cd web && npm test                                       # app + engine
cd supabase/functions && deno test --allow-net=jsr.io    # Last.fm signing + Edge Function
```

## Security notes
- `.env.local` and all `.env.*` files are gitignored; only `*.example` files are committed.
- `VITE_*` values are public by design. Data is protected by Supabase Row Level Security.
- The app refuses to start if it detects a Supabase secret key in its config.
- The Last.fm API secret lives only in Supabase Edge Function secrets; the session key only in a
  table the browser can't read. All signed Last.fm calls happen in the `lastfm` Edge Function.
