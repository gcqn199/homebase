#!/usr/bin/env node
/* Claude Code status line hook.
   Claude Code hands this script its real 5-hour and weekly limit percentages each time
   a reply arrives. We save them where the collector picks them up, and print a short
   status line. Runs locally and uses no tokens. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch {}
  const rl = d.rate_limits;
  if (rl && (rl.five_hour || rl.seven_day)) {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const file = path.join(dir, "usage-tracker-limits.json");
    try {
      fs.writeFileSync(file + ".tmp", JSON.stringify({ observed_at: new Date().toISOString(), rate_limits: rl }));
      fs.renameSync(file + ".tmp", file);
    } catch {}
  }
  const pct = (w) => (w && Number.isFinite(+w.used_percentage) ? `${Math.round(w.used_percentage)}%` : "–");
  const parts = [`[${d.model?.display_name || "Claude"}]`];
  if (rl) parts.push(`5h ${pct(rl.five_hour)}`, `week ${pct(rl.seven_day)}`);
  console.log(parts.join(" · "));
});
