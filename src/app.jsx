/* Homebase Passdown — single-file React app
   Source of truth: bundle with esbuild into index.html (see redeploy steps).
   Storage: localStorage "homebase.state.v1" (+ optional Supabase homebase_state sync). */

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";

const H = 3600 * 1e3;
const LS_STATE = "homebase.state.v1";
const LS_CFG = "homebase.cfg.v1";

/* ---------- changelog ----------
   One entry per shipped build. Add a new entry at the top each time you ship
   (the version number should match the "V" the next build.mjs run will bump
   sw.js/index.html to — see build.mjs). Older builds shipped before this log
   existed are summarized in the last entry. */
const CHANGELOG = [
  {
    v: 20,
    date: "7/18/2026",
    notes: [
      "PM Checklists — you can now add your own PMs. Each OnDeck section (Time Based and Usage Based) has an “+ Add PM” button, and every PM can carry a checklist of steps. Tap a PM's gear to edit its schedule and steps, or to delete it.",
      "When you make a Work Order from a PM, its checklist steps now drop straight into the work order's Gameplan, ready to tick off.",
      "New “+ Adhoc PM” button for one-off maintenance — jot the item, name, and a few steps and it creates a Priority 4 work order with those steps, without adding a recurring schedule.",
      "PMs with steps show a small ☑ count next to their name.",
    ],
  },
  {
    v: 19,
    date: "7/18/2026",
    notes: [
      "New View toggle in the owner bar: Full (whole board) or Simple (lists + Notes only). Each phone remembers its own choice, and it no longer changes when you switch Owner — on first launch it starts from whatever that phone showed before.",
      "The version chip (this page's shortcut) is now visible on phones, next to the HOMEBASE title.",
    ],
  },
  {
    v: 18,
    date: "7/18/2026",
    notes: [
      "Under-the-hood cleanup — no feature changes. Removed leftover factory-era code (an invisible downtime questionnaire, unused fields on new work orders, orphaned styles) and consolidated duplicate logic. Everything looks and works the same.",
    ],
  },
  {
    v: 17,
    date: "7/18/2026",
    notes: [
      "Added Settings → “Delete all data…” — permanently clears every work order (including the archive), all supplies, and all PM schedules on every synced phone, with a second-step confirmation. Notes, household lists, and settings are kept.",
    ],
  },
  {
    v: 15,
    date: "7/18/2026",
    notes: [
      "Renamed “System” to “Category” everywhere (filters, ribbon action, work order detail, row menus).",
      "Renamed “Daily Checklist” to “Notes.”",
      "Fixed the version chip in the header — it now shows the real build number instead of always reading V1.",
      "Added a Refresh button to the top header bar.",
      "Added this What's New page — tap the version chip or use Settings → What's New.",
      "Added a Text List button to Part Orders, Today's List, and Quick Capture (Shopping List already had one).",
      "Restyled section headers to be sleeker and more consistent; shortened the work order board header to just “WOPr.”",
    ],
  },
  {
    v: 14,
    date: "",
    notes: ["Earlier releases — detailed changelog tracking starts with V15."],
  },
];

/* ---------- date helpers ---------- */
function fmtDT(ts) {
  const d = new Date(ts),
    mo = String(d.getMonth() + 1).padStart(2, "0"),
    da = String(d.getDate()).padStart(2, "0"),
    h = String(d.getHours()).padStart(2, "0"),
    mi = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${da} @ ${h}:${mi}`;
}

function fmtShort(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ---------- deadline helpers ---------- */
/* fmtDeadline(Date.now()) doubles as the "today" stamp in the header. */
function fmtDeadline(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function endOfMonth() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
}

function endOfYear() {
  const n = new Date();
  return new Date(n.getFullYear(), 11, 31, 23, 59, 59, 999).getTime();
}

function relDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function dateInputToTs(v) {
  // "YYYY-MM-DD" -> local end-of-day timestamp
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function tsToDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isOverdue(wo) {
  return wo.deadline != null && wo.deadline < Date.now() && wo.status !== "Closed";
}

/* One list drives every deadline preset UI (create form, detail picker, board row menu)
   plus deadlineFromPick — add/change presets here only. */
const DL_PRESETS = [
  { mode: "tom", label: "Tomorrow", ts: () => relDays(1) },
  { mode: "wk", label: "Next week", ts: () => relDays(7) },
  { mode: "eom", label: "End of month", ts: endOfMonth },
  { mode: "eoy", label: "End of year", ts: endOfYear },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------- constants ---------- */
const PRIORITIES = [
  { id: 1, label: "Priority 1: EMERGENCY - Critical", band: "band1" },
  { id: 2, label: "Priority 2: URGENT - This Week", band: "band2" },
  { id: 3, label: "Priority 3: ROUTINE - Standard Home Work", band: "band3" },
  { id: 4, label: "Priority 4: SCHEDULED - Preventive Maintenance", band: "band4" },
  { id: 5, label: "Priority 5: PROJECTS - Improvements", band: "band5" },
];

const STATUS_META = {
  Open: { icon: "▲", cls: "stOpen", tip: "Open — not yet started" },
  "In Progress": { icon: "◆", cls: "stProg", tip: "In Progress — actively being worked" },
  "On Hold": { icon: "▼", cls: "stHold", tip: "On Hold — paused" },
  Closed: { icon: "●", cls: "stClosed", tip: "Entry closed" },
};

const LEGACY_STATUSES = ["Running", "UTP", "OOC", "SchQual"];

const ASSIGNEES = ["Cole", "Jessamine", "Unassigned"];

/* Migrate a work order forward: legacy status names -> new set; ensure deadline key exists. */
function migrateWO(w) {
  let out = w;
  if (out && LEGACY_STATUSES.includes(out.status)) {
    let s;
    if (out.flow === "On Hold") s = "On Hold";
    else if (out.flow === "Open") s = "Open";
    else s = "In Progress";
    out = { ...out, status: s };
  }
  if (out && out.deadline === undefined) out = { ...out, deadline: null };
  if (out && out.system === undefined) out = { ...out, system: null };
  if (out && out.entity === undefined) out = { ...out, entity: "" };
  if (out) {
    /* priority must be a number 1-5 or the WO silently vanishes from the priority bands */
    const pn = Number(out.priority);
    if (!(pn >= 1 && pn <= 5)) out = { ...out, priority: 3 };
    else if (pn !== out.priority) out = { ...out, priority: pn };
  }
  if (out && (out.assigned === undefined || out.assigned === "On-Call Homeowner")) out = { ...out, assigned: "Unassigned" };
  return out;
}

function migrateState(s) {
  if (!s || !Array.isArray(s.workOrders)) return s;
  const wos = s.workOrders.map(migrateWO);
  let out = wos.some((w, i) => w !== s.workOrders[i]) ? { ...s, workOrders: wos } : s;
  /* Supplies rename: legacy part status "Installed" -> "Put Away" */
  if (Array.isArray(out.parts) && out.parts.some((p) => p && p.status === "Installed")) {
    out = { ...out, parts: out.parts.map((p) => (p && p.status === "Installed" ? { ...p, status: "Put Away" } : p)) };
  }
  /* PM Checklists — backfill an empty checklist array on any PM stored before V20 */
  const needsPmChk = (arr) => Array.isArray(arr) && arr.some((p) => p && !Array.isArray(p.checklist));
  if (needsPmChk(out.timePMs) || needsPmChk(out.usagePMs)) {
    const fix = (arr) =>
      Array.isArray(arr) ? arr.map((p) => (p && !Array.isArray(p.checklist) ? { ...p, checklist: [] } : p)) : arr;
    out = { ...out, timePMs: fix(out.timePMs), usagePMs: fix(out.usagePMs) };
  }
  /* Household lists (Shopping / Today's / Quick Capture) — backfill empty defaults on older docs */
  if (!Array.isArray(out.shopping) || !Array.isArray(out.todays) || !Array.isArray(out.capture) || typeof out.listSeq !== "number") {
    out = {
      ...out,
      shopping: Array.isArray(out.shopping) ? out.shopping : [],
      todays: Array.isArray(out.todays) ? out.todays : [],
      capture: Array.isArray(out.capture) ? out.capture : [],
      todaysDate: out.todaysDate === undefined ? null : out.todaysDate,
      listSeq: typeof out.listSeq === "number" ? out.listSeq : 0,
    };
  }
  return out;
}

/* Single factory for new work orders — every creation path (create form, seed,
   OnDeck PM, Quick Capture promote) goes through here so the stored shape stays
   consistent. "Add a value" is the empty-comment sentinel (Fuzion convention);
   the UI renders it as the tap-to-edit placeholder. */
function makeWO(id, by, over = {}) {
  const now = Date.now();
  return {
    id,
    entity: "",
    status: "Open",
    priority: 3,
    desc: "",
    comment: "Add a value",
    checklist: "",
    checklistState: "",
    updatedBy: by,
    updated: now,
    assigned: "Unassigned",
    created: now,
    createdBy: by,
    deadline: null,
    system: null,
    gameplan: [],
    log: [],
    ...over,
  };
}

const PART_FLOW = ["Requested", "Ordered", "Shipped", "Received", "Put Away"];

/* ---------- household systems ---------- */
const SYSTEM_GROUPS = [
  {
    group: "Household Systems",
    cls: "sysG1",
    items: [
      { code: "HVAC", label: "Heating/cooling" },
      { code: "PLUMB", label: "Plumbing" },
      { code: "ELEC", label: "Electrical" },
      { code: "APPL", label: "Appliances" },
    ],
  },
  {
    group: "Recurring Work",
    cls: "sysG2",
    items: [
      { code: "CLEAN", label: "Cleaning" },
      { code: "LAUNDRY", label: "Laundry systems" },
      { code: "AUTO", label: "Mazda CX-5" },
      { code: "AUTO-MAINT", label: "Scheduled vehicle maintenance" },
      { code: "BIKE", label: "Bicycles/ebikes" },
      { code: "MEAL", label: "Meal prep" },
    ],
  },
  {
    group: "Interests/Non-Urgent",
    cls: "sysG3",
    items: [
      { code: "HOBBY", label: "Hobbies/crafts" },
      { code: "PROJ", label: "Home improvement projects" },
      { code: "ORG", label: "Organization/decluttering" },
      { code: "TECH", label: "Home tech/network/smart home" },
    ],
  },
  {
    group: "Admin",
    cls: "sysG4",
    items: [
      { code: "FINANCE", label: "Bills/finances" },
      { code: "ADMIN", label: "Household admin/paperwork" },
      { code: "PET", label: "Cats (Matcha, Java, Chai)" },
      { code: "LANDLORD", label: "Reported to property management" },
    ],
  },
];

const SYSTEM_META = {};
for (const g of SYSTEM_GROUPS) for (const it of g.items) SYSTEM_META[it.code] = { ...it, group: g.group, cls: g.cls };

function SystemBadge({ code, onClick }) {
  const m = SYSTEM_META[code];
  if (!m) return null;
  return (
    <span className={`sysBadge ${m.cls}`} title={`${m.group} — ${m.label}`} onClick={onClick}>
      {code}
    </span>
  );
}

/* Grouped <option> list for system selects (create form, row menu, detail, filter). */
function SystemOptions({ noneLabel = "— none —" }) {
  return (
    <>
      <option value="">{noneLabel}</option>
      {SYSTEM_GROUPS.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.items.map((it) => (
            <option key={it.code} value={it.code}>
              {it.code} — {it.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/* ---------- demo seed ---------- */
function seedData() {
  const t = Date.now();
  let woSeq = 6012250;
  const nwo = () => ++woSeq;
  let partSeq = 100;
  const workOrders = [
    makeWO(nwo(), "Cole", {
      entity: "Bathroom sink", priority: 2, system: "LANDLORD",
      desc: "Report slow-draining bathroom sink to property management",
      comment: "Draining slower each week — get maintenance request in before it clogs fully.",
      updated: t - 6 * H, created: t - 6 * H,
      deadline: endOfMonth(),
      gameplan: [
        { text: "Submit maintenance request via portal", done: false, by: "" },
        { text: "Note ticket # in comments", done: false, by: "" },
      ],
    }),
    makeWO(nwo(), "Jessamine", {
      entity: "Litterbox", priority: 3, system: "PET",
      desc: "Full litter change — all 3 boxes, wash + refill",
      comment: "Matcha, Java, and Chai have filed formal complaints.",
      updated: t - 12 * H, created: t - 30 * H,
      deadline: t + 48 * H,
    }),
    makeWO(nwo(), "Jessamine", {
      entity: "Kitchen", priority: 3, system: "MEAL",
      desc: "Sunday meal prep — workday lunches x5 each",
      assigned: "Jessamine",
      updated: t - 20 * H, created: t - 40 * H,
      deadline: t + 72 * H,
      gameplan: [
        { text: "Plan menu + grocery list", done: false, by: "" },
        { text: "Grocery run", done: false, by: "" },
        { text: "Cook + portion into containers", done: false, by: "" },
      ],
    }),
    makeWO(nwo(), "Cole", {
      entity: "Ebike 1", priority: 4, system: "BIKE",
      desc: "Brake pad check + chain clean/lube",
      comment: "Front brakes feeling soft on the commute.",
      assigned: "Cole",
      updated: t - 15 * H, created: t - 50 * H,
    }),
    makeWO(nwo(), "Cole", {
      entity: "Apartment", status: "In Progress", priority: 5, system: "ORG",
      desc: "Closet declutter — donate pile to drop-off",
      comment: "Two bags staged by the door. Do not let them become furniture.",
      assigned: "Cole",
      updated: t - 60 * H, created: t - 120 * H,
      deadline: endOfMonth(),
    }),
  ];
  const timePMs = [
    { id: 1, tool: "Litterbox", name: "Full litter change (all 3 boxes)", due: t - 7 * H, freqH: 168, checklist: ["Dump all 3 boxes", "Wash + dry each box", "Add fresh litter (2–3 in)", "Sprinkle deodorizer", "Restock litter if low"] },
    { id: 2, tool: "Kitchen", name: "Meal prep — workday lunches", due: t + 60 * H, freqH: 168, checklist: [] },
    { id: 3, tool: "Cats", name: "Flea/tick meds — Matcha, Java, Chai", due: t + 200 * H, freqH: 720, checklist: ["Matcha — apply dose", "Java — apply dose", "Chai — apply dose", "Log date on fridge calendar"] },
    { id: 4, tool: "Cats", name: "Litter + cat food restock check", due: t + 90 * H, freqH: 336, checklist: [] },
    { id: 5, tool: "Ebikes", name: "Battery health check + charge to 80%", due: t + 120 * H, freqH: 720, checklist: [] },
    { id: 6, tool: "Dryer", name: "Lint trap + vent deep clean", due: t - 100 * H, freqH: 720, checklist: ["Clear lint trap", "Vacuum trap housing", "Disconnect + clear vent hose", "Check exterior vent flap", "Reconnect + test run"] },
    { id: 7, tool: "Apartment", name: "Smoke detector test", due: t + 900 * H, freqH: 4380, checklist: [] },
    { id: 8, tool: "Fridge", name: "Water filter replacement", due: t + 1400 * H, freqH: 4380, checklist: [] },
  ];
  const usagePMs = [
    { id: 1, tool: "Mazda CX-5", name: "Oil change (since last)", count: 3850, limit: 5e3, due: 4500, unit: "mi", checklist: ["Drain oil + replace filter", "Refill (0W-20, ~4.6 qt)", "Reset oil-life monitor", "Log mileage", "Check tire pressure"] },
    { id: 2, tool: "Mazda CX-5", name: "Tire rotation (since last)", count: 3850, limit: 7500, due: 7000, unit: "mi", checklist: [] },
    { id: 3, tool: "Ebikes", name: "Chain lube interval", count: 140, limit: 200, due: 180, unit: "mi", checklist: [] },
  ];
  const parts = [
    { id: ++partSeq, part: "Cat litter 40 lb (unscented clumping)", tool: "Litterbox", wo: 6012252, qty: 2, source: "Chewy", status: "Ordered", eta: t + 72 * H },
    { id: ++partSeq, part: "Dry cat food 16 lb", tool: "Cats", wo: null, qty: 1, source: "Chewy", status: "Requested", eta: null },
    { id: ++partSeq, part: "Ebike brake pads (front pair)", tool: "Ebike 1", wo: 6012254, qty: 1, source: "Amazon", status: "Shipped", eta: t + 48 * H },
    { id: ++partSeq, part: "Meal prep containers (10-pk glass)", tool: "Kitchen", wo: null, qty: 1, source: "Costco", status: "Put Away", eta: null },
    { id: ++partSeq, part: "Fridge water filter", tool: "Fridge", wo: null, qty: 1, source: "Amazon", status: "Requested", eta: null },
  ];
  const shopping = [
    { id: 1, text: "Cat litter (Winco)", done: false, by: "Jessamine", ts: t - 6 * H },
    { id: 2, text: "Coffee beans", done: true, by: "Cole", ts: t - 30 * H, doneBy: "Cole" },
  ];
  const capture = [{ id: 3, text: "Check Atmos flight credit", done: false, by: "Cole", ts: t - 8 * H }];
  return {
    workOrders, timePMs, usagePMs, parts,
    shopping,
    todays: [],
    todaysDate: null,
    capture,
    listSeq: 3,
    dailyText: `• Feed cats AM/PM — Matcha gets the dental kibble
• Scoop litterboxes nightly
• Ebikes: charge to ~80%, off the charger overnight
• Meal prep containers to fridge Sunday night`,
    dailyBy: "Cole",
    dailyAt: t - 4 * H,
    woSeq, partSeq,
    lastModified: t,
  };
}

/* ---------- storage ---------- */
function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_CFG)) || {};
    /* One-time per-device backfill: view mode used to follow Owner (Jessamine = Simple).
       Seed it from this phone's current owner so the update changes nothing visually,
       then it's an independent per-device setting from here on. */
    if (c.viewMode !== "full" && c.viewMode !== "simple") {
      c.viewMode = c.userName === "Jessamine" ? "simple" : "full";
      saveCfg(c);
    }
    return c;
  } catch {
    return { viewMode: "full" };
  }
}

function saveCfg(cfg) {
  try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch {}
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_STATE));
    if (raw && raw.workOrders) {
      const mig = migrateState(raw);
      if (mig !== raw) try { localStorage.setItem(LS_STATE, JSON.stringify(mig)); } catch {}
      return mig;
    }
  } catch {}
  const seed = seedData();
  try { localStorage.setItem(LS_STATE, JSON.stringify(seed)); } catch {}
  return seed;
}

function saveState(s) {
  try { localStorage.setItem(LS_STATE, JSON.stringify(s)); } catch {}
}

/* ---------- Supabase sync (REST, last-write-wins) ---------- */
function sbHeaders(cfg) {
  return { apikey: cfg.sbKey, Authorization: `Bearer ${cfg.sbKey}`, "Content-Type": "application/json" };
}

function sbEndpoint(cfg) {
  return cfg.sbUrl.replace(/\/+$/, "") + "/rest/v1/homebase_state";
}

async function sbGet(cfg) {
  const r = await fetch(sbEndpoint(cfg) + "?id=eq.1&select=data,updated_at", { headers: sbHeaders(cfg) });
  if (!r.ok) throw new Error(`GET ${r.status}: ${await r.text()}`);
  return (await r.json())[0] || null;
}

async function sbPut(cfg, data) {
  const body = JSON.stringify([{ id: 1, data, updated_at: new Date(data.lastModified).toISOString() }]);
  const r = await fetch(sbEndpoint(cfg), {
    method: "POST",
    headers: { ...sbHeaders(cfg), Prefer: "resolution=merge-duplicates" },
    body,
  });
  if (!r.ok) throw new Error(`PUT ${r.status}: ${await r.text()}`);
}

/* ---------- small components ---------- */
function PMStatusBadge({ status }) {
  return (
    <span className={`pmBadge ${status === "DUE" ? "pmDue" : status === "OVERDUE" ? "pmOver" : "pmOpp"}`}>
      {status}
    </span>
  );
}

/* Inline tap-to-edit field. Tap the dashed text to edit in place; Enter/blur saves, Escape cancels. */
function InlineEdit({ value, display, onSave, type = "text", className = "", empty = "Add a value", title = "Tap to edit" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelled = useRef(false);
  if (editing)
    return (
      <input
        className={`ieInput ${className}`}
        type={type}
        value={draft}
        autoFocus
        onFocus={(e) => type !== "date" && e.target.select()}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (!cancelled.current && draft !== String(value ?? "")) onSave(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setEditing(false);
          }
        }}
      />
    );
  const shown = display !== undefined ? display : value != null && String(value) !== "" ? value : null;
  return (
    <span
      className={`ieText ${className}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        cancelled.current = false;
        setDraft(value == null ? "" : String(value));
        setEditing(true);
      }}
    >
      {shown ?? <span className="ieEmpty">{empty}</span>}
    </span>
  );
}

/* Shared deadline mode select. value = {mode, date}; onChange gets the new value. */
function DeadlineSelect({ value, onChange }) {
  return (
    <>
      <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value })}>
        <option value="none">No deadline</option>
        {DL_PRESETS.map((p) => (
          <option key={p.mode} value={p.mode}>
            {p.label} ({fmtDeadline(p.ts())})
          </option>
        ))}
        <option value="date">Pick date…</option>
      </select>
      {value.mode === "date" && (
        <input
          className="dlDate"
          type="date"
          value={value.date}
          autoFocus
          onChange={(e) => onChange({ ...value, date: e.target.value })}
        />
      )}
    </>
  );
}

function deadlineFromPick(pick) {
  const preset = DL_PRESETS.find((p) => p.mode === pick.mode);
  if (preset) return preset.ts();
  if (pick.mode === "date" && pick.date) return dateInputToTs(pick.date);
  return null;
}

/* ---------- Deadline calendar (monthly view) ---------- */
function DeadlineCalendar({ workOrders, onOpen, onRefresh }) {
  const now = new Date();
  const [cal, setCal] = useState({ y: now.getFullYear(), m: now.getMonth() });

  const byDay = useMemo(() => {
    const map = {};
    for (const w of workOrders) {
      if (w.deadline == null || w.status === "Closed") continue;
      const d = new Date(w.deadline);
      if (d.getFullYear() !== cal.y || d.getMonth() !== cal.m) continue;
      (map[d.getDate()] = map[d.getDate()] || []).push(w);
    }
    return map;
  }, [workOrders, cal]);

  const firstDow = new Date(cal.y, cal.m, 1).getDay();
  const daysInMonth = new Date(cal.y, cal.m + 1, 0).getDate();
  const cells = Math.ceil((firstDow + daysInMonth) / 7) * 7;
  const today = new Date();
  const isThisMonth = today.getFullYear() === cal.y && today.getMonth() === cal.m;

  const shift = (delta) =>
    setCal((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  return (
    <>
      <div className="pmHeader">
        <span className="pmHeaderTitle">{"□ Deadline Calendar"}</span>
        <span className="calNav">
          <button className="btnGrad btnSm" onClick={() => shift(-1)} title="Previous month">{"‹"}</button>
          <b className="calMonthLb">{MONTHS[cal.m]} {cal.y}</b>
          <button className="btnGrad btnSm" onClick={() => shift(1)} title="Next month">{"›"}</button>
          <button
            className="btnGrad btnSm"
            onClick={() => setCal({ y: today.getFullYear(), m: today.getMonth() })}
          >
            Today
          </button>
          <button className="btnGrad btnSm" onClick={onRefresh}>
            Refresh
          </button>
        </span>
      </div>
      <div className="calWrap">
        <div className="calGrid">
          {DOWS.map((d) => (
            <div key={d} className="calDow">{d}</div>
          ))}
          {Array.from({ length: cells }, (_, i) => {
            const day = i - firstDow + 1;
            const inMonth = day >= 1 && day <= daysInMonth;
            const isToday = inMonth && isThisMonth && day === today.getDate();
            const items = inMonth ? byDay[day] || [] : [];
            return (
              <div key={i} className={"calDay" + (inMonth ? "" : " out") + (isToday ? " today" : "")}>
                {inMonth && <div className="calNum">{day}</div>}
                {items.map((w) => (
                  <span
                    key={w.id}
                    className={`calChip cp${w.priority}` + (isOverdue(w) ? " calOver" : "")}
                    title={`WO #${w.id} — ${w.desc} (P${w.priority}, ${w.status}${w.system ? ", " + w.system : ""})`}
                    onClick={() => onOpen(w.id)}
                  >
                    {w.entity || w.desc.slice(0, 14)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        <div className="calLegend">
          {PRIORITIES.map((p) => (
            <span key={p.id} className="calLegItem">
              <span className={`calSwatch cp${p.id}`} /> P{p.id}
            </span>
          ))}
          <span className="calLegNote">Tap a chip to open the WO. Set deadlines in the WOPr DEADLINE column.</span>
        </div>
      </div>
    </>
  );
}

/* ---------- household list section (Shopping / Today's / Quick Capture) ----------
   Same table/ribbon aesthetic as the CMMS sections. variant "strike" = crossed-out done
   items (Shopping); variant "check" = checkmark, text stays readable (Today's / Capture).
   Done items stay visible until cleared. The plain text input gets iOS keyboard
   dictation for free — no custom speech feature needed. */
function HouseListSection({ anchorId, title, items, variant, placeholder, emptyText, onAdd, onToggle, onDelete, actions, banner, extraCol, rowExtra }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft("");
  };
  const open = items.filter((i) => !i.done).length;
  return (
    <>
      <div className="pmHeader" id={anchorId}>
        <span className="pmHeaderTitle">{title}</span>
        <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          to the top {"▲"}
        </a>
      </div>
      <div className="pmSub listSub">
        {open}
        {" open item(s) "}
        <input
          className="listAddInput"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btnGrad" onClick={add}>
          Add
        </button>
        {actions}
      </div>
      {banner}
      <div className="tableWrap listWrap">
        <table className="grid listGrid">
          <thead>
            <tr className="pmHead">
              <th style={{ width: 34 }}>{"✓"}</th>
              <th>ITEM</th>
              {extraCol && <th style={{ width: 40 }} />}
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr className="row">
                <td colSpan={extraCol ? 4 : 3} className="muted">
                  {emptyText}
                </td>
              </tr>
            )}
            {items.map((it, i) => (
              <tr key={it.id} className={(i % 2 ? "rowAlt" : "row") + (it.done ? " liDoneRow" : "")}>
                <td className="liTick" onClick={() => onToggle(it.id)}>
                  {it.done ? <span className="liDoneIc">{"✔"}</span> : <span className="liOpenIc">{"○"}</span>}
                </td>
                <td
                  className={"liText" + (it.done ? (variant === "strike" ? " liStrike" : " liDim") : "")}
                  onClick={() => onToggle(it.id)}
                  title={`Added by ${it.by || "?"}${it.done && it.doneBy ? ` — checked by ${it.doneBy}` : ""}`}
                >
                  {it.text}
                </td>
                {extraCol && <td className="gearCell">{rowExtra ? rowExtra(it) : null}</td>}
                <td className="liDel">
                  <a title="Remove item" onClick={() => onDelete(it.id)}>
                    {"✕"}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- main app ---------- */
function App() {
  const [cfg, setCfg] = useState(loadCfg);
  const [state, setState] = useState(loadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const me = cfg.userName || "Me";

  const [view, setView] = useState({ page: "passdown" });
  const [collapsed, setCollapsed] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [checked, setChecked] = useState({});
  const [bulkStatus, setBulkStatus] = useState("Open");
  const [query, setQuery] = useState("");
  const [editDaily, setEditDaily] = useState(false);
  const [gearMenu, setGearMenu] = useState(null);
  const [showPartOrder, setShowPartOrder] = useState(false);
  const [partOrderReq, setPartOrderReq] = useState({ name: "", qty: 1, source: "", tool: "" });
  const [rowMenu, setRowMenu] = useState(null); // {type:"status"|"deadline", id}
  const [toast, setToast] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showPMModal, setShowPMModal] = useState(null); // null | { kind:"time"|"usage", pm:null|existing }
  const [showAdhoc, setShowAdhoc] = useState(false);
  const [sync, setSync] = useState({ s: cfg.sbUrl && cfg.sbKey ? "syncing" : "local", at: null });
  const pushTimer = useRef(null);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  };

  const mutate = useCallback((fn) => {
    setState((prev) => {
      const next = { ...fn(prev), lastModified: Date.now() };
      saveState(next);
      const c = cfgRef.current;
      if (c.sbUrl && c.sbKey) {
        if (pushTimer.current) clearTimeout(pushTimer.current);
        pushTimer.current = setTimeout(async () => {
          try {
            setSync((s) => ({ ...s, s: "syncing" }));
            await sbPut(cfgRef.current, stateRef.current);
            setSync({ s: "synced", at: Date.now() });
          } catch {
            setSync({ s: "offline", at: Date.now() });
          }
        }, 800);
      }
      return next;
    });
  }, []);

  const pull = useCallback(async () => {
    const c = cfgRef.current;
    if (!c.sbUrl || !c.sbKey) {
      setSync({ s: "local", at: null });
      return;
    }
    try {
      setSync((s) => ({ ...s, s: "syncing" }));
      const row = await sbGet(c);
      const mine = stateRef.current.lastModified || 0;
      if (!row) await sbPut(c, stateRef.current);
      else {
        const theirs = new Date(row.updated_at).getTime();
        if (theirs > mine + 500 && row.data && row.data.workOrders) {
          const next = migrateState({ ...row.data, lastModified: theirs });
          saveState(next);
          setState(next);
        } else if (mine > theirs + 500) await sbPut(c, stateRef.current);
      }
      setSync({ s: "synced", at: Date.now() });
    } catch {
      setSync({ s: "offline", at: Date.now() });
    }
  }, []);

  useEffect(() => {
    pull();
    const iv = setInterval(pull, 2e4);
    const onVis = () => {
      document.visibilityState === "visible" && pull();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [pull]);

  /* Manual refresh = pull + toast; shared by the header icon, calendar, WOPr, and archive. */
  const refreshNow = () => {
    pull();
    flash("Refreshed at " + fmtShort(Date.now()));
  };

  const { workOrders, timePMs, usagePMs, parts, dailyText } = state;

  const [sysFilter, setSysFilter] = useState("");
  const [assFilter, setAssFilter] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = workOrders;
    if (sysFilter) list = list.filter((w) => (w.system || "") === sysFilter);
    if (assFilter) list = list.filter((w) => (w.assigned || "Unassigned") === assFilter);
    if (q)
      list = list.filter(
        (w) =>
          (w.entity || "").toLowerCase().includes(q) ||
          w.desc.toLowerCase().includes(q) ||
          String(w.id).includes(q) ||
          (w.system || "").toLowerCase().includes(q) ||
          (w.comment || "").toLowerCase().includes(q) ||
          (w.assigned || "").toLowerCase().includes(q) ||
          (w.log || []).some((entry) => (entry.text || "").toLowerCase().includes(q))
      );
    return list;
  }, [workOrders, query, sysFilter, assFilter]);

  const updateWO = (id, patch) =>
    mutate((s) => ({
      ...s,
      workOrders: s.workOrders.map((w) => (w.id === id ? { ...w, ...patch, updated: Date.now(), updatedBy: me } : w)),
    }));

  const openDetail = (id) => setView({ page: "detail", id });
  const detailWO = view.page === "detail" ? workOrders.find((w) => w.id === view.id) : null;

  const closedWOs = useMemo(
    () => workOrders.filter((w) => w.status === "Closed").sort((a, b) => (b.updated || 0) - (a.updated || 0)),
    [workOrders]
  );

  /* status + deadline row menus */
  const setStatusFor = (w, s) => {
    setRowMenu(null);
    if (s === w.status) return;
    const patch = {
      status: s,
      log: [...(w.log || []), { by: me, ts: Date.now(), text: `WorkOrderStatusOption changed to ${s}` }],
    };
    updateWO(w.id, patch);
    flash(s === "Closed" ? `Entry #${w.id} closed.` : `WO #${w.id} status → ${s}`);
  };

  const setDeadlineFor = (w, ts) => {
    setRowMenu(null);
    updateWO(w.id, { deadline: ts });
    flash(ts == null ? `WO #${w.id}: deadline cleared.` : `WO #${w.id} deadline → ${fmtDeadline(ts)}`);
  };

  const setSystemFor = (w, code) => {
    setRowMenu(null);
    updateWO(w.id, { system: code });
    flash(code == null ? `WO #${w.id}: system cleared.` : `WO #${w.id} system → ${code}`);
  };

  const setAssigneeFor = (w, name) => {
    setRowMenu(null);
    const next = name || "Unassigned";
    if (next === (w.assigned || "Unassigned")) return;
    updateWO(w.id, {
      assigned: next,
      log: [...(w.log || []), { by: me, ts: Date.now(), text: `Assigned to ${next}` }],
    });
    flash(next === "Unassigned" ? `WO #${w.id}: assignee cleared.` : `WO #${w.id} → ${next}`);
  };

  const saveDesc = (w, v) => {
    const d = v.trim();
    if (!d) return flash("Description can't be empty.");
    if (d !== w.desc) {
      updateWO(w.id, {
        desc: d,
        log: [...(w.log || []), { by: me, ts: Date.now(), text: `Description updated: '${d}'` }],
      });
      flash(`WO #${w.id} description updated.`);
    }
  };

  const saveComment = (w, v) => {
    const t = v.trim();
    const next = t || "Add a value";
    if (next !== w.comment) {
      updateWO(w.id, {
        comment: next,
        log: [...(w.log || []), { by: me, ts: Date.now(), text: t ? `Comment updated: '${t}'` : "Comment cleared" }],
      });
      flash(`WO #${w.id} comment ${t ? "updated" : "cleared"}.`);
    }
  };

  /* drag to reprioritize */
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const onDragStart = (e, id) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", String(id));
    } catch {}
  };
  const clearDrag = () => {
    setDragId(null);
    setDragOverId(null);
  };
  const moveWO = (id, priority, beforeId) =>
    mutate((s) => {
      const list = [...s.workOrders];
      const from = list.findIndex((w) => w.id === id);
      if (from === -1) return s;
      const [moved] = list.splice(from, 1);
      const upd = { ...moved, priority, updated: Date.now(), updatedBy: me };
      let to = beforeId == null ? -1 : list.findIndex((w) => w.id === beforeId);
      if (to === -1) {
        let last = -1;
        for (let i = 0; i < list.length; i++) list[i].priority === priority && (last = i);
        to = last === -1 ? list.length : last + 1;
      }
      list.splice(to, 0, upd);
      return { ...s, workOrders: list };
    });
  const onDropRow = (e, targetId, priority) => {
    e.preventDefault();
    e.stopPropagation();
    const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
    if (id == null || Number.isNaN(id) || id === targetId) return clearDrag();
    moveWO(id, priority, targetId);
    clearDrag();
  };
  const onDropBand = (e, priority) => {
    e.preventDefault();
    const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
    if (id == null || Number.isNaN(id)) return clearDrag();
    moveWO(id, priority, null);
    clearDrag();
  };

  /* create form */
  const [form, setForm] = useState({
    entity: "", desc: "", priority: 3, status: "Open", system: "", assigned: "Unassigned",
    dlPick: { mode: "none", date: "" },
  });
  const createWO = () => {
    if (!form.desc.trim()) return flash("Description is required.");
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = makeWO(id, me, {
        entity: form.entity.trim(),
        status: form.status,
        priority: Number(form.priority),
        desc: form.desc.trim(),
        assigned: form.assigned || "Unassigned",
        deadline: deadlineFromPick(form.dlPick),
        system: form.system || null,
      });
      flash(`Work Order #${id} created.`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders] };
    });
    setForm({ entity: "", desc: "", priority: 3, status: "Open", system: "", assigned: "Unassigned", dlPick: { mode: "none", date: "" } });
    setShowCreate(false);
  };

  /* Duplicate a work order — fast path for recurring chores (last week's laundry, etc.).
     Copies category/priority/system/deadline/desc; resets status + history to a fresh Open entry. */
  const duplicateWO = (src) => {
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = {
        ...src,
        id,
        status: "Open",
        comment: "Add a value",
        checklist: "",
        checklistState: "",
        updatedBy: me,
        updated: Date.now(),
        created: Date.now(),
        createdBy: me,
        gameplan: [],
        log: [],
      };
      flash(`Work Order #${id} created (copy of #${src.id}).`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders] };
    });
  };

  /* Quick Add: distinct Items already in use, most-used first — one tap to template a new WO. */
  const quickCats = useMemo(() => {
    const seen = new Map();
    for (const w of workOrders) {
      if (!w.entity) continue;
      if (!seen.has(w.entity))
        seen.set(w.entity, { entity: w.entity, priority: w.priority, system: w.system || "", n: 0 });
      seen.get(w.entity).n++;
    }
    return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  }, [workOrders]);

  const quickFill = (c) => {
    setShowCreate(true);
    setForm({ entity: c.entity, desc: "", priority: c.priority, status: "Open", system: c.system, assigned: "Unassigned", dlPick: { mode: "none", date: "" } });
    setTimeout(() => document.getElementById("descInput")?.focus(), 0);
  };

  const applyBulk = () => {
    const ids = Object.keys(checked).filter((k) => checked[k]).map(Number);
    if (!ids.length) return flash("No workorders selected.");
    mutate((s) => ({
      ...s,
      workOrders: s.workOrders.map((w) =>
        ids.includes(w.id)
          ? { ...w, status: bulkStatus, updated: Date.now(), updatedBy: me }
          : w
      ),
    }));
    setChecked({});
    flash(`Updated ${ids.length} workorder(s) → ${bulkStatus}.`);
  };

  const completeTimePM = (pm) => {
    const next = Date.now() + pm.freqH * H;
    mutate((s) => ({ ...s, timePMs: s.timePMs.map((p) => (p.id === pm.id ? { ...p, due: next } : p)) }));
    setGearMenu(null);
    flash(`${pm.name} marked complete — next due ${fmtDT(next)}.`);
  };

  const resetUsagePM = (pm) => {
    mutate((s) => ({ ...s, usagePMs: s.usagePMs.map((p) => (p.id === pm.id ? { ...p, count: 0 } : p)) }));
    setGearMenu(null);
    flash(`${pm.name} counter reset to 0 ${pm.unit}.`);
  };

  const createWOFromPM = (pm) => {
    mutate((s) => {
      const id = s.woSeq + 1;
      const steps = (pm.checklist || []).map((t) => ({ text: t, done: false, by: "" }));
      const wo = makeWO(id, me, {
        entity: pm.tool,
        priority: 4,
        desc: `Execute ${pm.name}`,
        comment: "Generated from OnDeck PM",
        checklist: pm.name,
        checklistState: "Not Started",
        gameplan: steps,
      });
      flash(
        steps.length
          ? `Work Order #${id} created from ${pm.name} — ${steps.length} step(s) added to Gameplan.`
          : `Work Order #${id} created from ${pm.name}.`
      );
      return { ...s, woSeq: id, workOrders: [...s.workOrders, wo] };
    });
    setGearMenu(null);
  };

  /* PM create / edit / delete (recurring PMs). savePM handles both add and edit for
     time- and usage-based PMs; new ids are max(existing)+1 within that table. */
  const savePM = (kind, data, existingId) => {
    mutate((s) => {
      const key = kind === "time" ? "timePMs" : "usagePMs";
      const list = s[key] || [];
      if (existingId != null) {
        return { ...s, [key]: list.map((p) => (p.id === existingId ? { ...p, ...data } : p)) };
      }
      const id = list.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;
      return { ...s, [key]: [...list, { id, ...data }] };
    });
    setGearMenu(null);
    flash(existingId != null ? "PM updated." : "PM added.");
  };

  const deletePM = (kind, id, name) => {
    if (!confirm(`Delete PM “${name}”? This cannot be undone.`)) return;
    mutate((s) => {
      const key = kind === "time" ? "timePMs" : "usagePMs";
      return { ...s, [key]: (s[key] || []).filter((p) => p.id !== id) };
    });
    setGearMenu(null);
    flash("PM deleted.");
  };

  /* Adhoc / one-off PM — creates a Priority 4 work order seeded with the given steps,
     without adding anything to the recurring OnDeck schedules. */
  const createAdhocPM = ({ tool, name, assigned, steps }) => {
    mutate((s) => {
      const id = s.woSeq + 1;
      const gp = (steps || []).map((t) => ({ text: t, done: false, by: "" }));
      const wo = makeWO(id, me, {
        entity: (tool || "").trim(),
        priority: 4,
        desc: name.trim(),
        comment: "One-off PM",
        checklist: name.trim(),
        checklistState: "Not Started",
        assigned: assigned || "Unassigned",
        gameplan: gp,
      });
      flash(`Adhoc PM → Work Order #${id} created${gp.length ? ` with ${gp.length} step(s)` : ""}.`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders] };
    });
    setShowAdhoc(false);
  };

  const stepPart = (id, dir) => {
    let woId = null;
    let partName = "";
    let newStatus = "";
    mutate((s) => {
      const parts = s.parts.map((p) => {
        if (p.id !== id) return p;
        const idx = PART_FLOW.indexOf(p.status);
        const next = PART_FLOW[Math.min(Math.max(idx + dir, 0), PART_FLOW.length - 1)];
        if (next === p.status) return p;
        woId = p.wo;
        partName = p.part;
        newStatus = next;
        return {
          ...p,
          status: next,
          eta: dir > 0 && (next === "Ordered" || next === "Shipped") ? p.eta || Date.now() + 72 * H : p.eta,
        };
      });
      if (!newStatus) return s;
      let workOrders = s.workOrders;
      if (woId)
        workOrders = workOrders.map((w) =>
          w.id === woId
            ? {
                ...w,
                updated: Date.now(),
                updatedBy: me,
                log: [...(w.log || []), { by: me, ts: Date.now(), text: `Supply '${partName}' status → ${newStatus}` }],
              }
            : w
        );
      return { ...s, parts, workOrders };
    });
  };

  const updatePart = (id, field, value, label, shown) => {
    let woId = null;
    let partName = "";
    mutate((s) => {
      const parts = s.parts.map((p) => {
        if (p.id !== id) return p;
        woId = p.wo;
        partName = field === "part" ? value : p.part;
        return { ...p, [field]: value };
      });
      let workOrders = s.workOrders;
      if (woId)
        workOrders = workOrders.map((w) =>
          w.id === woId
            ? {
                ...w,
                updated: Date.now(),
                updatedBy: me,
                log: [...(w.log || []), { by: me, ts: Date.now(), text: `Supply '${partName}': ${label} → ${shown}` }],
              }
            : w
        );
      return { ...s, parts, workOrders };
    });
    flash(`Supply ${label.toLowerCase()} updated.`);
  };

  const updateTimePM = (id, patch) =>
    mutate((s) => ({ ...s, timePMs: s.timePMs.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  const updateUsagePM = (id, patch) =>
    mutate((s) => ({ ...s, usagePMs: s.usagePMs.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  const addPart = (wo, tool, req) => {
    mutate((s) => ({
      ...s,
      partSeq: s.partSeq + 1,
      parts: [
        ...s.parts,
        {
          id: s.partSeq + 1,
          part: req.name,
          tool,
          wo,
          qty: Number(req.qty) || 1,
          source: req.source || "TBD",
          status: "Requested",
          eta: null,
        },
      ],
    }));
    flash(wo ? `Part request logged for ${tool} (WO #${wo}).` : `Part request logged${tool && tool !== "\u2014" ? ` for ${tool}` : ""} (no WO).`);
  };

  /* ---- household lists (Shopping / Today's / Quick Capture) ---- */
  const shopping = state.shopping || [];
  const todays = state.todays || [];
  const capture = state.capture || [];

  const addListItem = (key, text) => {
    const t = text.trim();
    if (!t) return;
    mutate((s) => {
      const id = (s.listSeq || 0) + 1;
      const item = { id, text: t, done: false, by: me, ts: Date.now() };
      const patch = { listSeq: id, [key]: [...(s[key] || []), item] };
      if (key === "todays") patch.todaysDate = tsToDateInput(Date.now());
      return { ...s, ...patch };
    });
  };
  const toggleListItem = (key, id) =>
    mutate((s) => ({
      ...s,
      [key]: (s[key] || []).map((i) => (i.id === id ? { ...i, done: !i.done, doneBy: i.done ? "" : me } : i)),
    }));
  const deleteListItem = (key, id) => mutate((s) => ({ ...s, [key]: (s[key] || []).filter((i) => i.id !== id) }));
  const clearCheckedList = (key) => {
    mutate((s) => ({ ...s, [key]: (s[key] || []).filter((i) => !i.done) }));
    flash("Checked items cleared.");
  };

  /* "Text List" — send a section's open items via the iOS share sheet (Messages etc.);
     clipboard fallback where Web Share isn't available. Reused by every list-style section. */
  const shareLines = async (lines) => {
    if (!lines) return flash("Nothing to send.");
    if (navigator.share) {
      try {
        await navigator.share({ text: lines });
      } catch {}
    } else if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(lines);
        flash("List copied — paste into Messages.");
      } catch {
        flash("Couldn't copy on this device.");
      }
    } else flash("Sharing not supported on this device.");
  };
  const shareOpen = (list) => shareLines(list.filter((i) => !i.done).map((i) => "• " + i.text).join("\n"));
  const sharePartOrders = () =>
    shareLines(
      parts
        .filter((p) => p.status !== "Put Away")
        .map((p) => `• ${p.part}${p.tool && p.tool !== "—" ? ` (${p.tool})` : ""} — ${p.status}`)
        .join("\n")
    );

  /* Today's List morning prompt: if the list has items but wasn't touched today, ask. */
  const todayStr = tsToDateInput(Date.now());
  const todaysStale = todays.length > 0 && state.todaysDate !== todayStr;
  const keepTodays = () => {
    mutate((s) => ({ ...s, todaysDate: todayStr }));
    flash("Keeping the list going.");
  };
  const freshTodays = () => {
    mutate((s) => ({ ...s, todays: [], todaysDate: todayStr }));
    flash("Today's List cleared — fresh start.");
  };

  /* Quick Capture → full Work Order (Full view gear action). Removes the capture item. */
  const promoteCapture = (it) => {
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = makeWO(id, me, {
        desc: it.text,
        log: [{ by: me, ts: Date.now(), text: "Promoted from Quick Capture" }],
      });
      flash(`Work Order #${id} created from Quick Capture.`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders], capture: (s.capture || []).filter((c) => c.id !== it.id) };
    });
    setGearMenu(null);
  };

  /* View mode is per-device (homebase.cfg.v1), independent of Owner.
     Simple = lists + Notes only; Full = the whole board. */
  const simple = cfg.viewMode === "simple";
  const scrollToSect = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  const dotColor = { local: "#8a99a8", syncing: "#e8b90c", synced: "#2fa14a", offline: "#c0271a" }[sync.s];
  const syncLabel =
    sync.s === "local"
      ? "Local only"
      : sync.s === "syncing"
      ? "Syncing…"
      : sync.s === "synced"
      ? `Synced ${sync.at ? fmtClock(sync.at) : ""}`
      : "Offline — saved locally";

  return (
    <div className="app">
      <div className="chrome">
        <span className="chromeBrand">{"◉"} HOMEBASE</span>
        <span
          className="verChip"
          title="View what's new"
          onClick={() => setView({ page: "changelog" })}
        >
          {typeof window !== "undefined" && window.HOMEBASE_VERSION ? window.HOMEBASE_VERSION : "V?"}
        </span>
        <nav className="chromeNav">
          <span className={view.page === "passdown" ? "on" : ""} onClick={() => setView({ page: "passdown" })}>
            Main
          </span>
        </nav>
        <span className="chromeRight">
          <span
            className="refreshTop"
            onClick={refreshNow}
            title="Refresh"
          >
            {"⟳"}
          </span>
          <span className="syncChip" onClick={pull} title="Tap to sync now">
            <span className="syncDot" style={{ background: dotColor }} /> {syncLabel}
          </span>
          <u>{me}</u>
          {" | "}
          {fmtDeadline(Date.now())}
          <span className="gearTop" onClick={() => setShowSettings(true)} title="Settings">
            {"⚙"}
          </span>
        </span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {showSettings && (
        <SettingsModal
          cfg={cfg}
          onClose={() => setShowSettings(false)}
          onSave={(c) => {
            setCfg(c);
            saveCfg(c);
            setShowSettings(false);
            flash("Settings saved.");
            setTimeout(pull, 100);
          }}
          onReset={() => {
            const seed = seedData();
            saveState(seed);
            setState(seed);
            setShowSettings(false);
            flash("Local data reset to demo seed.");
          }}
          onChangelog={() => {
            setShowSettings(false);
            setView({ page: "changelog" });
          }}
          onDeleteAll={() => {
            mutate((s) => ({ ...s, workOrders: [], timePMs: [], usagePMs: [], parts: [] }));
            setShowSettings(false);
            setView({ page: "passdown" });
            flash("All work orders, supplies, and PM schedules deleted.");
          }}
        />
      )}

      {showPMModal && (
        <PMModal
          kind={showPMModal.kind}
          pm={showPMModal.pm}
          onClose={() => setShowPMModal(null)}
          onSave={(data, existingId) => {
            savePM(showPMModal.kind, data, existingId);
            setShowPMModal(null);
          }}
        />
      )}

      {showAdhoc && <AdhocPMModal me={me} onClose={() => setShowAdhoc(false)} onCreate={createAdhocPM} />}

      {view.page === "passdown" && (
        <div className="page">
          <div className="ownerLine ownerBar">
            <b>Owner:</b>
            {["Cole", "Jessamine"].map((n) => (
              <button
                key={n}
                className={"ownBtn" + (me === n ? " ownOn" : "")}
                onClick={() => {
                  const c = { ...cfg, userName: n };
                  setCfg(c);
                  saveCfg(c);
                  flash(`Owner set to ${n}.`);
                }}
              >
                {n}
              </button>
            ))}
            <span className="viewBtns">
              <b>View:</b>
              {[
                { v: "full", lb: "Full" },
                { v: "simple", lb: "Simple" },
              ].map(({ v, lb }) => (
                <button
                  key={v}
                  className={"ownBtn vwBtn" + (cfg.viewMode === v ? " vwOn" : "")}
                  title={v === "full" ? "Whole board on this phone" : "Lists + Notes only on this phone"}
                  onClick={() => {
                    if (cfg.viewMode === v) return;
                    const c = { ...cfg, viewMode: v };
                    setCfg(c);
                    saveCfg(c);
                    flash(v === "simple" ? "Simple view — lists & Notes only." : "Full view — whole board.");
                  }}
                >
                  {lb}
                </button>
              ))}
            </span>
            <span className="ownHint">updates, comments & closures log as: {me}</span>
          </div>

          {!simple && (
            <div className="listNav">
              <button className="btnGrad" onClick={() => scrollToSect("sectShop")}>
                {"\u{1F6D2}"} Shopping{shopping.filter((i) => !i.done).length ? ` (${shopping.filter((i) => !i.done).length})` : ""}
              </button>
              <button className="btnGrad" onClick={() => scrollToSect("sectToday")}>
                {"\u{1F4CB}"} Today{todays.filter((i) => !i.done).length ? ` (${todays.filter((i) => !i.done).length})` : ""}
              </button>
              <button className="btnGrad" onClick={() => scrollToSect("sectCapture")}>
                {"\u26A1"} Capture{capture.filter((i) => !i.done).length ? ` (${capture.filter((i) => !i.done).length})` : ""}
              </button>
            </div>
          )}

          {!simple && (
            <>
          <DeadlineCalendar
            workOrders={workOrders}
            onOpen={openDetail}
            onRefresh={refreshNow}
          />

          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□ WOPr"}</span>
          </div>
          <div className="pmSub woprSub">
            <button className="btnGrad" onClick={refreshNow}>
              Refresh
            </button>
            <button className="btnGrad" onClick={() => setView({ page: "archive" })} title="View closed work orders">
              WOPr - Archive
            </button>
            <label className="chk">
              <input type="checkbox" checked={showCreate} onChange={(e) => setShowCreate(e.target.checked)} />
              Create New Workorder
            </label>
            <label className="chk">
              <input type="checkbox" checked={showBulk} onChange={(e) => setShowBulk(e.target.checked)} />
              Bulk Update
            </label>
            <label className="chk sysFilter">
              Category
              <select value={sysFilter} onChange={(e) => setSysFilter(e.target.value)}>
                <SystemOptions noneLabel="All" />
              </select>
            </label>
            <label className="chk sysFilter">
              Assignee
              <select value={assFilter} onChange={(e) => setAssFilter(e.target.value)}>
                <option value="">All</option>
                {ASSIGNEES.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            {showBulk && (
              <span className="bulkBar">
                {"Set selected to "}
                <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                  {Object.keys(STATUS_META).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <button className="btnGrad" onClick={applyBulk}>
                  Apply
                </button>
              </span>
            )}
          </div>
          {showCreate && (
            <div className="createForm">
              <b>New Work Order</b>
              {quickCats.length > 0 && (
                <div className="quickAdd">
                  <span className="qaLabel">Quick add:</span>
                  {quickCats.map((c) => (
                    <button
                      key={c.entity}
                      className="qaBtn"
                      title={`P${c.priority}${c.system ? " · " + c.system : ""}`}
                      onClick={() => quickFill(c)}
                    >
                      {c.entity}
                    </button>
                  ))}
                </div>
              )}
              <div className="createGrid">
                <label>
                  Item (optional)
                  <input
                    id="entityInput"
                    value={form.entity}
                    placeholder="e.g. Litterbox, Mazda CX-5"
                    autoFocus
                    onChange={(e) => setForm({ ...form, entity: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && createWO()}
                  />
                </label>
                <label>
                  Category
                  <select value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })}>
                    <SystemOptions />
                  </select>
                </label>
                <label>
                  Priority
                  <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                    {PRIORITIES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {Object.keys(STATUS_META)
                      .filter((s) => s !== "Closed")
                      .map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Assignee
                  <select value={form.assigned} onChange={(e) => setForm({ ...form, assigned: e.target.value })}>
                    {ASSIGNEES.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Deadline
                  <span className="dlPickRow">
                    <DeadlineSelect value={form.dlPick} onChange={(v) => setForm({ ...form, dlPick: v })} />
                  </span>
                </label>
                <label className="wide">
                  Description
                  <input
                    id="descInput"
                    value={form.desc}
                    placeholder="What needs doing?"
                    onChange={(e) => setForm({ ...form, desc: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && createWO()}
                  />
                </label>
              </div>
              <button className="btnGrad" onClick={createWO}>
                Create
              </button>
              <button className="btnGrad" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
            </div>
          )}

          <div className="tableWrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="thSearch">
                    <span className="mag">{"⌕"}</span>
                    <input
                      className="searchBox"
                      value={query}
                      placeholder="Search"
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </th>
                  <th style={{ width: 120 }}>STATUS {"▾"}</th>
                  <th>DESCRIPTION</th>
                  <th>COMMENT</th>
                  <th style={{ width: 96 }}>DEADLINE {"▾"}</th>
                  <th style={{ width: 170 }}>CHECKLISTS</th>
                  <th style={{ width: 110 }}>LAST UPDATED {"▾"}</th>
                </tr>
              </thead>
              <tbody>
                {PRIORITIES.map((p) => {
                  const searching = query.trim().length > 0;
                  const rows = filtered.filter((w) => w.priority === p.id && (searching || w.status !== "Closed"));
                  const isCollapsed = collapsed[p.id];
                  return (
                    <React.Fragment key={p.id}>
                      <tr
                        className={`band ${p.band}`}
                        onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onDropBand(e, p.id)}
                      >
                        <td colSpan={7}>
                          <span className="bandToggle">{isCollapsed ? "+" : "−"}</span> {p.label}
                          <span className="bandCount">{rows.length ? ` (${rows.length})` : " (0)"}</span>
                        </td>
                      </tr>
                      {!isCollapsed &&
                        rows.map((w, i) => (
                          <tr
                            key={w.id}
                            draggable
                            onDragStart={(e) => onDragStart(e, w.id)}
                            onDragEnd={clearDrag}
                            onDragOver={(e) => {
                              e.preventDefault();
                              dragOverId !== w.id && setDragOverId(w.id);
                            }}
                            onDragLeave={() => setDragOverId((cur) => (cur === w.id ? null : cur))}
                            onDrop={(e) => onDropRow(e, w.id, p.id)}
                            className={
                              (i % 2 ? "rowAlt" : "row") +
                              (dragId === w.id ? " dragSrc" : "") +
                              (dragOverId === w.id && dragId !== w.id ? " dragOver" : "")
                            }
                          >
                            <td className="entityCell">
                              <div className="entityTop">
                                <span className="dragHandle" title="Drag to reprioritize">
                                  {"⠿"}
                                </span>
                                <input
                                  type="checkbox"
                                  checked={!!checked[w.id]}
                                  onChange={(e) => setChecked((c) => ({ ...c, [w.id]: e.target.checked }))}
                                />
                                <span className="rank">{i + 1}</span>
                                <a className="woLink" onClick={() => openDetail(w.id)}>
                                  {w.id}
                                </a>
                              </div>
                              <div className="entitySub menuCell">
                                {w.system ? (
                                  <SystemBadge
                                    code={w.system}
                                    onClick={() =>
                                      setRowMenu(
                                        rowMenu?.type === "system" && rowMenu.id === w.id
                                          ? null
                                          : { type: "system", id: w.id }
                                      )
                                    }
                                  />
                                ) : (
                                  <a
                                    className="sysNone"
                                    title="Tag a category"
                                    onClick={() =>
                                      setRowMenu(
                                        rowMenu?.type === "system" && rowMenu.id === w.id
                                          ? null
                                          : { type: "system", id: w.id }
                                      )
                                    }
                                  >
                                    +CAT
                                  </a>
                                )}
                                {rowMenu?.type === "system" && rowMenu.id === w.id && (
                                  <div className="gearMenu sysMenu">
                                    <b>Category:</b>
                                    <select
                                      value={w.system || ""}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setSystemFor(w, e.target.value || null)}
                                    >
                                      <SystemOptions />
                                    </select>
                                  </div>
                                )}
                                <a
                                  className={`asgnChip asgn-${(w.assigned || "Unassigned").toLowerCase()}`}
                                  title="Reassign work order"
                                  onClick={() =>
                                    setRowMenu(
                                      rowMenu?.type === "assign" && rowMenu.id === w.id ? null : { type: "assign", id: w.id }
                                    )
                                  }
                                >
                                  {(w.assigned || "Unassigned") === "Unassigned"
                                    ? "+ASGN"
                                    : (w.assigned || "").slice(0, 1).toUpperCase() + (w.assigned || "").slice(1)}
                                </a>
                                {rowMenu?.type === "assign" && rowMenu.id === w.id && (
                                  <div className="gearMenu sysMenu">
                                    <b>Assignee:</b>
                                    <select
                                      value={w.assigned || "Unassigned"}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setAssigneeFor(w, e.target.value)}
                                    >
                                      {ASSIGNEES.map((a) => (
                                        <option key={a}>{a}</option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="flowCell menuCell">
                              <a
                                title="Change status"
                                onClick={() =>
                                  setRowMenu(
                                    rowMenu?.type === "status" && rowMenu.id === w.id ? null : { type: "status", id: w.id }
                                  )
                                }
                              >
                                {w.status}
                              </a>
                              {rowMenu?.type === "status" && rowMenu.id === w.id && (
                                <div className="gearMenu stMenu">
                                  {Object.keys(STATUS_META).map((s) => (
                                    <div
                                      key={s}
                                      className={s === w.status ? "menuCur" : ""}
                                      onClick={() => setStatusFor(w, s)}
                                    >
                                      <span className={`stIcon ${STATUS_META[s].cls}`}>{STATUS_META[s].icon}</span> {s}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="descCell">
                              <InlineEdit value={w.desc} onSave={(v) => saveDesc(w, v)} title="Tap to edit description" />
                            </td>
                            <td className="commentCell">
                              <InlineEdit
                                value={w.comment === "Add a value" ? "" : w.comment}
                                onSave={(v) => saveComment(w, v)}
                                empty="Add a value"
                                title="Tap to edit comment"
                              />
                            </td>
                            <td className="dlCell menuCell">
                              <a
                                className={isOverdue(w) ? "dlOver" : w.deadline == null ? "dlNone" : ""}
                                title="Set deadline"
                                onClick={() =>
                                  setRowMenu(
                                    rowMenu?.type === "deadline" && rowMenu.id === w.id
                                      ? null
                                      : { type: "deadline", id: w.id }
                                  )
                                }
                              >
                                {w.deadline != null ? fmtDeadline(w.deadline) : "—"}
                              </a>
                              {rowMenu?.type === "deadline" && rowMenu.id === w.id && (
                                <div className="gearMenu dlMenu">
                                  <div onClick={() => setDeadlineFor(w, null)}>No deadline</div>
                                  {DL_PRESETS.map((p) => (
                                    <div key={p.mode} onClick={() => setDeadlineFor(w, p.ts())}>
                                      {p.label} ({fmtDeadline(p.ts())})
                                    </div>
                                  ))}
                                  <div className="dlDateRow">
                                    {"Pick date: "}
                                    <input
                                      type="date"
                                      value={w.deadline != null ? tsToDateInput(w.deadline) : ""}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => e.target.value && setDeadlineFor(w, dateInputToTs(e.target.value))}
                                    />
                                  </div>
                                </div>
                              )}
                            </td>
                            <td className="chkCell">
                              {w.checklist ? (
                                <>
                                  <a className="woLink">{w.checklist}</a>
                                  <div className="chkState">{w.checklistState}</div>
                                </>
                              ) : (
                                ""
                              )}
                            </td>
                            <td className="updCell">
                              <a>{w.updatedBy}</a>
                              <div className="updTime">{fmtShort(w.updated)}</div>
                            </td>
                          </tr>
                        ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ---- OnDeck PMs (time based) ---- */}
          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□ Time Based PMs"}</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="pmSub">
            {"Schedules as of " + fmtDT(Date.now()) + " "}
            <button className="btnGrad" onClick={() => flash("PM schedules refreshed.")}>
              Refresh
            </button>
            <button className="btnGrad" onClick={() => setShowPMModal({ kind: "time", pm: null })}>
              {"+ Add PM"}
            </button>
            <button className="btnGrad" onClick={() => setShowAdhoc(true)}>
              {"+ Adhoc PM"}
            </button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 56 }}>Actions</th>
                  <th style={{ width: 110 }}>Item {"⇅"}</th>
                  <th>PM Name {"⇅"}</th>
                  <th style={{ width: 120 }}>PM Status {"⇅"}</th>
                  <th style={{ width: 120 }} className="thHi">Hours Until Overdue {"↓"}</th>
                  <th style={{ width: 100 }}>Hours Until Due</th>
                  <th style={{ width: 110 }}>Due Date {"⇅"}</th>
                </tr>
              </thead>
              <tbody>
                {[...timePMs]
                  .sort((a, b) => a.due - b.due)
                  .map((pm, i) => {
                    const hrsToDue = Math.round((pm.due - Date.now()) / H);
                    const overdueIn = hrsToDue + 48;
                    const status = hrsToDue <= -48 ? "OVERDUE" : hrsToDue <= 24 ? "DUE" : "OPPORTUNITY";
                    return (
                      <tr key={pm.id} className={i % 2 ? "rowAlt" : "row"}>
                        <td className="gearCell">
                          <span
                            className="gear"
                            onClick={() =>
                              setGearMenu(gearMenu?.type === "t" && gearMenu.id === pm.id ? null : { type: "t", id: pm.id })
                            }
                          >
                            {"⚙"}
                          </span>
                          {gearMenu?.type === "t" && gearMenu.id === pm.id && (
                            <div className="gearMenu">
                              <div onClick={() => completeTimePM(pm)}>{"✓ Mark PM complete"}</div>
                              <div onClick={() => createWOFromPM(pm)}>{"+ Create Work Order"}</div>
                              <div onClick={() => { setGearMenu(null); setShowPMModal({ kind: "time", pm }); }}>{"✎ Edit PM & checklist"}</div>
                              <div className="gearDel" onClick={() => deletePM("time", pm.id, pm.name)}>{"🗑 Delete PM"}</div>
                            </div>
                          )}
                        </td>
                        <td>
                          <b>
                            <InlineEdit
                              value={pm.tool}
                              onSave={(v) => v.trim() && (updateTimePM(pm.id, { tool: v.trim() }), flash(`PM item → ${v.trim()}`))}
                              title="Tap to edit item"
                            />
                          </b>
                        </td>
                        <td className="pmName">
                          <InlineEdit
                            value={pm.name}
                            onSave={(v) => v.trim() && (updateTimePM(pm.id, { name: v.trim() }), flash("PM name updated."))}
                            title="Tap to edit PM name"
                          />
                          {pm.checklist && pm.checklist.length > 0 && (
                            <span
                              className="chkChip"
                              title="Checklist steps — tap to edit"
                              onClick={() => setShowPMModal({ kind: "time", pm })}
                            >
                              {"☑ " + pm.checklist.length}
                            </span>
                          )}
                        </td>
                        <td>
                          <PMStatusBadge status={status} />
                        </td>
                        <td className="numCell hiCol">
                          <InlineEdit
                            type="number"
                            className="ieNum"
                            value={overdueIn}
                            display={overdueIn > 0 ? overdueIn : <span className="neg">{overdueIn}</span>}
                            onSave={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n)) return;
                              const due = Date.now() + (n - 48) * H;
                              updateTimePM(pm.id, { due });
                              flash(`${pm.name}: due ${fmtDT(due)}.`);
                            }}
                            title="Tap to edit hours until overdue"
                          />
                        </td>
                        <td className="numCell">
                          <InlineEdit
                            type="number"
                            className="ieNum"
                            value={hrsToDue}
                            display={hrsToDue > 0 ? hrsToDue : "—"}
                            onSave={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n)) return;
                              const due = Date.now() + n * H;
                              updateTimePM(pm.id, { due });
                              flash(`${pm.name}: due ${fmtDT(due)}.`);
                            }}
                            title="Tap to edit hours until due"
                          />
                        </td>
                        <td className="numCell">
                          <InlineEdit
                            type="date"
                            value={tsToDateInput(pm.due)}
                            display={fmtDT(pm.due)}
                            onSave={(v) => {
                              if (!v) return;
                              const due = dateInputToTs(v);
                              updateTimePM(pm.id, { due });
                              flash(`${pm.name}: due ${fmtDT(due)}.`);
                            }}
                            title="Tap to pick a due date"
                          />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {/* ---- OnDeck usage based PMs ---- */}
          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□ Usage Based PMs"}</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="pmSub">
            {"Schedules as of " + fmtDT(Date.now()) + " "}
            <button className="btnGrad" onClick={() => flash("PM schedules refreshed.")}>
              Refresh
            </button>
            <button className="btnGrad" onClick={() => setShowPMModal({ kind: "usage", pm: null })}>
              {"+ Add PM"}
            </button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 56 }}>Actions</th>
                  <th style={{ width: 110 }}>Item {"⇅"}</th>
                  <th>PM Name {"⇅"}</th>
                  <th style={{ width: 120 }}>PM Status {"⇅"}</th>
                  <th style={{ width: 170 }} className="thHi">Count Until Overdue {"↓"}</th>
                  <th style={{ width: 150 }}>Count Until Due</th>
                </tr>
              </thead>
              <tbody>
                {[...usagePMs]
                  .sort((a, b) => b.count / b.limit - a.count / a.limit)
                  .map((pm, i) => {
                    const pctOver = Math.round((pm.count / pm.limit) * 100);
                    const pctDue = Math.round((pm.count / pm.due) * 100);
                    const status = pm.count >= pm.limit ? "OVERDUE" : pm.count >= pm.due ? "DUE" : "OPPORTUNITY";
                    return (
                      <tr key={pm.id} className={i % 2 ? "rowAlt" : "row"}>
                        <td className="gearCell">
                          <span
                            className="gear"
                            onClick={() =>
                              setGearMenu(gearMenu?.type === "u" && gearMenu.id === pm.id ? null : { type: "u", id: pm.id })
                            }
                          >
                            {"⚙"}
                          </span>
                          {gearMenu?.type === "u" && gearMenu.id === pm.id && (
                            <div className="gearMenu">
                              <div onClick={() => resetUsagePM(pm)}>{"✓ Complete + reset counter"}</div>
                              <div onClick={() => createWOFromPM(pm)}>{"+ Create Work Order"}</div>
                              <div onClick={() => { setGearMenu(null); setShowPMModal({ kind: "usage", pm }); }}>{"✎ Edit PM & checklist"}</div>
                              <div className="gearDel" onClick={() => deletePM("usage", pm.id, pm.name)}>{"🗑 Delete PM"}</div>
                            </div>
                          )}
                        </td>
                        <td>
                          <b>
                            <InlineEdit
                              value={pm.tool}
                              onSave={(v) => v.trim() && (updateUsagePM(pm.id, { tool: v.trim() }), flash(`PM item → ${v.trim()}`))}
                              title="Tap to edit item"
                            />
                          </b>
                        </td>
                        <td className="pmName">
                          <InlineEdit
                            value={pm.name}
                            onSave={(v) => v.trim() && (updateUsagePM(pm.id, { name: v.trim() }), flash("PM name updated."))}
                            title="Tap to edit PM name"
                          />
                          {pm.checklist && pm.checklist.length > 0 && (
                            <span
                              className="chkChip"
                              title="Checklist steps — tap to edit"
                              onClick={() => setShowPMModal({ kind: "usage", pm })}
                            >
                              {"☑ " + pm.checklist.length}
                            </span>
                          )}
                        </td>
                        <td>
                          <PMStatusBadge status={status} />
                        </td>
                        <td className="numCell hiCol">
                          {pctOver}% (
                          <InlineEdit
                            type="number"
                            className="ieNum"
                            value={pm.count}
                            onSave={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n) || n < 0) return;
                              updateUsagePM(pm.id, { count: n });
                              flash(`${pm.name}: counter → ${n} ${pm.unit}.`);
                            }}
                            title="Tap to edit current count"
                          />
                          {" / "}
                          <InlineEdit
                            type="number"
                            className="ieNum"
                            value={pm.limit}
                            onSave={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n) || n <= 0) return;
                              updateUsagePM(pm.id, { limit: n });
                              flash(`${pm.name}: overdue limit → ${n} ${pm.unit}.`);
                            }}
                            title="Tap to edit overdue limit"
                          />{" "}
                          {pm.unit})
                        </td>
                        <td className="numCell">
                          {pctDue}% (
                          <InlineEdit
                            type="number"
                            className="ieNum"
                            value={pm.count}
                            onSave={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n) || n < 0) return;
                              updateUsagePM(pm.id, { count: n });
                              flash(`${pm.name}: counter → ${n} ${pm.unit}.`);
                            }}
                            title="Tap to edit current count"
                          />
                          {" / "}
                          <InlineEdit
                            type="number"
                            className="ieNum"
                            value={pm.due}
                            onSave={(v) => {
                              const n = Number(v);
                              if (!Number.isFinite(n) || n <= 0) return;
                              updateUsagePM(pm.id, { due: n });
                              flash(`${pm.name}: due threshold → ${n} ${pm.unit}.`);
                            }}
                            title="Tap to edit due threshold"
                          />{" "}
                          {pm.unit})
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□ Part Orders"}</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="pmSub">
            {parts.filter((p) => p.status !== "Put Away").length}
            {" open supply request(s) "}
            <button className="btnGrad" onClick={() => setShowPartOrder((v) => !v)}>
              Order Supplies
            </button>
            <button className="btnGrad" onClick={sharePartOrders} title="Send open supply requests via Messages">
              Text List
            </button>
          </div>
          {showPartOrder && (
            <div className="statusPicker partOrderBox">
              <b>Order Supply (no Work Order needed):</b>
              <input
                className="partInput"
                value={partOrderReq.name}
                placeholder="Part description"
                onChange={(e) => setPartOrderReq({ ...partOrderReq, name: e.target.value })}
              />
              Qty
              <input
                className="partQty"
                type="number"
                min="1"
                value={partOrderReq.qty}
                onChange={(e) => setPartOrderReq({ ...partOrderReq, qty: e.target.value })}
              />
              <input
                className="partSrc"
                value={partOrderReq.source}
                placeholder="Source (Amazon, Home Depot…)"
                onChange={(e) => setPartOrderReq({ ...partOrderReq, source: e.target.value })}
              />
              <input
                className="partSrc"
                value={partOrderReq.tool}
                placeholder="Item (optional)"
                onChange={(e) => setPartOrderReq({ ...partOrderReq, tool: e.target.value })}
              />
              <button
                className="btnGrad"
                onClick={() => {
                  if (!partOrderReq.name.trim()) return flash("Part description required.");
                  addPart(null, partOrderReq.tool.trim() || "\u2014", {
                    name: partOrderReq.name.trim(),
                    qty: partOrderReq.qty,
                    source: partOrderReq.source.trim(),
                  });
                  setPartOrderReq({ name: "", qty: 1, source: "", tool: "" });
                  setShowPartOrder(false);
                }}
              >
                Submit Request
              </button>
            </div>
          )}
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th>Part {"⇅"}</th>
                  <th style={{ width: 100 }}>For Item</th>
                  <th style={{ width: 80 }}>WO #</th>
                  <th style={{ width: 44 }}>Qty</th>
                  <th style={{ width: 110 }}>Source</th>
                  <th style={{ width: 100 }}>Status {"⇅"}</th>
                  <th style={{ width: 100 }}>ETA</th>
                  <th style={{ width: 120 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...parts]
                  .sort((a, b) => PART_FLOW.indexOf(a.status) - PART_FLOW.indexOf(b.status))
                  .map((p, i) => (
                    <tr key={p.id} className={(i % 2 ? "rowAlt" : "row") + (p.status === "Put Away" ? " partDone" : "")}>
                      <td>
                        <InlineEdit
                          value={p.part}
                          onSave={(v) => v.trim() && updatePart(p.id, "part", v.trim(), "Part", v.trim())}
                          title="Tap to edit part"
                        />
                      </td>
                      <td>
                        <b>
                          <InlineEdit
                            value={p.tool === "—" ? "" : p.tool}
                            empty="—"
                            onSave={(v) => updatePart(p.id, "tool", v.trim() || "—", "For Item", v.trim() || "—")}
                            title="Tap to edit item"
                          />
                        </b>
                      </td>
                      <td>
                        {p.wo ? (
                          <a className="woLink" onClick={() => workOrders.some((w) => w.id === p.wo) && openDetail(p.wo)}>
                            {p.wo}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="numCell">
                        <InlineEdit
                          type="number"
                          className="ieNum"
                          value={p.qty}
                          onSave={(v) => {
                            const n = Number(v);
                            if (!Number.isFinite(n) || n < 1) return;
                            updatePart(p.id, "qty", n, "Qty", n);
                          }}
                          title="Tap to edit quantity"
                        />
                      </td>
                      <td>
                        <InlineEdit
                          value={p.source}
                          empty="TBD"
                          onSave={(v) => updatePart(p.id, "source", v.trim() || "TBD", "Source", v.trim() || "TBD")}
                          title="Tap to edit source"
                        />
                      </td>
                      <td>
                        <span className={`partBadge pb${PART_FLOW.indexOf(p.status)}`}>{p.status}</span>
                      </td>
                      <td className="numCell">
                        <InlineEdit
                          type="date"
                          value={p.eta ? tsToDateInput(p.eta) : ""}
                          display={p.eta ? fmtDT(p.eta) : null}
                          empty="—"
                          onSave={(v) => {
                            if (!v) return;
                            const ts = dateInputToTs(v);
                            updatePart(p.id, "eta", ts, "ETA", fmtDeadline(ts));
                          }}
                          title="Tap to set ETA"
                        />
                      </td>
                      <td className="partActs">
                        {p.status !== "Requested" && (
                          <button
                            className="btnGrad btnSm"
                            title={`Back to ${PART_FLOW[PART_FLOW.indexOf(p.status) - 1]}`}
                            onClick={() => stepPart(p.id, -1)}
                          >
                            {"◀"}
                          </button>
                        )}
                        {p.status !== "Put Away" ? (
                          <button className="btnGrad btnSm" onClick={() => stepPart(p.id, 1)}>
                            {"▶"} {PART_FLOW[PART_FLOW.indexOf(p.status) + 1]}
                          </button>
                        ) : (
                          <span className="muted">Complete</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
            </>
          )}

          <HouseListSection
            anchorId="sectShop"
            title={"□ Shopping List"}
            items={shopping}
            variant="strike"
            placeholder="Add item… (tap the mic on your keyboard to dictate)"
            emptyText="Shopping list is empty. Add items above — they stay until cleared."
            onAdd={(t) => addListItem("shopping", t)}
            onToggle={(id) => toggleListItem("shopping", id)}
            onDelete={(id) => deleteListItem("shopping", id)}
            actions={
              <>
                <button className="btnGrad" onClick={() => shareOpen(shopping)} title="Send unchecked items via Messages">
                  Text List
                </button>
                <button className="btnGrad" onClick={() => clearCheckedList("shopping")}>
                  Clear Checked
                </button>
              </>
            }
          />

          <HouseListSection
            anchorId="sectToday"
            title={"□ Today's List"}
            items={todays}
            variant="check"
            placeholder="Add a stop or errand for today…"
            emptyText="Nothing planned yet today. Add stops, errands, or activities."
            onAdd={(t) => addListItem("todays", t)}
            onToggle={(id) => toggleListItem("todays", id)}
            onDelete={(id) => deleteListItem("todays", id)}
            actions={
              <>
                <button className="btnGrad" onClick={() => shareOpen(todays)} title="Send unchecked items via Messages">
                  Text List
                </button>
                <button className="btnGrad" onClick={() => clearCheckedList("todays")}>
                  Clear Checked
                </button>
              </>
            }
            banner={
              todaysStale ? (
                <div className="mornBanner">
                  <b>New day</b> {"—"} this list is from {state.todaysDate || "earlier"}. Keep it going or start fresh?
                  <button className="btnGrad" onClick={keepTodays}>
                    Keep list
                  </button>
                  <button className="btnGrad" onClick={freshTodays}>
                    Start fresh
                  </button>
                </div>
              ) : null
            }
          />

          <HouseListSection
            anchorId="sectCapture"
            title={"□ Quick Capture"}
            items={capture}
            variant="check"
            placeholder="Type it before you forget…"
            emptyText="Nothing captured. Jot one-liners here — no category needed."
            onAdd={(t) => addListItem("capture", t)}
            onToggle={(id) => toggleListItem("capture", id)}
            onDelete={(id) => deleteListItem("capture", id)}
            actions={
              <>
                <button className="btnGrad" onClick={() => shareOpen(capture)} title="Send unchecked items via Messages">
                  Text List
                </button>
                <button className="btnGrad" onClick={() => clearCheckedList("capture")}>
                  Clear Checked
                </button>
              </>
            }
            extraCol={!simple}
            rowExtra={(it) => (
              <>
                <span
                  className="gear"
                  title="Actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setGearMenu(gearMenu?.type === "cap" && gearMenu.id === it.id ? null : { type: "cap", id: it.id });
                  }}
                >
                  {"⚙"}
                </span>
                {gearMenu?.type === "cap" && gearMenu.id === it.id && (
                  <div className="gearMenu">
                    <div onClick={() => promoteCapture(it)}>Promote to Work Order</div>
                  </div>
                )}
              </>
            )}
          />

          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□ Notes"}</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="daily">
            {editDaily ? (
              <textarea
                value={dailyText}
                rows={5}
                onChange={(e) => mutate((s) => ({ ...s, dailyText: e.target.value, dailyBy: me, dailyAt: Date.now() }))}
              />
            ) : (
              <pre>{dailyText}</pre>
            )}
            <div className="dailyBtns">
              <button className="btnGrad" onClick={() => setEditDaily(!editDaily)}>
                {editDaily ? "Save Textbox" : "Edit this Textbox"}
              </button>
              <span className="dailyMeta">
                Last Updated By: {state.dailyBy} [ {fmtDT(state.dailyAt)} ]
              </span>
            </div>
          </div>
        </div>
      )}

      {view.page === "archive" && (
        <div className="page">
          <div className="crumbLine">
            <a onClick={() => setView({ page: "passdown" })}>{"\u2190"} Main</a>
            {"  /  "}
            <b>WOPr - Archive</b>
          </div>
          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□ WOPr - Archive"}</span>
          </div>
          <div className="pmSub">
            {closedWOs.length}
            {" closed work order(s) "}
            <button className="btnGrad" onClick={refreshNow}>
              Refresh
            </button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 120 }}>CATEGORY</th>
                  <th style={{ width: 40 }}>PRI</th>
                  <th>DESCRIPTION</th>
                  <th>COMMENT</th>
                  <th style={{ width: 170 }}>CHECKLISTS</th>
                  <th style={{ width: 110 }}>CLOSED BY {"\u25be"}</th>
                </tr>
              </thead>
              <tbody>
                {closedWOs.length === 0 && (
                  <tr className="row">
                    <td colSpan={6} className="muted">
                      No closed work orders yet. Entries appear here when a WO is closed.
                    </td>
                  </tr>
                )}
                {closedWOs.map((w, i) => (
                  <tr key={w.id} className={i % 2 ? "rowAlt" : "row"}>
                    <td className="entityCell">
                      <div className="entityTop">
                        <a className="woLink" onClick={() => setView({ page: "detail", id: w.id, back: "archive" })}>
                          {w.id}
                        </a>
                      </div>
                      {w.system && (
                        <div className="entitySub">
                          <SystemBadge code={w.system} />
                        </div>
                      )}
                    </td>
                    <td className="numCell">P{w.priority}</td>
                    <td className="descCell" onClick={() => setView({ page: "detail", id: w.id, back: "archive" })}>
                      {w.desc}
                    </td>
                    <td className="commentCell">{w.comment === "Add a value" ? "" : w.comment}</td>
                    <td className="chkCell">
                      {w.checklist ? (
                        <>
                          <a className="woLink">{w.checklist}</a>
                          <div className="chkState">{w.checklistState}</div>
                        </>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="updCell">
                      <a>{w.updatedBy}</a>
                      <div className="updTime">{fmtShort(w.updated)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view.page === "changelog" && (
        <div className="page">
          <div className="crumbLine">
            <a onClick={() => setView({ page: "passdown" })}>{"←"} Main</a>
            {"  /  "}
            <b>What's New</b>
          </div>
          <div className="pmHeader">
            <span className="pmHeaderTitle">{"What's New"}</span>
          </div>
          <div className="pmSub">Homebase version history {"—"} newest first.</div>
          <div className="changelogList">
            {CHANGELOG.map((c) => (
              <div key={c.v} className="chEntry">
                <div className="chEntryHead">
                  <b>V{c.v}</b>
                  {c.date ? <span className="chEntryDate">{c.date}</span> : null}
                </div>
                <ul>
                  {c.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {view.page === "detail" && detailWO && (
        <DetailPage
          wo={detailWO}
          me={me}
          onBack={() => setView({ page: view.back === "archive" ? "archive" : "passdown" })}
          onUpdate={(patch) => updateWO(detailWO.id, patch)}
          onAddPart={(req) => addPart(detailWO.id, detailWO.entity, req)}
          onDuplicate={() => {
            duplicateWO(detailWO);
            setView({ page: "passdown" });
          }}
          flash={flash}
        />
      )}
      {view.page === "detail" && !detailWO && (
        <div className="page">
          <div className="muted">Work order not found (may have been removed on another device).</div>
          <button className="btnGrad" onClick={() => setView({ page: "passdown" })}>
            {"←"} Back to Main
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- settings modal ---------- */
/* Reusable steps editor — plain-English checklist steps (strings). Used by both the
   PM create/edit modal and the Adhoc PM modal. Add / remove / reorder; no drag on
   purpose (keeps it thumb-friendly on a phone). */
function StepsEditor({ steps, setSteps }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    setSteps([...steps, t]);
    setDraft("");
  };
  const remove = (i) => setSteps(steps.filter((_, j) => j !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const list = [...steps];
    [list[i], list[j]] = [list[j], list[i]];
    setSteps(list);
  };
  return (
    <div className="stepsEditor">
      {steps.length === 0 && <div className="muted">No steps yet — add the tasks to run for this PM.</div>}
      {steps.map((s, i) => (
        <div className="stepRow" key={i}>
          <span className="stepNum">{i + 1}.</span>
          <span className="stepText">{s}</span>
          <span className="stepBtns">
            <a onClick={() => move(i, -1)} title="Move up">{"▲"}</a>
            <a onClick={() => move(i, 1)} title="Move down">{"▼"}</a>
            <a className="stepDel" onClick={() => remove(i)} title="Remove step">{"✕"}</a>
          </span>
        </div>
      ))}
      <div className="stepAdd">
        <input
          value={draft}
          placeholder="Add a step…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <button className="btnGrad" onClick={add}>Add step</button>
      </div>
    </div>
  );
}

/* Create / edit a recurring PM (time- or usage-based) plus its checklist. One modal
   serves both add (pm=null) and edit (pm=existing). Fields stay in plain household
   terms — days for time PMs, counts for usage PMs. */
function PMModal({ kind, pm, onClose, onSave }) {
  const isTime = kind === "time";
  const [tool, setTool] = useState(pm?.tool || "");
  const [name, setName] = useState(pm?.name || "");
  const [dueDate, setDueDate] = useState(tsToDateInput(pm?.due || Date.now() + 7 * H));
  const [everyDays, setEveryDays] = useState(pm ? Math.round((pm.freqH || 168) / 24) : 7);
  const [unit, setUnit] = useState(pm?.unit || "mi");
  const [count, setCount] = useState(pm?.count ?? 0);
  const [dueAt, setDueAt] = useState(pm?.due ?? 5000);
  const [overAt, setOverAt] = useState(pm?.limit ?? 6000);
  const [steps, setSteps] = useState(Array.isArray(pm?.checklist) ? pm.checklist : []);

  const save = () => {
    if (!name.trim()) return alert("PM name is required.");
    if (isTime) {
      const days = Math.max(1, Number(everyDays) || 1);
      onSave(
        { tool: tool.trim(), name: name.trim(), due: dateInputToTs(dueDate), freqH: days * 24, checklist: steps },
        pm?.id
      );
    } else {
      onSave(
        {
          tool: tool.trim(),
          name: name.trim(),
          unit: (unit || "mi").trim(),
          count: Number(count) || 0,
          due: Number(dueAt) || 0,
          limit: Number(overAt) || 0,
          checklist: steps,
        },
        pm?.id
      );
    }
  };

  return (
    <div className="modalWrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalTitle">
          {(pm ? "Edit " : "Add ") + (isTime ? "Time Based PM" : "Usage Based PM")}
        </div>
        <label className="modalField">
          Item (what it's on)
          <input value={tool} placeholder="e.g. Litterbox, Mazda CX-5" onChange={(e) => setTool(e.target.value)} />
        </label>
        <label className="modalField">
          PM name
          <input value={name} placeholder="e.g. Full litter change" onChange={(e) => setName(e.target.value)} />
        </label>
        {isTime ? (
          <div className="modalRow">
            <label className="modalField">
              Next due
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
            <label className="modalField">
              Repeat every (days)
              <input type="number" min="1" value={everyDays} onChange={(e) => setEveryDays(e.target.value)} />
            </label>
          </div>
        ) : (
          <>
            <div className="modalRow">
              <label className="modalField">
                Unit
                <input value={unit} placeholder="mi / hrs / cycles" onChange={(e) => setUnit(e.target.value)} />
              </label>
              <label className="modalField">
                Current count
                <input type="number" value={count} onChange={(e) => setCount(e.target.value)} />
              </label>
            </div>
            <div className="modalRow">
              <label className="modalField">
                Due at ({unit})
                <input type="number" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </label>
              <label className="modalField">
                Overdue at ({unit})
                <input type="number" value={overAt} onChange={(e) => setOverAt(e.target.value)} />
              </label>
            </div>
          </>
        )}
        <div className="modalSection">Checklist steps</div>
        <div className="modalHint">These steps drop into the work order's Gameplan whenever you create a Work Order from this PM.</div>
        <StepsEditor steps={steps} setSteps={setSteps} />
        <div className="modalBtns">
          <button className="btnGrad" onClick={save}>{pm ? "Save changes" : "Add PM"}</button>
          <button className="btnGrad" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* Adhoc / one-off PM — no recurring schedule. Creates a Priority 4 work order with
   the given steps as its Gameplan. */
function AdhocPMModal({ me, onClose, onCreate }) {
  const [tool, setTool] = useState("");
  const [name, setName] = useState("");
  const [assigned, setAssigned] = useState("Unassigned");
  const [steps, setSteps] = useState([]);
  const create = () => {
    if (!name.trim()) return alert("Name is required.");
    onCreate({ tool, name, assigned, steps });
  };
  return (
    <div className="modalWrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalTitle">Adhoc PM (one-off)</div>
        <div className="modalHint">Creates a Priority 4 work order with these steps — nothing is added to the recurring schedules.</div>
        <label className="modalField">
          Item (optional)
          <input value={tool} placeholder="e.g. Water heater" onChange={(e) => setTool(e.target.value)} />
        </label>
        <label className="modalField">
          What needs doing
          <input value={name} placeholder="e.g. Flush water heater" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="modalField">
          Assign to
          <select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
            {ASSIGNEES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <div className="modalSection">Checklist steps</div>
        <StepsEditor steps={steps} setSteps={setSteps} />
        <div className="modalBtns">
          <button className="btnGrad" onClick={create}>Create work order</button>
          <button className="btnGrad" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ cfg, onClose, onSave, onReset, onChangelog, onDeleteAll }) {
  const [form, setForm] = useState({ userName: cfg.userName || "", sbUrl: cfg.sbUrl || "", sbKey: cfg.sbKey || "" });
  const [test, setTest] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const testConn = async () => {
    if (!form.sbUrl || !form.sbKey) return setTest("Enter URL and key first.");
    setTest("Testing…");
    try {
      await sbGet({ sbUrl: form.sbUrl, sbKey: form.sbKey });
      setTest("✓ Connected — table reachable.");
    } catch (e) {
      setTest("✗ " + String(e.message || e).slice(0, 160) + " (Did you run the setup SQL? See README.)");
    }
  };
  return (
    <div className="modalWrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalTitle">Settings</div>
        <label className="modalField">
          Display name (shows on your updates)
          <input
            value={form.userName}
            placeholder="e.g. Cole"
            onChange={(e) => setForm({ ...form, userName: e.target.value })}
          />
        </label>
        <div className="modalSection">Household sync (Supabase {"—"} optional)</div>
        <label className="modalField">
          Project URL
          <input
            value={form.sbUrl}
            placeholder="https://xxxx.supabase.co"
            onChange={(e) => setForm({ ...form, sbUrl: e.target.value })}
          />
        </label>
        <label className="modalField">
          Anon (public) API key
          <input value={form.sbKey} placeholder="eyJ…" onChange={(e) => setForm({ ...form, sbKey: e.target.value })} />
        </label>
        <div className="modalHint">
          One-time setup lives in the README: create a free Supabase project, run the setup SQL, then paste the same URL +
          key on every phone. Leave blank to run local-only.
        </div>
        {test && <div className="modalTest">{test}</div>}
        <div className="modalBtns">
          <button className="btnGrad" onClick={testConn}>
            Test connection
          </button>
          <button
            className="btnGrad"
            onClick={() => onSave({ ...cfg, userName: form.userName.trim() || "Me", sbUrl: form.sbUrl.trim(), sbKey: form.sbKey.trim() })}
          >
            Save
          </button>
          <button className="btnGrad" onClick={onClose}>
            Cancel
          </button>
          <button className="btnGrad" onClick={onChangelog}>
            What's New
          </button>
          <button
            className="btnDanger"
            onClick={() => {
              confirm("Replace local data with the demo seed?") && onReset();
            }}
          >
            Reset demo data
          </button>
          <button className="btnDanger" onClick={() => setConfirmDel(true)}>
            Delete all data…
          </button>
        </div>
        {confirmDel && (
          <div className="dangerConfirm">
            <div className="dangerConfirmText">
              This permanently deletes <b>every work order (including the archive), every supply, and every PM
              schedule</b> — on every synced phone. Notes, household lists, and settings are kept. This cannot be
              undone.
            </div>
            <div className="modalBtns">
              <button
                className="btnDanger"
                onClick={() => {
                  setConfirmDel(false);
                  onDeleteAll();
                }}
              >
                Yes, delete everything
              </button>
              <button className="btnGrad" onClick={() => setConfirmDel(false)}>
                Keep my data
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- work order detail ---------- */
function DetailPage({ wo, me, onBack, onUpdate, onAddPart, onDuplicate, flash }) {
  const [tab, setTab] = useState("Entry Editor");
  const [comment, setComment] = useState("");
  const [pendStatus, setPendStatus] = useState(wo.status);
  const [showStatus, setShowStatus] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [showDeadline, setShowDeadline] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [dlPick, setDlPick] = useState(() =>
    wo.deadline != null ? { mode: "date", date: tsToDateInput(wo.deadline) } : { mode: "none", date: "" }
  );
  const [partReq, setPartReq] = useState({ name: "", qty: 1, source: "" });

  const ribbon = [
    { label: "Edit Details", ic: "✎" },
    { label: "Duplicate", ic: "⧉", act: () => onDuplicate && onDuplicate() },
    { label: "Change Status", ic: "⇄", act: () => setShowStatus((v) => !v) },
    { label: "Set Deadline", ic: "\u{1F4C5}", act: () => setShowDeadline((v) => !v) },
    { label: "Set Category", ic: "\u{1F3E0}", act: () => setShowSystem((v) => !v) },
    {
      label: "Close Entry",
      ic: "✔",
      act: () => {
        onUpdate({ status: "Closed" });
        flash(`Entry #${wo.id} closed.`);
        onBack();
      },
    },
    { label: "Add Comment", ic: "\u{1F5E8}", act: () => document.getElementById("cmtBox")?.focus() },
    { label: "Contacts", ic: "\u{1F465}" },
    {
      label: "GamePlan",
      ic: "\u{1F4CB}",
      act: () => {
        document.getElementById("gpSection")?.scrollIntoView({ behavior: "smooth" });
        setTimeout(() => document.getElementById("gpBox")?.focus({ preventScroll: true }), 350);
      },
    },
    { label: "Order Supplies", ic: "\u{1F6D2}", act: () => setShowParts((v) => !v) },
  ];

  const addComment = () => {
    comment.trim() && (onUpdate({ log: [...wo.log, { by: me, ts: Date.now(), text: comment.trim() }] }), setComment(""));
  };

  const toggleGameplan = (idx) => {
    const gp = wo.gameplan.map((g, i) => (i === idx ? { ...g, done: !g.done, by: g.done ? "" : me } : g));
    onUpdate({ gameplan: gp });
  };

  const [gpNew, setGpNew] = useState("");
  const addGameplan = () => {
    const t = gpNew.trim();
    if (!t) return;
    onUpdate({ gameplan: [...(wo.gameplan || []), { text: t, done: false, by: "" }] });
    setGpNew("");
  };
  const removeGameplan = (idx) => onUpdate({ gameplan: wo.gameplan.filter((_, i) => i !== idx) });

  /* gameplan drag-to-reorder */
  const [gpDragIdx, setGpDragIdx] = useState(null);
  const [gpDragOverIdx, setGpDragOverIdx] = useState(null);
  const onGpDragStart = (e, idx) => {
    setGpDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", String(idx));
    } catch {}
  };
  const clearGpDrag = () => {
    setGpDragIdx(null);
    setGpDragOverIdx(null);
  };
  const moveGameplan = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    const list = [...wo.gameplan];
    const [moved] = list.splice(fromIdx, 1);
    const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
    list.splice(insertAt, 0, moved);
    onUpdate({ gameplan: list });
  };
  const onGpDrop = (e, idx) => {
    e.preventDefault();
    e.stopPropagation();
    const from = gpDragIdx ?? Number(e.dataTransfer.getData("text/plain"));
    if (from == null || Number.isNaN(from)) return clearGpDrag();
    moveGameplan(from, idx);
    clearGpDrag();
  };

  /* gameplan inline editing */
  const [gpEditIdx, setGpEditIdx] = useState(null);
  const [gpEditText, setGpEditText] = useState("");
  const startGpEdit = (idx, text) => {
    setGpEditIdx(idx);
    setGpEditText(text);
  };
  const saveGpEdit = () => {
    const t = gpEditText.trim();
    if (t) {
      const gp = wo.gameplan.map((g, i) => (i === gpEditIdx ? { ...g, text: t } : g));
      onUpdate({ gameplan: gp });
    }
    setGpEditIdx(null);
    setGpEditText("");
  };
  const cancelGpEdit = () => {
    setGpEditIdx(null);
    setGpEditText("");
  };

  return (
    <div className="page">
      <div className="crumbLine">
        <a onClick={onBack}>{"←"} Main</a>
        {"  /  "}
        <b>
          {wo.entity ? wo.entity + " - " : ""}Edit Work Order #{wo.id}
        </b>
      </div>
      <div className="detailTabs">
        {["Entry Editor", "FYIs", "Communication", "Reference"].map((t) => (
          <span key={t} className={tab === t ? "dtOn" : ""} onClick={() => setTab(t)}>
            {t}
          </span>
        ))}
      </div>
      <div className="ribbon">
        {ribbon.map((b) => (
          <div key={b.label} className="ribBtn" onClick={b.act || (() => flash(`${b.label}: coming in a later rev.`))}>
            <div className="ribIc">{b.ic}</div>
            <div className="ribLb">{b.label}</div>
          </div>
        ))}
      </div>

      {showStatus && (
        <div className="statusPicker">
          {"Change status: "}
          <select value={pendStatus} onChange={(e) => setPendStatus(e.target.value)}>
            {Object.keys(STATUS_META).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button
            className="btnGrad"
            onClick={() => {
              onUpdate({ status: pendStatus });
              setShowStatus(false);
              flash(`Status → ${pendStatus}`);
            }}
          >
            Apply
          </button>
        </div>
      )}

      {showDeadline && (
        <div className="statusPicker">
          {"Set deadline: "}
          <DeadlineSelect value={dlPick} onChange={setDlPick} />
          <button
            className="btnGrad"
            onClick={() => {
              const ts = deadlineFromPick(dlPick);
              onUpdate({ deadline: ts });
              setShowDeadline(false);
              flash(ts == null ? "Deadline cleared." : `Deadline → ${fmtDeadline(ts)}`);
            }}
          >
            Apply
          </button>
        </div>
      )}

      {showSystem && (
        <div className="statusPicker">
          {"Set category: "}
          <select
            value={wo.system || ""}
            onChange={(e) => {
              const code = e.target.value || null;
              onUpdate({ system: code });
              setShowSystem(false);
              flash(code == null ? "Category cleared." : `Category → ${code}`);
            }}
          >
            <SystemOptions />
          </select>
        </div>
      )}

      {showParts && (
        <div className="statusPicker">
          <b>Order Supplies:</b>
          <input
            className="partInput"
            value={partReq.name}
            placeholder="Part description"
            onChange={(e) => setPartReq({ ...partReq, name: e.target.value })}
          />
          Qty
          <input
            className="partQty"
            type="number"
            min="1"
            value={partReq.qty}
            onChange={(e) => setPartReq({ ...partReq, qty: e.target.value })}
          />
          <input
            className="partSrc"
            value={partReq.source}
            placeholder="Source (Amazon, Home Depot…)"
            onChange={(e) => setPartReq({ ...partReq, source: e.target.value })}
          />
          <button
            className="btnGrad"
            onClick={() => {
              if (!partReq.name.trim()) return flash("Part description required.");
              onAddPart({ name: partReq.name.trim(), qty: partReq.qty, source: partReq.source.trim() });
              setPartReq({ name: "", qty: 1, source: "" });
              setShowParts(false);
            }}
          >
            Submit Request
          </button>
        </div>
      )}

      {wo.checklist && (
        <div className="fyiBar">
          <span className="fyiTag">{"•"} FYI</span>
          <b>Completed PMs in Executed Order:</b>
          {" "}
          <a className="woLink">
            {wo.checklist} for {wo.entity}
          </a>
          {" "}
          <span className="fyiMeta">
            {wo.checklistState === "Done" ? `Completed on ${fmtShort(wo.updated)}` : `Status: ${wo.checklistState || "Not Started"}`}
          </span>
        </div>
      )}

      <div className="edTitle">Entry Details for Work Order # {wo.id}</div>
      <div className="edBlock">
        <div className="edTool">
          {"Item:  "}
          <b>{wo.entity}</b>{" "}
          <span className={`stIcon ${(STATUS_META[wo.status] || STATUS_META.Open).cls}`}>
            {(STATUS_META[wo.status] || STATUS_META.Open).icon}
          </span>
        </div>
        <table className="kvTable">
          <tbody>
            <tr>
              <td>Description:</td>
              <td>{wo.desc}</td>
            </tr>
            <tr>
              <td>Entry Status:</td>
              <td>{wo.status}</td>
            </tr>
            <tr>
              <td>Priority:</td>
              <td>{wo.priority}</td>
            </tr>
            <tr>
              <td>Category:</td>
              <td>
                {wo.system ? (
                  <>
                    <SystemBadge code={wo.system} />
                    {" "}
                    {SYSTEM_META[wo.system] ? SYSTEM_META[wo.system].label : ""}
                  </>
                ) : (
                  "None"
                )}{" "}
                <a onClick={() => setShowSystem((v) => !v)}>change</a>
              </td>
            </tr>
            <tr>
              <td>Deadline:</td>
              <td>
                {wo.deadline != null ? (
                  <span className={isOverdue(wo) ? "dlOver" : ""}>
                    {fmtDeadline(wo.deadline)}
                    {isOverdue(wo) ? " — OVERDUE" : ""}
                  </span>
                ) : (
                  "No deadline"
                )}{" "}
                <a onClick={() => setShowDeadline((v) => !v)}>change</a>
              </td>
            </tr>
            <tr>
              <td>Assigned to:</td>
              <td>
                <select
                  className="dtlAssignSel"
                  value={wo.assigned || "Unassigned"}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === (wo.assigned || "Unassigned")) return;
                    onUpdate({
                      assigned: next,
                      log: [...(wo.log || []), { by: me, ts: Date.now(), text: `Assigned to ${next}` }],
                    });
                    flash(next === "Unassigned" ? `WO #${wo.id}: assignee cleared.` : `WO #${wo.id} → ${next}`);
                  }}
                >
                  {ASSIGNEES.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <td>Created on:</td>
              <td>
                {fmtDT(wo.created)} by {wo.createdBy}
              </td>
            </tr>
            <tr>
              <td>Last Updated on:</td>
              <td>
                {fmtDT(wo.updated)} by {wo.updatedBy}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="edTitle" id="gpSection">Gameplan</div>
      <div className="edBlock">
        <div className="gpHead">Active Items</div>
        {wo.gameplan.filter((g) => !g.done).length === 0 && <div className="muted">No active gameplan items</div>}
        {wo.gameplan.map((g, i) =>
          g.done ? null : (
            <div
              key={i}
              className={
                "gpItem" +
                (gpDragIdx === i ? " dragSrc" : "") +
                (gpDragOverIdx === i && gpDragIdx !== i ? " dragOver" : "")
              }
              draggable
              onDragStart={(e) => onGpDragStart(e, i)}
              onDragEnd={clearGpDrag}
              onDragOver={(e) => {
                e.preventDefault();
                gpDragOverIdx !== i && setGpDragOverIdx(i);
              }}
              onDragLeave={() => setGpDragOverIdx((cur) => (cur === i ? null : cur))}
              onDrop={(e) => onGpDrop(e, i)}
            >
              <span className="dragHandle" title="Drag to reorder">
                {"⠿"}
              </span>{" "}
              {i + 1}
              {") "}
              <input type="checkbox" checked={false} onChange={() => toggleGameplan(i)} />
              {" "}
              {gpEditIdx === i ? (
                <input
                  className="gpEditBox"
                  autoFocus
                  value={gpEditText}
                  onChange={(e) => setGpEditText(e.target.value)}
                  onBlur={saveGpEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveGpEdit();
                    if (e.key === "Escape") cancelGpEdit();
                  }}
                />
              ) : (
                <span className="gpText" title="Click to edit" onClick={() => startGpEdit(i, g.text)}>
                  {g.text}
                </span>
              )}
              {" "}
              <a className="gpDel" title="Remove step" onClick={() => removeGameplan(i)}>
                {"✕"}
              </a>
            </div>
          )
        )}
        <div className="cmtAdd gpAdd">
          <input
            id="gpBox"
            value={gpNew}
            placeholder="Add gameplan step…"
            onChange={(e) => setGpNew(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addGameplan()}
          />
          <button className="btnGrad" onClick={addGameplan}>
            Add Step
          </button>
        </div>
        <div className="gpHead" style={{ marginTop: 8 }}>
          Completed Items
        </div>
        {wo.gameplan.filter((g) => g.done).length === 0 && <div className="muted">There are no completed gameplan items</div>}
        {wo.gameplan.map((g, i) =>
          g.done ? (
            <div key={i} className="gpItem gpDone">
              {"▪ "}
              {i + 1}
              {") "}
              <input type="checkbox" checked={true} onChange={() => toggleGameplan(i)} />
              {" "}
              {gpEditIdx === i ? (
                <input
                  className="gpEditBox"
                  autoFocus
                  value={gpEditText}
                  onChange={(e) => setGpEditText(e.target.value)}
                  onBlur={saveGpEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveGpEdit();
                    if (e.key === "Escape") cancelGpEdit();
                  }}
                />
              ) : (
                <s className="gpText" title="Click to edit" onClick={() => startGpEdit(i, g.text)}>
                  {g.text}
                </s>
              )}
              {" "}
              <span className="gpBy">(by {g.by})</span>
              {" "}
              <a className="gpDel" title="Remove step" onClick={() => removeGameplan(i)}>
                {"✕"}
              </a>
            </div>
          ) : null
        )}
      </div>

      <div className="edTitle">Comments / Log Events</div>
      <div className="edBlock">
        {wo.log.length === 0 && <div className="muted">No comments logged yet.</div>}
        {wo.log.map((entry, i) => (
          <div key={i} className="logRow">
            <span className="logMeta">
              {fmtShort(entry.ts)} {"—"} <a>{entry.by}</a>:
            </span>{" "}
            {entry.text}
          </div>
        ))}
        <div className="cmtAdd">
          <input
            id="cmtBox"
            value={comment}
            placeholder="Add comment…"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addComment()}
          />
          <button className="btnGrad" onClick={addComment}>
            Add Comment
          </button>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);
