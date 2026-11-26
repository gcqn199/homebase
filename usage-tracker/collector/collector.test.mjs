/* Run with: node --test usage-tracker/collector/collector.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scan, push, loadState, summary } from "./collector.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Never read the real Claude desktop app file on the machine running the tests.
process.env.AIUT_CLAUDE_DESKTOP_USAGE = path.join(os.tmpdir(), "aiut-no-such-file.json");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aiut-"));
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const now = new Date();
const ts = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();
const totals = (state, provider) => {
  const t = { input: 0, output: 0, cache_read: 0, cache_write: 0, messages: 0 };
  for (const [k, b] of Object.entries(state.buckets)) if (k.startsWith(provider + "|")) for (const f in t) t[f] += b[f];
  return t;
};

const claudeLine = (id, out, minAgo = 5) => ({
  type: "assistant",
  timestamp: ts(minAgo),
  requestId: "req_" + id,
  message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } },
});

test("claude: counts each reply once, keeps the largest output, reads appended lines only", () => {
  const dir = tmp();
  const file = path.join(dir, "projects", "p1", "s1.jsonl");
  write(file, [
    { type: "user", timestamp: ts(6), message: { content: "hi" } },
    claudeLine("msg_1", 2),
    claudeLine("msg_1", 40), // same reply, final token count
    { type: "assistant", timestamp: ts(5), message: { id: "x", model: "<synthetic>", usage: { input_tokens: 9, output_tokens: 9 } } },
  ]);
  // a resumed session copies the earlier reply into a new file
  write(path.join(dir, "projects", "p1", "s2.jsonl"), [claudeLine("msg_1", 40)]);
  const cfg = { accounts: [{ provider: "claude", account: "main", dir }] };
  const state = loadState("/nonexistent");
  scan(state, cfg);
  assert.deepEqual(totals(state, "claude"), { input: 100, output: 40, cache_read: 1000, cache_write: 50, messages: 1 });

  fs.appendFileSync(file, JSON.stringify(claudeLine("msg_2", 7)) + "\n" + '{"type":"assistant","timest'); // partial line
  scan(state, cfg);
  assert.equal(totals(state, "claude").output, 47);
  assert.equal(totals(state, "claude").messages, 2);
  scan(state, cfg);
  assert.equal(totals(state, "claude").messages, 2);
});

test("claude: status line hook saves the limits and the collector reads them", () => {
  const dir = tmp();
  const reset = Math.floor(now.getTime() / 1000) + 3600;
  const out = execFileSync("node", [path.join(here, "statusline.mjs")], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    input: JSON.stringify({ model: { display_name: "Sonnet" }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: reset }, seven_day: { used_percentage: 41.2, resets_at: reset + 86400 } } }),
  }).toString();
  assert.match(out, /Sonnet.*5h 24%.*week 41%/);
  const state = loadState("/nonexistent");
  scan(state, { accounts: [{ provider: "claude", account: "main", dir }] });
  const lim = state.limits["claude|main"];
  assert.equal(lim.source, "reported");
  assert.deepEqual(lim.windows.map((w) => [w.key, w.used_pct]), [["five_hour", 23.5], ["seven_day", 41.2]]);
  assert.equal(lim.windows[0].resets_at, new Date(reset * 1000).toISOString());
});

test("codex: counts the growth of the running total and reads rate limits", () => {
  const dir = tmp();
  const tc = (minAgo, total, extra = {}) => ({
    timestamp: ts(minAgo),
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: total }, ...extra },
  });
  const reset = Math.floor(now.getTime() / 1000) + 7200;
  write(path.join(dir, "sessions", "2026", "11", "13", "rollout-a.jsonl"), [
    { timestamp: ts(9), type: "turn_context", payload: { model: "gpt-5.5-codex" } },
    tc(8, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, total_tokens: 1050 }),
    tc(8, { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, total_tokens: 1050 }), // repeat
    tc(7, { input_tokens: 2500, cached_input_tokens: 1600, output_tokens: 150, total_tokens: 2650 }, {
      rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: reset + 99999 } },
    }),
  ]);
  const state = loadState("/nonexistent");
  scan(state, { accounts: [{ provider: "codex", account: "main", dir }] });
  assert.deepEqual(totals(state, "codex"), { input: 900, output: 150, cache_read: 1600, cache_write: 0, messages: 2 });
  assert.ok(Object.keys(state.buckets)[0].includes("|gpt-5.5-codex|"));
  assert.deepEqual(state.limits["codex|main"].windows.map((w) => [w.key, w.used_pct]), [["five_hour", 12], ["seven_day", 30]]);
});

test("gemini: handles rewritten files without double counting, and estimates a daily quota", () => {
  const dir = tmp();
  const file = path.join(dir, "tmp", "hash1", "chats", "session-2026-11-13T10-30-abcd1234.jsonl");
  const msg = (id, out) => ({ id, type: "gemini", timestamp: ts(3), model: "gemini-3-pro", tokens: { input: 500, output: out, cached: 200, thoughts: 10, tool: 0, total: 510 + out } });
  write(file, [{ sessionId: "s", projectHash: "hash1" }, { id: "u1", type: "user", timestamp: ts(4) }, msg("g1", 20)]);
  const cfg = { accounts: [{ provider: "gemini", account: "gmail-1", dir, requests_per_day: 10 }] };
  const state = loadState("/nonexistent");
  scan(state, cfg);
  assert.deepEqual(totals(state, "gemini"), { input: 300, output: 30, cache_read: 200, cache_write: 0, messages: 1 });
  write(file, [{ sessionId: "s", projectHash: "hash1" }, msg("g1", 25), { $set: { messages: [msg("g1", 25), msg("g2", 5)] } }]);
  scan(state, cfg);
  assert.deepEqual(totals(state, "gemini"), { input: 600, output: 50, cache_read: 400, cache_write: 0, messages: 2 });
  const w = state.limits["gemini|gmail-1"].windows[0];
  assert.equal(state.limits["gemini|gmail-1"].source, "estimated");
  assert.ok(w.used_pct === 20 || w.used_pct === 0, "0 only if the test straddles Pacific midnight");
});

test("push: upserts buckets, limits and a heartbeat, and retries what failed", async () => {
  const dir = tmp();
  write(path.join(dir, "projects", "p", "s.jsonl"), [claudeLine("msg_9", 11)]);
  const got = [];
  let fail = true;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (fail) return res.writeHead(500).end("down");
      got.push({ url: req.url, key: req.headers.apikey, prefer: req.headers.prefer, rows: JSON.parse(body) });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  const cfg = { machine: "pc1", supabase_url: `http://127.0.0.1:${server.address().port}/`, supabase_key: "k", accounts: [{ provider: "claude", account: "main", dir }] };
  const state = loadState("/nonexistent");
  scan(state, cfg);
  await assert.rejects(push(state, cfg));
  assert.equal(state.dirty.length, 1);
  fail = false;
  await push(state, cfg);
  server.close();
  assert.equal(state.dirty.length, 0);
  assert.equal(got[0].url, "/rest/v1/usage_buckets?on_conflict=machine,provider,account,model,hour");
  assert.match(got[0].prefer, /merge-duplicates/);
  assert.deepEqual({ ...got[0].rows[0], hour: 0, updated_at: 0 }, { machine: "pc1", provider: "claude", account: "main", model: "claude-sonnet-5-5", hour: 0, input: 100, output: 11, cache_read: 1000, cache_write: 50, messages: 1, updated_at: 0 });
  assert.equal(got[1].rows.at(-1).key, "machine:pc1");
  assert.match(summary(state, cfg), /claude\/main/);
});

test("hooks: on_limit fires once when a window passes the threshold, on_reset once after it resets", async () => {
  const dir = tmp();
  const log = path.join(dir, "hooks.log");
  const hook = (name) => `node -e "require('fs').appendFileSync(process.argv[1], '${name} '+process.env.AIUT_WINDOW+' '+process.env.AIUT_USED+String.fromCharCode(10))" "${log}"`;
  const cfg = { accounts: [], on_limit: hook("limit"), on_reset: hook("reset"), limit_alert_pct: 80 };
  const state = loadState("/nonexistent");
  const soon = new Date(Date.now() + 3600e3).toISOString();
  state.limits["claude|main"] = { provider: "claude", account: "main", observed_at: new Date().toISOString(), source: "reported",
    windows: [{ key: "five_hour", label: "5-hour", window_minutes: 300, used_pct: 85, resets_at: soon }, { key: "seven_day", label: "Weekly", window_minutes: 10080, used_pct: 40, resets_at: soon }] };
  scan(state, cfg);
  scan(state, cfg);
  state.limits["claude|main"].windows[0].resets_at = new Date(Date.now() - 1000).toISOString();
  scan(state, cfg);
  scan(state, cfg);
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").sort(), ["limit five_hour 85", "reset five_hour 85"]);
});

test("antigravity: counts each model turn once from transcript logs", () => {
  const dir = tmp();
  const file = path.join(dir, "antigravity", "brain", "abc", ".system_generated", "logs", "transcript.jsonl");
  const turn = (step, inp, cache, out, extra = {}) => ({ step_index: step, source: "MODEL", created_at: ts(2), model: "gemini-3-pro", input_tokens: inp, cache_read_tokens: cache, output_tokens: out, ...extra });
  write(file, [{ step_index: 0, source: "USER", created_at: ts(3) }, turn(1, 29664, 0, 500), turn(6, 7270, 29665, 300)]);
  const cfg = { accounts: [{ provider: "antigravity", account: "main", dir }] };
  const state = loadState("/nonexistent");
  scan(state, cfg);
  assert.deepEqual(totals(state, "antigravity"), { input: 36934, output: 800, cache_read: 29665, cache_write: 0, messages: 2 });
  fs.appendFileSync(file, JSON.stringify(turn(6, 7270, 29665, 300)) + "\n" + JSON.stringify(turn(13, 19757, 36936, 100, { created_at: Date.now() - 60000 })) + "\n");
  scan(state, cfg);
  assert.deepEqual(totals(state, "antigravity"), { input: 56691, output: 900, cache_read: 66601, cache_write: 0, messages: 3 });
});

test("claude desktop: reads the newest plan-usage sample and keeps a known reset time", () => {
  const dir = tmp();
  const file = path.join(dir, "plan-usage-history.json");
  const t1 = Date.now() - 120000, t2 = Date.now() - 60000;
  fs.writeFileSync(file, JSON.stringify({ version: 2, samples: [{ t: t2, org: "o", u: { fh: 41, sd: 12 } }, { t: t1, org: "o", u: { fh: 30, sd: 11 } }] }));
  const state = loadState("/nonexistent");
  const reset = new Date(Date.now() + 2 * 3600e3).toISOString();
  state.limits["claude|main"] = { provider: "claude", account: "main", observed_at: new Date(t1 - 60000).toISOString(), source: "reported",
    windows: [{ key: "five_hour", label: "5-hour", window_minutes: 300, used_pct: 20, resets_at: reset }] };
  scan(state, { accounts: [{ provider: "claude", account: "main", dir, desktop_usage_file: file }] });
  const lim = state.limits["claude|main"];
  assert.equal(lim.observed_at, new Date(t2).toISOString());
  assert.deepEqual(lim.windows.map((w) => [w.key, w.used_pct, w.resets_at]), [["five_hour", 41, reset], ["seven_day", 12, null]]);
  assert.match(summary(state, { accounts: [{ provider: "claude", account: "main" }] }), /Weekly: 12% used(?!,)/);
});

test("antigravity: a turn without a model uses the last model named in that file", () => {
  const dir = tmp();
  const file = path.join(dir, "antigravity", "brain", "x", ".system_generated", "logs", "transcript.jsonl");
  write(file, [
    { step_index: 1, source: "MODEL", created_at: ts(2), model: "gemini-4-neon-high", input_tokens: 10, cache_read_tokens: 0, output_tokens: 1 },
    { step_index: 2, source: "MODEL", created_at: ts(2), input_tokens: 20, cache_read_tokens: 0, output_tokens: 2 },
  ]);
  const state = loadState("/nonexistent");
  scan(state, { accounts: [{ provider: "antigravity", account: "main", dir }] });
  assert.deepEqual(Object.keys(state.buckets).map((k) => k.split("|")[2]), ["gemini-4-neon-high"]);
});
