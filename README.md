# Homebase Passdown — iPhone Setup

A home work-order and PM tracking PWA. Three steps: host it, wire up sync, add to your home screens.

## What's in this folder

| File | Purpose |
|---|---|
| `index.html` | The entire app (React bundled inside — no build step needed to host) |
| `manifest.webmanifest` | Makes it installable as a home-screen app |
| `sw.js` | Service worker — caches the app so it opens offline |
| `icons/` | Home-screen icons |
| `src/` | Source (app.jsx + styles.css) for future edits — bring these back to Claude to iterate |

## Step 1 — Host it (free, ~5 minutes)

**GitHub Pages:**
1. Create a repo on github.com (e.g. `homebase`). Note: free GitHub Pages repos are public — this folder contains no secrets (your sync keys are entered on each phone, never stored in these files), but use an unguessable repo name if you prefer.
2. Upload everything in this folder (keep the `icons/` folder structure).
3. Repo → Settings → Pages → Source: `Deploy from a branch`, Branch: `main`, folder `/ (root)` → Save.
4. After a minute your app is live at `https://<username>.github.io/homebase/`.

**Or Netlify:** log in at netlify.com → drag this folder onto the deploy area → done.

## Step 2 — Household sync (free, ~10 minutes, one time)

Without this the app still works — each phone just keeps its own data. To share one board:

1. Create a free account at supabase.com → **New project** (any name/password/region).
2. In the project, open **SQL Editor** → paste and run:

```sql
create table homebase_state (
  id int primary key,
  data jsonb,
  updated_at timestamptz default now()
);
alter table homebase_state enable row level security;
create policy "household access" on homebase_state
  for all using (true) with check (true);
```

3. Go to **Project Settings → API** and copy two values: the **Project URL** (`https://xxxx.supabase.co`) and the **anon public** key.
4. On each phone, open the app → tap **⚙** in the orange bar → paste the URL and key, set each person's **Display name** (e.g. `C. Kuehn` on yours, `S. Kuehn` on theirs) → **Test connection** → **Save**.

The sync chip in the header shows the state: green **Synced**, yellow syncing, red offline (changes save locally and push when you're back online). It pulls every 20 seconds and whenever the app regains focus; tapping the chip syncs immediately.

**Sync model:** the whole board is one shared document, last-write-wins. For two people updating a few times a day this is plenty; if you both edit within the same second, the later save wins.

**Security note:** anyone who has both the URL and the anon key can read/write your board, so treat the pair like a shared house key — it lives only in each phone's browser storage, not in the hosted files.

## Step 3 — Add to Home Screen (each phone)

1. Open your hosted URL in **Safari**.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Launch from the icon — it runs full-screen with the orange Homebase chrome, works offline, and keeps your data.

## Updating the app later

**`src/` is the single source of truth. Never edit `index.html` by hand — it's a build artifact.**

The update loop (keeps `src/`, `index.html`, and the deployed app in sync — they drifted once, don't let it happen again):

1. Edit `src/app.jsx` and/or `src/styles.css` (yourself, or in a Claude session with this folder connected).
2. Run `npm run build` (or `node build.mjs`). This bundles src → `index.html` and auto-bumps the `sw.js` cache version. First run installs pinned deps (Node 18+ required).
3. Commit **everything that changed** — `src/`, `index.html`, `sw.js` — in one commit, and push.
4. Phones pick up the new version on next launch (force-quit and reopen if stale).

Claude project knowledge: keep the GitHub repo linked as a *synced source* (it refreshes automatically after each push) and don't upload source files manually — manual uploads go stale.

Rules for any Claude session touching this app: apply changes to `src/` first, rebuild with `build.mjs`, never hand-edit or hand-deliver a standalone `index.html`, and any data-shape change needs a migration in `migrateWO`/`migrateState`.

## Reset / troubleshooting

- **⚙ → Reset demo data** restores the seed board on that phone (next sync pushes it to everyone — use with care).
- **Test connection fails with a "relation ... does not exist" style error** → the SQL in Step 2 hasn't been run in that Supabase project.
- **Chip stuck on Offline** → check the URL has no trailing spaces and the key is the *anon public* one, not the service role key.
