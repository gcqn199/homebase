#!/usr/bin/env node
/* AI usage tracker — collector.
   Reads the local session logs of Claude Code, Codex CLI and Gemini CLI, adds the
   tokens up into hourly buckets and pushes them (plus any rate-limit readings) to
   Supabase, where the dashboard and the daily email read them.

   Zero dependencies: Node 18+ only.

   Usage:
     node collector.mjs setup     guided one-time setup for this PC (config, autostart, Claude status line)
     node collector.mjs init      write a starter config without the guided steps
     node collector.mjs           run forever (scan + push every interval)
     node collector.mjs once      scan + push one time, then exit
     node collector.mjs status    print a summary in the terminal (no push)
*/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import readline from "node:readline";

const RETAIN_DAYS = 40;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export const homeDir = () => process.env.AIUT_HOME || path.join(os.homedir(), ".ai-usage-tracker");
const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

/* ---------- config + state ---------- */

function defaultAccounts() {
  const found = [];
  const add = (provider, dir) => {
    if (fs.existsSync(dir)) found.push({ provider, account: "main", dir });
  };
  add("claude", process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  add("codex", process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  add("gemini", path.join(os.homedir(), ".gemini"));
  return found;
}

export function loadConfig(file) {
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.machine ||= os.hostname();
  cfg.interval_seconds ||= 60;
  cfg.accounts = (cfg.accounts?.length ? cfg.accounts : defaultAccounts()).map((a) => ({
    ...a,
    dir: expand(a.dir),
  }));
  return cfg;
}

export function loadState(file) {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  s.files ||= {}; // per log file: read offset and parser carry-over
  s.buckets ||= {}; // "provider|account|model|hourISO" -> counts
  s.dirty ||= []; // bucket keys not yet pushed
  s.seen ||= {}; // Claude message ids already counted: id -> [day, outputTokens]
  s.limits ||= {}; // "provider|account" -> latest rate-limit reading
  s.pushedLimits ||= {};
  s.fired ||= {}; // reset hooks already run: "provider|account|window" -> resets_at
  return s;
}

function saveState(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

/* ---------- helpers ---------- */

const hourOf = (ts) => new Date(Math.floor(new Date(ts).getTime() / HOUR_MS) * HOUR_MS).toISOString();
const num = (v) => (Number.isFinite(+v) ? +v : 0);

function addToBucket(state, provider, account, model, ts, d) {
  const key = [provider, account, model || "unknown", hourOf(ts)].join("|");
  const b = (state.buckets[key] ||= { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 });
  for (const k of Object.keys(b)) b[k] = Math.max(0, b[k] + num(d[k]));
  if (!state.dirty.includes(key)) state.dirty.push(key);
}

function walk(dir, test, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

/* Feed every complete new line of an append-only log to onLine, remembering how far we got. */
function readNewLines(state, file, cutoff, onLine) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return;
  }
  const f = (state.files[file] ||= { offset: 0 });
  if (f.offset === 0 && st.mtimeMs < cutoff) {
    f.offset = st.size; // too old to matter: skip without reading
    return;
  }
  if (st.size < f.offset) f.offset = 0; // file was replaced
  if (st.size === f.offset) return;
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(4 << 20);
    let rest = Buffer.alloc(0);
    let pos = f.offset;
    while (pos < st.size) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      let buf = Buffer.concat([rest, chunk.subarray(0, n)]);
      let nl;
      while ((nl = buf.indexOf(10)) !== -1) {
        const line = buf.subarray(0, nl).toString("utf8").trim();
        buf = buf.subarray(nl + 1);
        f.offset += nl + 1;
        if (!line) continue;
        try {
          onLine(JSON.parse(line), f);
        } catch {}
      }
      rest = Buffer.from(buf); // partial last line: picked up on the next scan
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- Claude Code ---------- */

function scanClaude(state, acct, cutoff) {
  const files = walk(path.join(acct.dir, "projects"), (p) => p.endsWith(".jsonl"));
  for (const file of files) {
    readNewLines(state, file, cutoff, (o) => {
      const m = o.message;
      const u = m?.usage;
      if (o.type !== "assistant" || !u || m.model === "<synthetic>") return;
      const t = new Date(o.timestamp).getTime();
      if (!(t >= cutoff)) return;
      const d = {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cache_read: num(u.cache_read_input_tokens),
        cache_write: num(u.cache_creation_input_tokens),
        messages: 1,
      };
      // One reply is written as several lines (and copied again on resume) with the same id.
      // Count it once; if a later line reports more output tokens, add only the difference.
      const id = m.id ? `${acct.account}:${m.id}:${o.requestId || ""}` : null;
      if (id && state.seen[id]) {
        const extra = d.output - state.seen[id][1];
        if (extra > 0) {
          addToBucket(state, "claude", acct.account, m.model, t, { output: extra });
          state.seen[id][1] = d.output;
        }
        return;
      }
      if (id) state.seen[id] = [Math.floor(t / DAY_MS), d.output];
      addToBucket(state, "claude", acct.account, m.model, t, d);
    });
  }
  // Real limit percentages, written by statusline.mjs whenever Claude Code is in use.
  try {
    const r = JSON.parse(fs.readFileSync(path.join(acct.dir, "usage-tracker-limits.json"), "utf8"));
    const windows = [];
    const add = (key, label, minutes, w) => {
      if (w && Number.isFinite(+w.used_percentage) && w.resets_at)
        windows.push({
          key,
          label,
          window_minutes: minutes,
          used_pct: +w.used_percentage,
          resets_at: new Date(w.resets_at * 1000).toISOString(),
        });
    };
    add("five_hour", "5-hour", 300, r.rate_limits?.five_hour);
    add("seven_day", "Weekly", 10080, r.rate_limits?.seven_day);
    if (windows.length) setLimits(state, "claude", acct.account, r.observed_at, windows, "reported");
  } catch {}
}

/* ---------- Codex CLI ---------- */

const CODEX_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"];

function scanCodex(state, acct, cutoff) {
  const files = walk(path.join(acct.dir, "sessions"), (p) => p.endsWith(".jsonl"));
  for (const file of files) {
    readNewLines(state, file, cutoff, (o, f) => {
      const p = o.payload || o.msg || {};
      if (p.model) f.model = p.model; // turn_context / session_meta lines name the model
      if (p.type !== "token_count") return;
      const t = new Date(o.timestamp || Date.now()).getTime();
      const total = p.info?.total_token_usage;
      if (total) {
        // Events repeat the running session total; count only what was added since the last one.
        const prev = f.total || {};
        let d = Object.fromEntries(CODEX_FIELDS.map((k) => [k, num(total[k]) - num(prev[k])]));
        if (CODEX_FIELDS.some((k) => d[k] < 0)) d = p.info.last_token_usage || {};
        f.total = Object.fromEntries(CODEX_FIELDS.map((k) => [k, num(total[k])]));
        if (num(d.total_tokens) > 0 && t >= cutoff) {
          const cached = num(d.cached_input_tokens);
          addToBucket(state, "codex", acct.account, f.model, t, {
            input: Math.max(0, num(d.input_tokens) - cached), // input_tokens includes the cached part
            cache_read: cached,
            output: num(d.output_tokens),
            messages: 1,
          });
        }
      }
      const rl = p.rate_limits;
      if (rl) {
        const windows = [];
        for (const w of [rl.primary, rl.secondary]) {
          if (!w || !Number.isFinite(+w.used_percent)) continue;
          const minutes = num(w.window_minutes);
          const resets = w.resets_at
            ? w.resets_at * 1000
            : w.resets_in_seconds != null
              ? t + w.resets_in_seconds * 1000
              : null;
          if (!resets) continue;
          const weekly = minutes >= 9000 && minutes <= 11000;
          const short = minutes > 0 && minutes <= 360;
          windows.push({
            key: weekly ? "seven_day" : short ? "five_hour" : `${minutes}m`,
            label: weekly ? "Weekly" : short ? "5-hour" : minutes ? `${Math.round(minutes / 60)}-hour` : "Limit",
            window_minutes: minutes,
            used_pct: +w.used_percent,
            resets_at: new Date(resets).toISOString(),
          });
        }
        if (windows.length) setLimits(state, "codex", acct.account, new Date(t).toISOString(), windows, "reported");
      }
    });
  }
}

/* ---------- Gemini CLI ---------- */

function geminiRecords(v, out) {
  if (Array.isArray(v)) v.forEach((x) => geminiRecords(x, out));
  else if (v && typeof v === "object") {
    if (v.type === "gemini" && v.tokens && typeof v.tokens === "object" && v.timestamp)
      out.set(v.id || `${v.timestamp}:${out.size}`, v); // a later copy of a message replaces the earlier one
    for (const k of Object.keys(v)) if (typeof v[k] === "object") geminiRecords(v[k], out);
  }
}

function scanGemini(state, acct, cutoff) {
  const files = walk(
    path.join(acct.dir, "tmp"),
    (p) => /[\\/]chats[\\/]/.test(p) && /\.jsonl?$/.test(p),
  );
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) continue;
    const f = (state.files[file] ||= {});
    if (f.mtime === st.mtimeMs && f.size === st.size) continue;
    // These files get rewritten and patched, so re-read the whole file and replace what it contributed before.
    const recs = new Map();
    const text = fs.readFileSync(file, "utf8");
    try {
      geminiRecords(JSON.parse(text), recs);
    } catch {
      for (const line of text.split("\n")) {
        try {
          geminiRecords(JSON.parse(line), recs);
        } catch {}
      }
    }
    const now = {};
    for (const r of recs.values()) {
      const t = new Date(r.timestamp).getTime();
      if (!(t >= cutoff)) continue;
      const k = `${r.model || "unknown"}|${hourOf(t)}`;
      const b = (now[k] ||= { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 });
      const cached = num(r.tokens.cached);
      b.input += Math.max(0, num(r.tokens.input) - cached); // the prompt count includes the cached part
      b.cache_read += cached;
      b.output += num(r.tokens.output) + num(r.tokens.thoughts);
      b.messages += 1;
    }
    const before = f.contrib || {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const [model, hour] = k.split("|");
      const a = now[k] || {};
      const z = before[k] || {};
      const d = {};
      for (const fld of ["input", "output", "cache_read", "cache_write", "messages"]) d[fld] = num(a[fld]) - num(z[fld]);
      if (Object.values(d).some((x) => x !== 0)) addToBucket(state, "gemini", acct.account, model, hour, d);
    }
    Object.assign(f, { mtime: st.mtimeMs, size: st.size, contrib: now });
  }
  // Gemini reports no limit percentage. If a daily request quota is configured, estimate one.
  if (acct.requests_per_day > 0) {
    const pt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
    const [h, m, s] = pt.split(":").map(Number);
    const sinceMidnight = (((h % 24) * 60 + m) * 60 + s) * 1000;
    const start = Date.now() - sinceMidnight;
    let used = 0;
    for (const [k, b] of Object.entries(state.buckets)) {
      const [prov, account, , hour] = k.split("|");
      if (prov === "gemini" && account === acct.account && new Date(hour).getTime() >= start - 60000) used += b.messages;
    }
    setLimits(
      state,
      "gemini",
      acct.account,
      new Date().toISOString(),
      [
        {
          key: "daily",
          label: "Daily requests",
          window_minutes: 1440,
          used_pct: Math.min(100, (used / acct.requests_per_day) * 100),
          resets_at: new Date(start + DAY_MS).toISOString(),
        },
      ],
      "estimated",
    );
  }
}

/* ---------- limits + reset hook ---------- */

function setLimits(state, provider, account, observedAt, windows, source) {
  const key = `${provider}|${account}`;
  const cur = state.limits[key];
  const at = new Date(observedAt || Date.now()).toISOString();
  if (cur && cur.observed_at > at) return;
  state.limits[key] = { provider, account, observed_at: at, source, windows };
}

function fireResetHooks(state, cfg, log) {
  const now = Date.now();
  for (const lim of Object.values(state.limits)) {
    for (const w of lim.windows) {
      const k = `${lim.provider}|${lim.account}|${w.key}`;
      if (new Date(w.resets_at).getTime() > now || state.fired[k] === w.resets_at) continue;
      state.fired[k] = w.resets_at;
      log(`reset: ${lim.provider}/${lim.account} ${w.label} window`);
      if (!cfg.on_reset) continue;
      const child = spawn(cfg.on_reset, {
        shell: true,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, AIUT_PROVIDER: lim.provider, AIUT_ACCOUNT: lim.account, AIUT_WINDOW: w.key },
      });
      child.on("error", (e) => log(`on_reset failed: ${e.message}`));
      child.unref();
    }
  }
}

/* ---------- scan + push ---------- */

export function scan(state, cfg, log = () => {}) {
  const cutoff = Date.now() - RETAIN_DAYS * DAY_MS;
  for (const acct of cfg.accounts) {
    try {
      if (acct.provider === "claude") scanClaude(state, acct, cutoff);
      else if (acct.provider === "codex") scanCodex(state, acct, cutoff);
      else if (acct.provider === "gemini") scanGemini(state, acct, cutoff);
      else log(`unknown provider "${acct.provider}" in config`);
    } catch (e) {
      log(`${acct.provider}/${acct.account}: ${e.message}`);
    }
  }
  // Forget what is older than the retention window.
  const cutIso = new Date(cutoff).toISOString();
  for (const k of Object.keys(state.buckets)) if (k.split("|")[3] < cutIso) delete state.buckets[k];
  const cutDay = Math.floor(cutoff / DAY_MS);
  for (const id of Object.keys(state.seen)) if (state.seen[id][0] < cutDay) delete state.seen[id];
  for (const f of Object.keys(state.files)) if (!fs.existsSync(f)) delete state.files[f];
  state.dirty = state.dirty.filter((k) => state.buckets[k]);
  fireResetHooks(state, cfg, log);
}

async function sbUpsert(cfg, table, conflict, rows) {
  const res = await fetch(`${cfg.supabase_url.replace(/\/+$/, "")}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: "POST",
    headers: {
      apikey: cfg.supabase_key,
      Authorization: `Bearer ${cfg.supabase_key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function push(state, cfg) {
  if (!cfg.supabase_url || !cfg.supabase_key) throw new Error("supabase_url / supabase_key missing in config");
  const now = new Date().toISOString();
  while (state.dirty.length) {
    const keys = state.dirty.slice(0, 500);
    const rows = keys.map((k) => {
      const [provider, account, model, hour] = k.split("|");
      return { machine: cfg.machine, provider, account, model, hour, ...state.buckets[k], updated_at: now };
    });
    await sbUpsert(cfg, "usage_buckets", "machine,provider,account,model,hour", rows);
    state.dirty = state.dirty.slice(keys.length);
  }
  const rows = [];
  for (const [k, lim] of Object.entries(state.limits)) {
    const json = JSON.stringify(lim);
    if (state.pushedLimits[k] === json) continue;
    rows.push({ key: `limits:${lim.provider}:${lim.account}`, data: { ...lim, machine: cfg.machine }, updated_at: now });
    state.pushedLimits[k] = json;
  }
  rows.push({
    key: `machine:${cfg.machine}`,
    data: { machine: cfg.machine, at: now, platform: process.platform, accounts: cfg.accounts.map((a) => `${a.provider}/${a.account}`) },
    updated_at: now,
  });
  await sbUpsert(cfg, "usage_state", "key", rows);
}

/* ---------- terminal summary ---------- */

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

function until(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "reset";
  const m = Math.round(ms / 60000);
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function summary(state, cfg) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const lines = [];
  for (const a of cfg.accounts) {
    let tokens = 0;
    let msgs = 0;
    for (const [k, b] of Object.entries(state.buckets)) {
      const [p, acc, , hour] = k.split("|");
      if (p !== a.provider || acc !== a.account || new Date(hour) < midnight) continue;
      tokens += b.input + b.output + b.cache_write;
      msgs += b.messages;
    }
    const lim = state.limits[`${a.provider}|${a.account}`];
    const wins = (lim?.windows || [])
      .map((w) => (new Date(w.resets_at) <= new Date() ? `${w.label}: reset` : `${w.label}: ${Math.round(w.used_pct)}% used, resets in ${until(w.resets_at)}`))
      .join("  |  ");
    lines.push(`${(a.provider + "/" + a.account).padEnd(22)} today ${fmt(tokens).padStart(7)} tokens, ${String(msgs).padStart(4)} replies   ${wins || "no limit reading yet"}`);
  }
  return lines.join("\n") || "No accounts found. Run `node collector.mjs init` and edit the config.";
}

/* ---------- guided setup ---------- */

async function setup(cfgFile, stateFile, log) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fwd = (p) => p.replace(/\\/g, "/");
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q, def) => {
    process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
    const { value } = await lines.next();
    return (value || "").trim() || def || "";
  };
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {}
  const keep = (v) => (v && !v.includes("YOUR-") ? v : "");
  console.log("AI usage tracker setup. Press Enter to keep the value in [brackets].\n");
  const cfg = {
    machine: await ask("Name for this PC", old.machine || os.hostname()),
    supabase_url: await ask("Supabase project URL", keep(old.supabase_url)),
    supabase_key: await ask("Supabase anon public key", keep(old.supabase_key)),
    interval_seconds: old.interval_seconds || 60,
    accounts: old.accounts?.length ? old.accounts : defaultAccounts(),
    on_reset: old.on_reset || "",
  };
  rl.close();
  if (!/^https?:\/\//.test(cfg.supabase_url) || !cfg.supabase_key) throw new Error("A Supabase URL and key are required. Nothing was changed.");
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\n[1/4] Saved ${cfgFile}`);
  console.log(`      Tracking: ${cfg.accounts.map((a) => `${a.provider}/${a.account}`).join(", ") || "no CLI tools found on this PC yet"}`);

  // Claude Code status line -> exact limit percentages
  const command = `node "${fwd(path.join(here, "statusline.mjs"))}"`;
  for (const a of cfg.accounts.filter((x) => x.provider === "claude")) {
    const file = path.join(expand(a.dir), "settings.json");
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (fs.existsSync(file)) {
        console.log(`[2/4] Could not read ${file}; left it alone. Add the status line by hand (README step 4).`);
        continue;
      }
    }
    const cur = settings.statusLine?.command;
    if (cur && !cur.includes("statusline.mjs")) {
      console.log(`[2/4] ${file} already has a status line; left it alone. Exact Claude limits need ours instead (README step 4).`);
      continue;
    }
    settings.statusLine = { type: "command", command };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    console.log(`[2/4] Claude status line set in ${file}`);
  }

  // Start now and at every login
  const collector = path.join(here, "collector.mjs");
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  let started = false;
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ai-usage-collector.service"),
      `[Unit]\nDescription=AI usage tracker collector\n\n[Service]\nExecStart="${process.execPath}" "${collector}"\nRestart=always\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n`,
    );
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", "ai-usage-collector"]);
    run("systemctl", ["--user", "restart", "ai-usage-collector"]);
    started = r.status === 0;
    console.log(started ? "[3/4] Background service installed and started (systemd user service: ai-usage-collector)" : `[3/4] Could not start the background service (${(r.stderr || r.error?.message || "").trim().split("\n")[0]}).`);
  } else if (process.platform === "win32") {
    const r = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "..", "install", "install-windows.ps1")]);
    started = r.status === 0;
    console.log(started ? "[3/4] Scheduled task installed and started (AI Usage Collector)" : `[3/4] Could not install the scheduled task (${(r.stderr || r.error?.message || "").trim().split("\n")[0]}).`);
  }
  if (!started) console.log(`      To run it by hand, leave this running in a terminal:  node "${collector}"`);

  // First upload, which also proves the URL, key and tables are right
  const state = loadState(stateFile);
  const full = loadConfig(cfgFile);
  scan(state, full, log);
  try {
    await push(state, full);
    console.log("[4/4] First upload worked. Open the dashboard to see this PC.\n");
  } catch (e) {
    console.log(`[4/4] Upload failed: ${e.message}\n      Check the URL and key, and that supabase.sql has been run in that project. Then run setup again.\n`);
  }
  saveState(stateFile, state);
  console.log(summary(state, full));
}

/* ---------- main ---------- */

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find((a) => !a.startsWith("-")) || "watch";
  const cfgFlag = args.indexOf("--config");
  const cfgFile = cfgFlag >= 0 ? args[cfgFlag + 1] : path.join(homeDir(), "config.json");
  const stateFile = path.join(homeDir(), "state.json");
  const log = (m) => console.log(`${new Date().toISOString().slice(0, 19)}Z ${m}`);

  if (cmd === "setup") return setup(cfgFile, stateFile, log);
  if (cmd === "init") {
    if (fs.existsSync(cfgFile)) return console.log(`Config already exists: ${cfgFile}`);
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    const starter = {
      machine: os.hostname(),
      supabase_url: "https://YOUR-PROJECT.supabase.co",
      supabase_key: "YOUR-ANON-PUBLIC-KEY",
      interval_seconds: 60,
      accounts: defaultAccounts(),
      on_reset: "",
    };
    fs.writeFileSync(cfgFile, JSON.stringify(starter, null, 2) + "\n");
    return console.log(`Wrote ${cfgFile}\nFound: ${starter.accounts.map((a) => a.provider).join(", ") || "no CLI tools yet"}\nNow paste your Supabase URL and key into it.`);
  }

  const cfg = loadConfig(cfgFile);
  const state = loadState(stateFile);

  if (cmd === "status") {
    scan(state, cfg, log);
    saveState(stateFile, state);
    return console.log(summary(state, cfg));
  }

  const cycle = async () => {
    scan(state, cfg, log);
    try {
      await push(state, cfg);
    } catch (e) {
      log(`push failed (will retry): ${e.message}`);
    }
    saveState(stateFile, state);
  };

  if (cmd === "once") {
    await cycle();
    return console.log(summary(state, cfg));
  }
  if (cmd !== "watch") return console.log("Commands: setup | init | watch (default) | once | status");
  log(`watching ${cfg.accounts.map((a) => `${a.provider}/${a.account}`).join(", ") || "nothing (no accounts found)"} as "${cfg.machine}"`);
  for (;;) {
    await cycle();
    await new Promise((r) => setTimeout(r, cfg.interval_seconds * 1000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
