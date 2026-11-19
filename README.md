# AnalogScrobbler

Scrobble vinyl records and CDs to Last.fm. Tap an NFC sticker on the sleeve, press
**Start Listening**, and the app follows the tracklist and scrobbles for you.

A personal web app: **Cloudflare Pages** (front end) + **Supabase** (database, auth,
server functions). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ROADMAP.md](docs/ROADMAP.md).

```
web/        Vite + React + TypeScript app (deployed to Cloudflare Pages)
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

### 4. Deploy to Cloudflare Pages
1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick the repo.
3. Build settings:
   - Project name: `analogscrobbler` (becomes `analogscrobbler.pages.dev` if available)
   - Framework preset: **None** (or Vite)
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: `web`
4. Environment variables (Production *and* Preview):
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `NODE_VERSION` = `22`.
5. Deploy. Pages has no `404.html` here, so it serves `index.html` for every path —
   that's what lets tag URLs like `/t/<token>` reach the app later.

### 5. On your iPhone
Open the `pages.dev` URL in Safari → Share → **Add to Home Screen**. Launch it from
the Home Screen and sign in; the setup screen should say **Running as: Home Screen app**.

### 6. Last.fm (Phase 4)
1. Create an API account at https://www.last.fm/api/account/create (any name/description; the
   callback URL can be left blank). You get an **API key** and a **shared secret**. Never paste the
   secret into the app, chat, or git.
2. Put them in `supabase/functions/.env` (gitignored), copying `supabase/functions/.env.example`,
   and set `ALLOWED_ORIGINS` to where the app runs (e.g. `http://localhost:5173,https://analogscrobbler.pages.dev`).
3. Upload the secrets, apply the migration, deploy the function:
   ```bash
   supabase secrets set --env-file supabase/functions/.env
   supabase db push --remote
   supabase functions deploy lastfm
   ```
4. In the app: Settings → **Connect Last.fm** (in Safari on iPhone). **Dry run is on** by default —
   nothing reaches your profile until you untick it.

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
