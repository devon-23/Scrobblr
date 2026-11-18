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
supabase db push
```
The project ref is the `xxxx` in `https://xxxx.supabase.co`. `db push` applies everything in
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

## Tests
```bash
cd web && npm test
```

## Security notes
- `.env.local` and all `.env.*` files are gitignored; only `*.example` files are committed.
- `VITE_*` values are public by design. Data is protected by Supabase Row Level Security.
- The app refuses to start if it detects a Supabase secret key in its config.
- Last.fm secrets (Phase 4) will live only in Supabase Edge Function secrets.
