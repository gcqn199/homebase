# AI Usage Tracker

One dashboard for all your AI plans: how much of each limit is used, when it resets, and which account to use next. Works on the Debian PC, the Windows PC, iPhone and Android, with an end-of-day email.

It lives in this folder and does not touch the Homebase app. Read `STRATEGY.md` for how to pace your usage.

## How it works

| Piece | Where it runs | What it does |
|---|---|---|
| Collector (`collector/collector.mjs`) | each PC, in the background | Reads the local logs of Claude Code, Codex CLI and Gemini CLI every minute and uploads token counts and limit readings |
| Supabase (2 tables) | your free Supabase project | Holds the shared numbers |
| Dashboard (`index.html`) | any browser or phone home screen | Shows limits, reset countdowns, pace and a 7-day chart; refreshes every 30 seconds |
| Daily email (`email/daily_report.py`) | GitHub Actions | Sends one summary each evening |

### What is tracked automatically, and what is not

| Source | Tokens | Limit % and reset time |
|---|---|---|
| Claude Code | automatic | automatic and exact, once the status line hook is on (step 4) |
| Codex CLI | automatic | automatic and exact (Codex writes it to its logs) |
| Gemini CLI | automatic | estimated, only if you set `requests_per_day` for the account |
| Chat apps (claude.ai, ChatGPT, Gemini in a browser or phone app) | not available | manual: the providers publish no usage data for these, so you tap **Update** on the dashboard when the app shows your usage or a limit message |
| Pay-per-token API keys | not built yet | not built yet |

## Setup

You need Node 18+ on each PC (`node -v` to check).

### 1. Create the tables (once)

In Supabase (the same project Homebase uses is fine) open **SQL Editor**, paste the contents of `supabase.sql`, and run it. Then copy the **Project URL** and **anon public** key from **Project Settings → API**.

### 2. Set up each PC (one command)

Get the repo onto the PC once:

```bash
git clone https://github.com/gcqn199/homebase.git
```

Then run the guided setup. It asks for a name for the PC and the Supabase URL and key, and does the rest:

```bash
node homebase/usage-tracker/collector/collector.mjs setup
```

It saves the config, turns on the Claude Code status line (exact limit percentages), installs the collector to start at every login (a systemd user service on Debian, a scheduled task on Windows), and does a first upload to prove the connection works. Running it again is safe and keeps your earlier answers.

`node homebase/usage-tracker/collector/collector.mjs status` prints the current numbers in a terminal at any time. The config lives in `~/.ai-usage-tracker/config.json` (on Windows: `C:\Users\you\.ai-usage-tracker\config.json`).

### 3. Open the dashboard

Once this folder is on the `main` branch, GitHub Pages serves it at `https://<username>.github.io/homebase/usage-tracker/`. Open it, tap **Settings**, paste the same URL and key.

- **iPhone:** Safari → Share → **Add to Home Screen**.
- **Android:** Chrome → menu → **Add to Home screen**.
- **PCs:** bookmark it, or in Chrome/Edge use **Install page as app** to pin it like a widget.

To preview it with sample data, add `?demo` to the address.

### 4. Exact Claude limits (done by setup; manual steps for reference)

Claude Code hands its real 5-hour and weekly percentages to a "status line" script. Setup adds this for you unless you already had a different status line. To do it by hand, add this to `~/.claude/settings.json` (adjust the path to where the repo is):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/homebase/usage-tracker/collector/statusline.mjs"
  }
}
```

On Windows use a full path with forward slashes, e.g. `node C:/Users/you/homebase/usage-tracker/collector/statusline.mjs`. This replaces any status line you already have. It runs locally and uses no tokens. Readings refresh while Claude Code is in use.

### 5. Several accounts of the same service on one PC

Each account needs its own folder. For Claude Code, start the second account with a different config folder and list both in `config.json` (see `collector/config.example.json`):

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude
```

Put the status line setting from step 4 in that folder's `settings.json` too. Codex does the same with `CODEX_HOME`. If you switch Google accounts inside one Gemini CLI folder, their usage is counted together.

### 6. Daily email

In the GitHub repo: **Settings → Secrets and variables → Actions**.

Secrets: `SUPABASE_URL`, `SUPABASE_KEY`, `GMAIL_USER` (the Gmail address that sends), `GMAIL_APP_PASSWORD` (create one at myaccount.google.com/apppasswords; needs 2-step verification on).

Variables: `REPORT_TZ` (e.g. `America/Chicago`), `REPORT_HOUR` (0-23, default 21), `REPORT_TO` (optional, defaults to the sender).

The workflow `.github/workflows/usage-daily-email.yml` checks every hour and sends once per day after that hour. It only runs once the file is on `main`. To test, open **Actions → AI usage daily email → Run workflow** with "force" ticked. GitHub pauses scheduled workflows after 60 days with no commits to the repo; it emails you first, and one click re-enables it.

### 7. Run something when a limit resets (optional)

Set `on_reset` in `config.json` to any command. The collector runs it when a tracked window resets, with `AIUT_PROVIDER`, `AIUT_ACCOUNT` and `AIUT_WINDOW` (`five_hour`, `seven_day`, `daily`) set. Example on Debian: `notify-send "AI limit reset" "$AIUT_PROVIDER $AIUT_ACCOUNT"`. A reset is only noticed for windows that had a reading, and only while the collector is running.

## Security note

Same model as Homebase: anyone with both the Supabase URL and the anon key can read and change the usage numbers. They are stored on your devices and in GitHub secrets, never in these files. The data is token counts and account nicknames only; no prompts or replies ever leave your PCs.

## Tests

```bash
node --test usage-tracker/collector/collector.test.mjs
```
