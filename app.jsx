/* Homebase Passdown — single-file React app
   Source of truth: bundle with esbuild into index.html (see redeploy steps).
   Storage: localStorage "homebase.state.v1" (+ optional Supabase homebase_state sync). */

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";

const H = 3600 * 1e3;
const LS_STATE = "homebase.state.v1";
const LS_CFG = "homebase.cfg.v1";

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

function fmtToday() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/* ---------- deadline helpers ---------- */
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
  return out;
}

function migrateState(s) {
  if (!s || !Array.isArray(s.workOrders)) return s;
  const wos = s.workOrders.map(migrateWO);
  return wos.some((w, i) => w !== s.workOrders[i]) ? { ...s, workOrders: wos } : s;
}

const PART_FLOW = ["Requested", "Ordered", "Shipped", "Received", "Installed"];

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
      { code: "AUTO", label: "Cars/trucks" },
      { code: "AUTO-MAINT", label: "Scheduled vehicle maintenance" },
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
      { code: "PET", label: "Pet care" },
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
    {
      id: nwo(), entity: "WH01", level: "L8", status: "In Progress", priority: 1, system: "PLUMB",
      flow: "Waiting Parts",
      desc: "Water heater leaking at T&P relief valve",
      comment: "Supply valve shut off. Replacement valve ordered (SupplyHouse). Household on cold-water protocol.",
      checklist: "TSVWH01LeakResponseADHOC", checklistState: "In Prog",
      updatedBy: "C. Kuehn", updated: t - 2 * H,
      contacts: ["C. Kuehn", "S. Kuehn"],
      rootCause: "Valve seat corrosion (unit age: 9 yrs)",
      preventable: "Add annual T&P valve lift test to PM plan",
      assigned: "On-Call Homeowner", created: t - 26 * H, createdBy: "C. Kuehn",
      deadline: t + 48 * H,
      gameplan: [
        { text: "Shut off cold supply + gas valve", done: true, by: "C. Kuehn" },
        { text: "Drain tank to below valve level", done: true, by: "C. Kuehn" },
        { text: "Install new T&P valve on arrival", done: false, by: "" },
        { text: "Leak check @ operating pressure, restore gas", done: false, by: "" },
      ],
      log: [
        { by: "C. Kuehn", ts: t - 26 * H, text: "Found water pooling at drain pan during morning walkthrough." },
        { by: "S. Kuehn", ts: t - 20 * H, text: "WorkOrderStatusOption changed to Waiting Parts. User Comment: 'Valve on order'" },
      ],
    },
    {
      id: nwo(), entity: "HVAC01", level: "L8", status: "Open", priority: 2, system: "HVAC",
      flow: "Open",
      desc: "AC not cooling upstairs zone (Zone 2)",
      comment: "Run capacitor suspected — reading 3.1µF on a 5µF spec. Part in garage stock bin B3.",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: t - 5 * H,
      contacts: ["C. Kuehn"],
      rootCause: "None Entered", preventable: "None Entered",
      assigned: "C. Kuehn", created: t - 30 * H, createdBy: "C. Kuehn",
      deadline: t + 96 * H,
      gameplan: [
        { text: "Kill power at disconnect, discharge cap", done: false, by: "" },
        { text: "Swap run capacitor, verify µF", done: false, by: "" },
      ],
      log: [{ by: "C. Kuehn", ts: t - 30 * H, text: "Zone 2 blowing warm. Compressor hums, fan slow-start." }],
    },
    {
      id: nwo(), entity: "GDO01", level: "L8", status: "Open", priority: 2, system: "APPL",
      flow: "Open",
      desc: "Garage door opener grinding on open cycle",
      comment: "Bundle with rail lube PM if time permits.",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: t - 12 * H,
      contacts: ["S. Kuehn"],
      rootCause: "None Entered", preventable: "None Entered",
      assigned: "On-Call Homeowner", created: t - 40 * H, createdBy: "S. Kuehn",
      deadline: null,
      gameplan: [{ text: "Inspect drive gear + chain tension", done: false, by: "" }],
      log: [],
    },
    {
      id: nwo(), entity: "LAWN01", level: "L8", status: "Open", priority: 3, system: "CLEAN",
      flow: "Open",
      desc: "Weekly mow + edge + trim",
      comment: "Add a value",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: t - 20 * H,
      contacts: ["C. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "C. Kuehn", created: t - 60 * H, createdBy: "C. Kuehn",
      deadline: t + 24 * H,
      gameplan: [],
      log: [],
    },
    {
      id: nwo(), entity: "GUTR01", level: "L8", status: "Open", priority: 3, system: "CLEAN",
      flow: "Open",
      desc: "Clear downspout — rear NE corner overflowing",
      comment: "Please follow ladder-safety RFC if working above 6 ft solo.",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: t - 8 * H,
      contacts: ["S. Kuehn"],
      rootCause: "None Entered", preventable: "Install downspout strainer",
      assigned: "On-Call Homeowner", created: t - 50 * H, createdBy: "S. Kuehn",
      deadline: endOfMonth(),
      gameplan: [],
      log: [],
    },
    {
      id: nwo(), entity: "DW01", level: "L8", status: "On Hold", priority: 3, system: "APPL",
      flow: "On Hold",
      desc: "Dishwasher lower rack wheel replacement",
      comment: "Cosmetic / usability. On hold pending parts order consolidation.",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: t - 70 * H,
      contacts: ["C. Kuehn"],
      rootCause: "Wear item", preventable: "N/A",
      assigned: "C. Kuehn", created: t - 100 * H, createdBy: "C. Kuehn",
      deadline: null,
      gameplan: [],
      log: [],
    },
    {
      id: nwo(), entity: "HVAC01", level: "L8", status: "In Progress", priority: 4, system: "HVAC",
      flow: "Data Due",
      desc: "Monthly filter change (MERV 13) — both returns",
      comment: "Bundle into consumable/weekly PMs as they come due, and as time permits.",
      checklist: "TSVHVACFilterPM", checklistState: "Not Started",
      updatedBy: "C. Kuehn", updated: t - 15 * H,
      contacts: ["C. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "C. Kuehn", created: t - 45 * H, createdBy: "C. Kuehn",
      deadline: endOfMonth(),
      gameplan: [],
      log: [],
    },
    {
      id: nwo(), entity: "SMK01", level: "L8", status: "Open", priority: 4, system: "ELEC",
      flow: "Open",
      desc: "Smoke / CO detector test + battery rotation (all 6 units)",
      comment: "Hallway unit chirped once — replace that battery first.",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: t - 30 * H,
      contacts: ["S. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "On-Call Homeowner", created: t - 80 * H, createdBy: "S. Kuehn",
      deadline: null,
      gameplan: [],
      log: [],
    },
    {
      id: nwo(), entity: "DECK01", level: "L5", status: "In Progress", priority: 5, system: "PROJ",
      flow: "Waiting Wx",
      desc: "Deck sand + re-stain project (SS + TTV)",
      comment: "Needs 3 consecutive dry days. Keep this open, to be used upon weather window.",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: t - 90 * H,
      contacts: ["C. Kuehn", "S. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "C. Kuehn", created: t - 200 * H, createdBy: "C. Kuehn",
      deadline: endOfYear(),
      gameplan: [
        { text: "Pressure wash + 48h dry", done: false, by: "" },
        { text: "Sand rails + treads", done: false, by: "" },
        { text: "Stain coat 1 + 2", done: false, by: "" },
      ],
      log: [],
    },
    {
      id: nwo(), entity: "PAINT01", level: "L6", status: "Open", priority: 5, system: "PROJ",
      flow: "Open",
      desc: "Hallway scuff touch-up (SW Agreeable Gray)",
      comment: "Add a value",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: t - 110 * H,
      contacts: ["S. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "S. Kuehn", created: t - 150 * H, createdBy: "S. Kuehn",
      deadline: null,
      gameplan: [],
      log: [],
    },
  ];
  const timePMs = [
    { id: 1, tool: "LAWN01", name: "TSVLawnMowWeeklyPM", pre: "Yes", due: t - 7 * H, freqH: 168 },
    { id: 2, tool: "HVAC01", name: "TSVHVACFilterMonthlyPM", pre: "Yes", due: t - 26 * H, freqH: 720 },
    { id: 3, tool: "WH01", name: "TSVWaterHeaterFlushAnnualPM", pre: "", due: t - 614 * H, freqH: 8760 },
    { id: 4, tool: "SMK01", name: "TSVSmokeDetectorTestPM", pre: "Yes", due: t + 59 * H, freqH: 4380 },
    { id: 5, tool: "GUTR01", name: "TSVGutterCleanQuarterlyPM", pre: "", due: t + 98 * H, freqH: 2190 },
    { id: 6, tool: "GDO01", name: "TSVGarageRailLubePM", pre: "", due: t + 170 * H, freqH: 4380 },
    { id: 7, tool: "DRYER01", name: "TSVDryerVentCleanPM", pre: "Yes", due: t - 311 * H, freqH: 8760 },
  ];
  const usagePMs = [
    { id: 1, tool: "CAR01", name: "TSVCarOilChangePM", count: 4712, limit: 5e3, due: 4500, unit: "mi" },
    { id: 2, tool: "HVAC01", name: "TSVBlowerRuntimePM", count: 582, limit: 600, due: 540, unit: "hrs" },
    { id: 3, tool: "MWR01", name: "TSVMowerBladeSharpenPM", count: 38.5, limit: 50, due: 45, unit: "hrs" },
    { id: 4, tool: "FRG01", name: "TSVFridgeWaterFilterPM", count: 5.2, limit: 6, due: 5.5, unit: "mo" },
  ];
  const parts = [
    { id: ++partSeq, part: 'T&P relief valve 3/4" (Watts 100XL)', tool: "WH01", wo: 6012251, qty: 1, source: "SupplyHouse", status: "Shipped", eta: t + 46 * H },
    { id: ++partSeq, part: "Run capacitor 5µF 370V", tool: "HVAC01", wo: 6012252, qty: 1, source: "Stock bin B3", status: "Received", eta: null },
    { id: ++partSeq, part: "MERV 13 filter 20x25x1 (2-pk)", tool: "HVAC01", wo: null, qty: 2, source: "Amazon", status: "Ordered", eta: t + 96 * H },
    { id: ++partSeq, part: "Dishwasher lower rack wheel kit", tool: "DW01", wo: 6012256, qty: 1, source: "RepairClinic", status: "Requested", eta: null },
    { id: ++partSeq, part: "9V lithium batteries (6-pk)", tool: "SMK01", wo: null, qty: 1, source: "Costco", status: "Received", eta: null },
  ];
  return {
    workOrders, timePMs, usagePMs, parts,
    dailyText: `• Water OFF to WH01 — do not restore until valve replaced
• Trash + recycling out Thursday night
• Zone 2 AC warm — fans running upstairs overnight
• Check mail hold status before trip`,
    dailyBy: "C. Kuehn",
    dailyAt: t - 4 * H,
    woSeq, partSeq,
    lastModified: t,
  };
}

/* ---------- storage ---------- */
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch { return {}; }
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

/* Shared deadline mode select. value = {mode, date}; onChange gets the new value. */
function DeadlineSelect({ value, onChange }) {
  return (
    <>
      <select value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value })}>
        <option value="none">No deadline</option>
        <option value="tom">Tomorrow ({fmtDeadline(relDays(1))})</option>
        <option value="wk">Next week ({fmtDeadline(relDays(7))})</option>
        <option value="eom">End of month ({fmtDeadline(endOfMonth())})</option>
        <option value="eoy">End of year ({fmtDeadline(endOfYear())})</option>
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
  if (pick.mode === "tom") return relDays(1);
  if (pick.mode === "wk") return relDays(7);
  if (pick.mode === "eom") return endOfMonth();
  if (pick.mode === "eoy") return endOfYear();
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
        <span className="pmHeaderTitle">{"□  D e a d l i n e  C a l e n d a r"}</span>
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
                    {w.entity}
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
  const [rowMenu, setRowMenu] = useState(null); // {type:"status"|"deadline", id}
  const [toast, setToast] = useState("");
  const [showSettings, setShowSettings] = useState(false);
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

  const { workOrders, timePMs, usagePMs, parts, dailyText } = state;

  const [sysFilter, setSysFilter] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = workOrders;
    if (sysFilter) list = list.filter((w) => (w.system || "") === sysFilter);
    if (q)
      list = list.filter(
        (w) =>
          w.entity.toLowerCase().includes(q) ||
          w.desc.toLowerCase().includes(q) ||
          String(w.id).includes(q) ||
          (w.system || "").toLowerCase().includes(q)
      );
    return list;
  }, [workOrders, query, sysFilter]);

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
    if (s === "Closed") patch.flow = "Closed";
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
    entity: "", desc: "", priority: 3, status: "Open", system: "",
    dlPick: { mode: "none", date: "" },
  });
  const createWO = () => {
    if (!form.entity.trim() || !form.desc.trim()) return flash("Category and Description are required.");
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = {
        id,
        entity: form.entity.trim().toUpperCase(),
        level: "L8",
        status: form.status,
        priority: Number(form.priority),
        flow: "Open",
        desc: form.desc.trim(),
        comment: "Add a value",
        checklist: "",
        checklistState: "",
        updatedBy: me,
        updated: Date.now(),
        contacts: [me],
        rootCause: "None Entered",
        preventable: "None Entered",
        assigned: "On-Call Homeowner",
        created: Date.now(),
        createdBy: me,
        deadline: deadlineFromPick(form.dlPick),
        system: form.system || null,
        gameplan: [],
        log: [],
      };
      flash(`Work Order #${id} created.`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders] };
    });
    setForm({ entity: "", desc: "", priority: 3, status: "Open", system: "", dlPick: { mode: "none", date: "" } });
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
        flow: "Open",
        comment: "Add a value",
        checklist: "",
        checklistState: "",
        updatedBy: me,
        updated: Date.now(),
        contacts: [me],
        created: Date.now(),
        createdBy: me,
        gameplan: [],
        log: [],
      };
      flash(`Work Order #${id} created (copy of #${src.id}).`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders] };
    });
  };

  /* Quick Add: distinct categories already in use, most-used first — one tap to template a new WO. */
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
    setForm({ entity: c.entity, desc: "", priority: c.priority, status: "Open", system: c.system, dlPick: { mode: "none", date: "" } });
    setTimeout(() => document.getElementById("descInput")?.focus(), 0);
  };

  const applyBulk = () => {
    const ids = Object.keys(checked).filter((k) => checked[k]).map(Number);
    if (!ids.length) return flash("No workorders selected.");
    mutate((s) => ({
      ...s,
      workOrders: s.workOrders.map((w) =>
        ids.includes(w.id)
          ? { ...w, status: bulkStatus, ...(bulkStatus === "Closed" ? { flow: "Closed" } : {}), updated: Date.now(), updatedBy: me }
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

  const createWOFromPM = (tool, name) => {
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = {
        id, entity: tool, level: "L8", status: "Open", priority: 4, flow: "Open",
        desc: `Execute ${name}`,
        comment: "Generated from OnDeck PM",
        checklist: name, checklistState: "Not Started",
        updatedBy: me, updated: Date.now(), contacts: [me],
        rootCause: "N/A", preventable: "N/A", assigned: "On-Call Homeowner",
        created: Date.now(), createdBy: me,
        deadline: null,
        system: null,
        gameplan: [], log: [],
      };
      flash(`Work Order #${id} created from ${name}.`);
      return { ...s, woSeq: id, workOrders: [...s.workOrders, wo] };
    });
    setGearMenu(null);
  };

  const advancePart = (id) =>
    mutate((s) => ({
      ...s,
      parts: s.parts.map((p) => {
        if (p.id !== id) return p;
        const next = PART_FLOW[Math.min(PART_FLOW.indexOf(p.status) + 1, PART_FLOW.length - 1)];
        return { ...p, status: next, eta: next === "Ordered" || next === "Shipped" ? p.eta || Date.now() + 72 * H : p.eta };
      }),
    }));

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
    flash(`Part request logged for ${tool} (WO #${wo}).`);
  };

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
        <nav className="chromeNav">
          <span className={view.page === "passdown" ? "on" : ""} onClick={() => setView({ page: "passdown" })}>
            Main
          </span>
        </nav>
        <span className="chromeRight">
          <span className="syncChip" onClick={pull} title="Tap to sync now">
            <span className="syncDot" style={{ background: dotColor }} /> {syncLabel}
          </span>
          <u>{me}</u>
          {" | "}
          {fmtToday()}
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
        />
      )}

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
            <span className="ownHint">updates, comments & closures log as: {me}</span>
          </div>

          <DeadlineCalendar
            workOrders={workOrders}
            onOpen={openDetail}
            onRefresh={() => {
              pull();
              flash("Refreshed at " + fmtShort(Date.now()));
            }}
          />

          <div className="pmHeader">
            <span className="pmHeaderTitle">
              {"□  W O R K O R D E R  P R I O R I T I Z A T I O N  -  W O P r"}
            </span>
          </div>
          <div className="pmSub woprSub">
            <button
              className="btnGrad"
              onClick={() => {
                pull();
                flash("Refreshed at " + fmtShort(Date.now()));
              }}
            >
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
              System
              <select value={sysFilter} onChange={(e) => setSysFilter(e.target.value)}>
                <SystemOptions noneLabel="All" />
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
                  Category
                  <input
                    id="entityInput"
                    value={form.entity}
                    placeholder="e.g. HVAC01"
                    autoFocus
                    onChange={(e) => setForm({ ...form, entity: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && createWO()}
                  />
                </label>
                <label>
                  System
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
                      placeholder="CATEGORY"
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
                  const rows = filtered.filter((w) => w.priority === p.id && w.status !== "Closed");
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
                                <b>{w.entity}</b>
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
                                    title="Tag a household system"
                                    onClick={() =>
                                      setRowMenu(
                                        rowMenu?.type === "system" && rowMenu.id === w.id
                                          ? null
                                          : { type: "system", id: w.id }
                                      )
                                    }
                                  >
                                    +SYS
                                  </a>
                                )}
                                {rowMenu?.type === "system" && rowMenu.id === w.id && (
                                  <div className="gearMenu sysMenu">
                                    <b>System:</b>
                                    <select
                                      value={w.system || ""}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setSystemFor(w, e.target.value || null)}
                                    >
                                      <SystemOptions />
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
                            <td className="descCell" onClick={() => openDetail(w.id)}>
                              {w.desc}
                            </td>
                            <td className="commentCell">
                              {w.comment === "Add a value" ? (
                                <a className="addVal" onClick={() => openDetail(w.id)}>
                                  Add a value
                                </a>
                              ) : (
                                w.comment
                              )}
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
                                  <div onClick={() => setDeadlineFor(w, relDays(1))}>
                                    Tomorrow ({fmtDeadline(relDays(1))})
                                  </div>
                                  <div onClick={() => setDeadlineFor(w, relDays(7))}>
                                    Next week ({fmtDeadline(relDays(7))})
                                  </div>
                                  <div onClick={() => setDeadlineFor(w, endOfMonth())}>
                                    End of month ({fmtDeadline(endOfMonth())})
                                  </div>
                                  <div onClick={() => setDeadlineFor(w, endOfYear())}>
                                    End of year ({fmtDeadline(endOfYear())})
                                  </div>
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
            <span className="pmHeaderTitle">
              {"□  O n D e c k  P M s  -  T I M E  B A S E D"}
            </span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="pmSub">
            {"Schedules as of " + fmtDT(Date.now()) + " "}
            <button className="btnGrad" onClick={() => flash("PM schedules refreshed.")}>
              Refresh
            </button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 56 }}>Actions</th>
                  <th style={{ width: 90 }}>Tool {"⇅"}</th>
                  <th>PM Name {"⇅"}</th>
                  <th style={{ width: 120 }}>PM Status {"⇅"}</th>
                  <th style={{ width: 66 }}>Pre PM</th>
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
                              <div onClick={() => createWOFromPM(pm.tool, pm.name)}>{"+ Create Work Order"}</div>
                            </div>
                          )}
                        </td>
                        <td>
                          <b>{pm.tool}</b>
                        </td>
                        <td className="pmName">{pm.name}</td>
                        <td>
                          <PMStatusBadge status={status} />
                        </td>
                        <td>{pm.pre}</td>
                        <td className="numCell hiCol">
                          {overdueIn > 0 ? overdueIn : <span className="neg">{overdueIn}</span>}
                        </td>
                        <td className="numCell">{hrsToDue > 0 ? hrsToDue : ""}</td>
                        <td className="numCell">{fmtDT(pm.due)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {/* ---- OnDeck usage based PMs ---- */}
          <div className="pmHeader">
            <span className="pmHeaderTitle">
              {"□  O n D e c k  U s a g e  B a s e d  P M s"}
            </span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 56 }}>Actions</th>
                  <th style={{ width: 90 }}>Tool {"⇅"}</th>
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
                              <div onClick={() => createWOFromPM(pm.tool, pm.name)}>{"+ Create Work Order"}</div>
                            </div>
                          )}
                        </td>
                        <td>
                          <b>{pm.tool}</b>
                        </td>
                        <td className="pmName">{pm.name}</td>
                        <td>
                          <PMStatusBadge status={status} />
                        </td>
                        <td className="numCell hiCol">
                          {pctOver}% ({pm.count} / {pm.limit} {pm.unit})
                        </td>
                        <td className="numCell">
                          {pctDue}% ({pm.count} / {pm.due} {pm.unit})
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="pmHeader">
            <span className="pmHeaderTitle">
              {"□  P a r t  O r d e r s"}
            </span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              to the top {"▲"}
            </a>
          </div>
          <div className="pmSub">
            {parts.filter((p) => p.status !== "Installed").length}
            {" open part request(s) "}
            <button className="btnGrad" onClick={() => flash("Use 'Order Parts' inside a Work Order to add a request.")}>
              Order Parts
            </button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th>Part {"⇅"}</th>
                  <th style={{ width: 80 }}>For Tool</th>
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
                    <tr key={p.id} className={(i % 2 ? "rowAlt" : "row") + (p.status === "Installed" ? " partDone" : "")}>
                      <td>{p.part}</td>
                      <td>
                        <b>{p.tool}</b>
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
                      <td className="numCell">{p.qty}</td>
                      <td>{p.source}</td>
                      <td>
                        <span className={`partBadge pb${PART_FLOW.indexOf(p.status)}`}>{p.status}</span>
                      </td>
                      <td className="numCell">{p.eta ? fmtDT(p.eta) : "—"}</td>
                      <td>
                        {p.status !== "Installed" ? (
                          <button className="btnGrad btnSm" onClick={() => advancePart(p.id)}>
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

          <div className="pmHeader">
            <span className="pmHeaderTitle">{"□  D a i l y  C h e c k l i s t"}</span>
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
            <a onClick={() => setView({ page: "passdown" })}>{"\u2190"} Passdown</a>
            {"  /  "}
            <b>WOPr - Archive</b>
          </div>
          <div className="pmHeader">
            <span className="pmHeaderTitle">{"\u25a1  W O P r  -  A r c h i v e"}</span>
          </div>
          <div className="pmSub">
            {closedWOs.length}
            {" closed work order(s) "}
            <button
              className="btnGrad"
              onClick={() => {
                pull();
                flash("Refreshed at " + fmtShort(Date.now()));
              }}
            >
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
                        <b>{w.entity}</b>
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
            {"←"} Back to Passdown
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- settings modal ---------- */
function SettingsModal({ cfg, onClose, onSave, onReset }) {
  const [form, setForm] = useState({ userName: cfg.userName || "", sbUrl: cfg.sbUrl || "", sbKey: cfg.sbKey || "" });
  const [test, setTest] = useState("");
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
            placeholder="e.g. C. Kuehn"
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
            onClick={() => onSave({ userName: form.userName.trim() || "Me", sbUrl: form.sbUrl.trim(), sbKey: form.sbKey.trim() })}
          >
            Save
          </button>
          <button className="btnGrad" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btnDanger"
            onClick={() => {
              confirm("Replace local data with the demo seed?") && onReset();
            }}
          >
            Reset demo data
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- work order detail ---------- */
function DetailPage({ wo, me, onBack, onUpdate, onAddPart, onDuplicate, flash }) {
  const [tab, setTab] = useState("Entry Editor");
  const [dtChoice, setDtChoice] = useState("");
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
  const isDown = wo.status === "OOC" || wo.status === "UTP";

  const ribbon = [
    { label: "Edit Details", ic: "✎" },
    { label: "Duplicate", ic: "⧉", act: () => onDuplicate && onDuplicate() },
    { label: "Change Status", ic: "⇄", act: () => setShowStatus((v) => !v) },
    { label: "Set Deadline", ic: "\u{1F4C5}", act: () => setShowDeadline((v) => !v) },
    { label: "Set System", ic: "\u{1F3E0}", act: () => setShowSystem((v) => !v) },
    {
      label: "Close Entry",
      ic: "✔",
      act: () => {
        onUpdate({ status: "Closed", flow: "Closed" });
        flash(`Entry #${wo.id} closed.`);
        onBack();
      },
    },
    { label: "Add Comment", ic: "\u{1F5E8}", act: () => document.getElementById("cmtBox")?.focus() },
    { label: "GamePlan", ic: "\u{1F4CB}" },
    { label: "Order Parts", ic: "\u{1F6D2}", act: () => setShowParts((v) => !v) },
  ];

  const addComment = () => {
    comment.trim() && (onUpdate({ log: [...wo.log, { by: me, ts: Date.now(), text: comment.trim() }] }), setComment(""));
  };

  const toggleGameplan = (idx) => {
    const gp = wo.gameplan.map((g, i) => (i === idx ? { ...g, done: !g.done, by: g.done ? "" : me } : g));
    onUpdate({ gameplan: gp });
  };

  return (
    <div className="page">
      <div className="crumbLine">
        <a onClick={onBack}>{"←"} Passdown</a>
        {"  /  "}
        <b>
          {wo.entity} - Homebase - Edit Work Order #{wo.id}
        </b>
      </div>
      <div className="detailTabs">
        {["Entry Editor"].map((t) => (
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
          {"Change tool status: "}
          <select value={pendStatus} onChange={(e) => setPendStatus(e.target.value)}>
            {Object.keys(STATUS_META).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button
            className="btnGrad"
            onClick={() => {
              const patch = { status: pendStatus };
              if (pendStatus === "Closed") patch.flow = "Closed";
              onUpdate(patch);
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
          {"Set household system: "}
          <select
            value={wo.system || ""}
            onChange={(e) => {
              const code = e.target.value || null;
              onUpdate({ system: code });
              setShowSystem(false);
              flash(code == null ? "System cleared." : `System → ${code}`);
            }}
          >
            <SystemOptions />
          </select>
        </div>
      )}

      {showParts && (
        <div className="statusPicker">
          <b>Order Parts {"→"} Part Orders:</b>
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

      {isDown && !dtChoice && (
        <div className="downtime">
          <div className="dtQ">
            <b>
              {wo.entity} is down ({wo.status}).
            </b>
            <br />
            Would you like to associate this Work Order to the current downtime?
          </div>
          <div className="dtBtns">
            <button
              className="dtYes"
              onClick={() => {
                setDtChoice("yes");
                flash("Associated to current downtime.");
              }}
            >
              {"✔"} Yes {"▾"}
            </button>
            <button onClick={() => setDtChoice("future")}>{"\u{1F550}"} No - Future downtime</button>
            <button className="dtNoReq" onClick={() => setDtChoice("none")}>
              {"✖"} No - Downtime not required
            </button>
          </div>
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
          {"Tool Affected:  "}
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
              <td>System:</td>
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

      <div className="edTitle">Gameplan</div>
      <div className="edBlock">
        <div className="gpHead">Active Items</div>
        {wo.gameplan.filter((g) => !g.done).length === 0 && <div className="muted">No active gameplan items</div>}
        {wo.gameplan.map((g, i) =>
          g.done ? null : (
            <div key={i} className="gpItem">
              {"▪ "}
              {i + 1}
              {") "}
              <input type="checkbox" checked={false} onChange={() => toggleGameplan(i)} />
              {" "}
              {g.text}
            </div>
          )
        )}
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
              <s>{g.text}</s>
              {" "}
              <span className="gpBy">(by {g.by})</span>
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
