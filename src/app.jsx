import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";

/* ============================================================
   HOMEBASE PASSDOWN — PWA edition
   - localStorage persistence
   - optional household sync via a Supabase table (Settings ⚙)
   - last-write-wins, polls every 20s + on app focus
   ============================================================ */

const H = 3600 * 1000;
const LS_STATE = "homebase.state.v1";
const LS_CFG = "homebase.cfg.v1";

function fmt(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} @ ${hh}:${mi}`;
}
function fmtShort(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

const PRIORITIES = [
  { id: 1, label: "Priority 1: EMERGENCY - Safety / Critical Systems", band: "band1" },
  { id: 2, label: "Priority 2: URGENT - This Week", band: "band2" },
  { id: 3, label: "Priority 3: ROUTINE - Standard Home Work", band: "band3" },
  { id: 4, label: "Priority 4: SCHEDULED - Preventive Maintenance", band: "band4" },
  { id: 5, label: "Priority 5: PROJECTS - Improvements", band: "band5" },
];

const STATUS_META = {
  Running: { icon: "▲", cls: "stRun", tip: "System operational" },
  UTP: { icon: "▲", cls: "stUtp", tip: "Unable To Perform — degraded / partially down" },
  OOC: { icon: "▼", cls: "stOoc", tip: "Out Of Commission — fully down" },
  SchQual: { icon: "▼", cls: "stSch", tip: "Awaiting scheduled qualification / inspection" },
  Closed: { icon: "●", cls: "stClosed", tip: "Entry closed" },
};

const PART_FLOW = ["Requested", "Ordered", "Shipped", "Received", "Installed"];

/* ---------------- seed data ---------------- */

function buildSeedState() {
  const NOW = Date.now();
  let woSeq = 6012250;
  const nwo = () => ++woSeq;
  let partSeq = 100;

  const workOrders = [
    {
      id: nwo(), entity: "WH01", zone: "Base", level: "L8", status: "OOC", priority: 1,
      flow: "Waiting Parts",
      desc: "Water heater leaking at T&P relief valve",
      comment: "Supply valve shut off. Replacement valve ordered (SupplyHouse). Household on cold-water protocol.",
      checklist: "TSVWH01LeakResponseADHOC", checklistState: "In Prog",
      updatedBy: "C. Kuehn", updated: NOW - 2 * H, contacts: ["C. Kuehn", "S. Kuehn"],
      rootCause: "Valve seat corrosion (unit age: 9 yrs)",
      preventable: "Add annual T&P valve lift test to PM plan",
      assigned: "On-Call Homeowner", created: NOW - 26 * H, createdBy: "C. Kuehn",
      gameplan: [
        { text: "Shut off cold supply + gas valve", done: true, by: "C. Kuehn" },
        { text: "Drain tank to below valve level", done: true, by: "C. Kuehn" },
        { text: "Install new T&P valve on arrival", done: false, by: "" },
        { text: "Leak check @ operating pressure, restore gas", done: false, by: "" },
      ],
      log: [
        { by: "C. Kuehn", ts: NOW - 26 * H, text: "Found water pooling at drain pan during morning walkthrough." },
        { by: "S. Kuehn", ts: NOW - 20 * H, text: "WorkOrderStatusOption changed to Waiting Parts. User Comment: 'Valve on order'" },
      ],
    },
    {
      id: nwo(), entity: "HVAC01", zone: "Base", level: "L8", status: "UTP", priority: 2,
      flow: "Open",
      desc: "AC not cooling upstairs zone (Zone 2)",
      comment: "Run capacitor suspected — reading 3.1µF on a 5µF spec. Part in garage stock bin B3.",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: NOW - 5 * H, contacts: ["C. Kuehn"],
      rootCause: "None Entered", preventable: "None Entered",
      assigned: "C. Kuehn", created: NOW - 30 * H, createdBy: "C. Kuehn",
      gameplan: [
        { text: "Kill power at disconnect, discharge cap", done: false, by: "" },
        { text: "Swap run capacitor, verify µF", done: false, by: "" },
      ],
      log: [{ by: "C. Kuehn", ts: NOW - 30 * H, text: "Zone 2 blowing warm. Compressor hums, fan slow-start." }],
    },
    {
      id: nwo(), entity: "GDO01", zone: "Gar", level: "L8", status: "UTP", priority: 2,
      flow: "Open",
      desc: "Garage door opener grinding on open cycle",
      comment: "Bundle with rail lube PM if time permits.",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: NOW - 12 * H, contacts: ["S. Kuehn"],
      rootCause: "None Entered", preventable: "None Entered",
      assigned: "On-Call Homeowner", created: NOW - 40 * H, createdBy: "S. Kuehn",
      gameplan: [{ text: "Inspect drive gear + chain tension", done: false, by: "" }],
      log: [],
    },
    {
      id: nwo(), entity: "LAWN01", zone: "Yard", level: "L8", status: "Running", priority: 3,
      flow: "Open",
      desc: "Weekly mow + edge + trim",
      comment: "Add a value",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: NOW - 20 * H, contacts: ["C. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "C. Kuehn", created: NOW - 60 * H, createdBy: "C. Kuehn",
      gameplan: [], log: [],
    },
    {
      id: nwo(), entity: "GUTR01", zone: "Roof", level: "L8", status: "Running", priority: 3,
      flow: "Open",
      desc: "Clear downspout — rear NE corner overflowing",
      comment: "Please follow ladder-safety RFC if working above 6 ft solo.",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: NOW - 8 * H, contacts: ["S. Kuehn"],
      rootCause: "None Entered", preventable: "Install downspout strainer",
      assigned: "On-Call Homeowner", created: NOW - 50 * H, createdBy: "S. Kuehn",
      gameplan: [], log: [],
    },
    {
      id: nwo(), entity: "DW01", zone: "Kitch", level: "L8", status: "Running", priority: 3,
      flow: "On Hold",
      desc: "Dishwasher lower rack wheel replacement",
      comment: "Cosmetic / usability. On hold pending parts order consolidation.",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: NOW - 70 * H, contacts: ["C. Kuehn"],
      rootCause: "Wear item", preventable: "N/A",
      assigned: "C. Kuehn", created: NOW - 100 * H, createdBy: "C. Kuehn",
      gameplan: [], log: [],
    },
    {
      id: nwo(), entity: "HVAC01", zone: "Base", level: "L8", status: "Running", priority: 4,
      flow: "Data Due",
      desc: "Monthly filter change (MERV 13) — both returns",
      comment: "Bundle into consumable/weekly PMs as they come due, and as time permits.",
      checklist: "TSVHVACFilterPM", checklistState: "Not Started",
      updatedBy: "C. Kuehn", updated: NOW - 15 * H, contacts: ["C. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "C. Kuehn", created: NOW - 45 * H, createdBy: "C. Kuehn",
      gameplan: [], log: [],
    },
    {
      id: nwo(), entity: "SMK01", zone: "Base", level: "L8", status: "Running", priority: 4,
      flow: "Open",
      desc: "Smoke / CO detector test + battery rotation (all 6 units)",
      comment: "Hallway unit chirped once — replace that battery first.",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: NOW - 30 * H, contacts: ["S. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "On-Call Homeowner", created: NOW - 80 * H, createdBy: "S. Kuehn",
      gameplan: [], log: [],
    },
    {
      id: nwo(), entity: "DECK01", zone: "Yard", level: "L5", status: "SchQual", priority: 5,
      flow: "Waiting Wx",
      desc: "Deck sand + re-stain project (SS + TTV)",
      comment: "Needs 3 consecutive dry days. Keep this open, to be used upon weather window.",
      checklist: "", checklistState: "",
      updatedBy: "C. Kuehn", updated: NOW - 90 * H, contacts: ["C. Kuehn", "S. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "C. Kuehn", created: NOW - 200 * H, createdBy: "C. Kuehn",
      gameplan: [
        { text: "Pressure wash + 48h dry", done: false, by: "" },
        { text: "Sand rails + treads", done: false, by: "" },
        { text: "Stain coat 1 + 2", done: false, by: "" },
      ],
      log: [],
    },
    {
      id: nwo(), entity: "PAINT01", zone: "Base", level: "L6", status: "Running", priority: 5,
      flow: "Open",
      desc: "Hallway scuff touch-up (SW Agreeable Gray)",
      comment: "Add a value",
      checklist: "", checklistState: "",
      updatedBy: "S. Kuehn", updated: NOW - 110 * H, contacts: ["S. Kuehn"],
      rootCause: "N/A", preventable: "N/A",
      assigned: "S. Kuehn", created: NOW - 150 * H, createdBy: "S. Kuehn",
      gameplan: [], log: [],
    },
  ];

  const timePMs = [
    { id: 1, tool: "LAWN01", name: "TSVLawnMowWeeklyPM", pre: "Yes", due: NOW - 7 * H, freqH: 168 },
    { id: 2, tool: "HVAC01", name: "TSVHVACFilterMonthlyPM", pre: "Yes", due: NOW - 26 * H, freqH: 720 },
    { id: 3, tool: "WH01", name: "TSVWaterHeaterFlushAnnualPM", pre: "", due: NOW - 614 * H, freqH: 8760 },
    { id: 4, tool: "SMK01", name: "TSVSmokeDetectorTestPM", pre: "Yes", due: NOW + 59 * H, freqH: 4380 },
    { id: 5, tool: "GUTR01", name: "TSVGutterCleanQuarterlyPM", pre: "", due: NOW + 98 * H, freqH: 2190 },
    { id: 6, tool: "GDO01", name: "TSVGarageRailLubePM", pre: "", due: NOW + 170 * H, freqH: 4380 },
    { id: 7, tool: "DRYER01", name: "TSVDryerVentCleanPM", pre: "Yes", due: NOW - 311 * H, freqH: 8760 },
  ];

  const usagePMs = [
    { id: 1, tool: "CAR01", name: "TSVCarOilChangePM", count: 4712, limit: 5000, due: 4500, unit: "mi" },
    { id: 2, tool: "HVAC01", name: "TSVBlowerRuntimePM", count: 582, limit: 600, due: 540, unit: "hrs" },
    { id: 3, tool: "MWR01", name: "TSVMowerBladeSharpenPM", count: 38.5, limit: 50, due: 45, unit: "hrs" },
    { id: 4, tool: "FRG01", name: "TSVFridgeWaterFilterPM", count: 5.2, limit: 6, due: 5.5, unit: "mo" },
  ];

  const parts = [
    { id: ++partSeq, part: 'T&P relief valve 3/4" (Watts 100XL)', tool: "WH01", wo: 6012251, qty: 1, source: "SupplyHouse", status: "Shipped", eta: NOW + 46 * H, expedite: true },
    { id: ++partSeq, part: "Run capacitor 5µF 370V", tool: "HVAC01", wo: 6012252, qty: 1, source: "Stock bin B3", status: "Received", eta: null, expedite: false },
    { id: ++partSeq, part: "MERV 13 filter 20x25x1 (2-pk)", tool: "HVAC01", wo: null, qty: 2, source: "Amazon", status: "Ordered", eta: NOW + 96 * H, expedite: false },
    { id: ++partSeq, part: "Dishwasher lower rack wheel kit", tool: "DW01", wo: 6012256, qty: 1, source: "RepairClinic", status: "Requested", eta: null, expedite: false },
    { id: ++partSeq, part: "9V lithium batteries (6-pk)", tool: "SMK01", wo: null, qty: 1, source: "Costco", status: "Received", eta: null, expedite: false },
  ];

  return {
    workOrders, timePMs, usagePMs, parts,
    dailyText:
      "• Water OFF to WH01 — do not restore until valve replaced\n• Trash + recycling out Thursday night\n• Zone 2 AC warm — fans running upstairs overnight\n• Check mail hold status before trip",
    dailyBy: "C. Kuehn", dailyAt: NOW - 4 * H,
    woSeq, partSeq,
    lastModified: NOW,
  };
}

/* ---------------- local persistence ---------------- */

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch { return {}; }
}
function persistCfg(c) {
  try { localStorage.setItem(LS_CFG, JSON.stringify(c)); } catch {}
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_STATE));
    if (s && s.workOrders) return s;
  } catch {}
  const seed = buildSeedState();
  try { localStorage.setItem(LS_STATE, JSON.stringify(seed)); } catch {}
  return seed;
}
function persistState(s) {
  try { localStorage.setItem(LS_STATE, JSON.stringify(s)); } catch {}
}

/* ---------------- Supabase REST (no SDK needed) ---------------- */

function sbHeaders(cfg) {
  return {
    apikey: cfg.sbKey,
    Authorization: `Bearer ${cfg.sbKey}`,
    "Content-Type": "application/json",
  };
}
function sbUrl(cfg) {
  return cfg.sbUrl.replace(/\/+$/, "") + "/rest/v1/homebase_state";
}
async function remoteGet(cfg) {
  const r = await fetch(sbUrl(cfg) + "?id=eq.1&select=data,updated_at", { headers: sbHeaders(cfg) });
  if (!r.ok) throw new Error(`GET ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return rows[0] || null;
}
async function remotePut(cfg, state) {
  const body = JSON.stringify([{ id: 1, data: state, updated_at: new Date(state.lastModified).toISOString() }]);
  const r = await fetch(sbUrl(cfg), {
    method: "POST",
    headers: { ...sbHeaders(cfg), Prefer: "resolution=merge-duplicates" },
    body,
  });
  if (!r.ok) throw new Error(`PUT ${r.status}: ${await r.text()}`);
}

/* ---------------- small pieces ---------------- */

function StatusCell({ level, status }) {
  const m = STATUS_META[status] || STATUS_META.Running;
  return (
    <span className="statusCell" title={m.tip}>
      <span className={`stIcon ${m.cls}`}>{m.icon}</span>
      <b>{level}</b>&nbsp;{status}
    </span>
  );
}

function PMStatusBadge({ status }) {
  const cls = status === "DUE" ? "pmDue" : status === "OVERDUE" ? "pmOver" : "pmOpp";
  return <span className={`pmBadge ${cls}`}>{status}</span>;
}

/* ---------------- main app ---------------- */

function HomebasePassdown() {
  const [cfg, setCfg] = useState(loadCfg);
  const [state, setStateRaw] = useState(loadState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const me = cfg.userName || "Me";

  const [view, setView] = useState({ page: "passdown" });
  const [collapsed, setCollapsed] = useState({});
  const [showCreate, setShowCreate] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [checked, setChecked] = useState({});
  const [bulkStatus, setBulkStatus] = useState("Running");
  const [search, setSearch] = useState("");
  const [editDaily, setEditDaily] = useState(false);
  const [pmMenu, setPmMenu] = useState(null);
  const [toast, setToast] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [sync, setSync] = useState({ s: cfg.sbUrl && cfg.sbKey ? "syncing" : "local", at: null });

  const pushTimer = useRef(null);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  };

  /* ----- mutation + persistence + debounced push ----- */
  const mutate = useCallback((fn) => {
    setStateRaw((prev) => {
      const next = { ...fn(prev), lastModified: Date.now() };
      persistState(next);
      const c = cfgRef.current;
      if (c.sbUrl && c.sbKey) {
        if (pushTimer.current) clearTimeout(pushTimer.current);
        pushTimer.current = setTimeout(async () => {
          try {
            setSync((x) => ({ ...x, s: "syncing" }));
            await remotePut(cfgRef.current, stateRef.current);
            setSync({ s: "synced", at: Date.now() });
          } catch {
            setSync({ s: "offline", at: Date.now() });
          }
        }, 800);
      }
      return next;
    });
  }, []);

  /* ----- pull loop ----- */
  const pull = useCallback(async () => {
    const c = cfgRef.current;
    if (!c.sbUrl || !c.sbKey) { setSync({ s: "local", at: null }); return; }
    try {
      setSync((x) => ({ ...x, s: "syncing" }));
      const row = await remoteGet(c);
      const localTs = stateRef.current.lastModified || 0;
      if (!row) {
        await remotePut(c, stateRef.current);
      } else {
        const remoteTs = new Date(row.updated_at).getTime();
        if (remoteTs > localTs + 500 && row.data && row.data.workOrders) {
          const adopted = { ...row.data, lastModified: remoteTs };
          persistState(adopted);
          setStateRaw(adopted);
        } else if (localTs > remoteTs + 500) {
          await remotePut(c, stateRef.current);
        }
      }
      setSync({ s: "synced", at: Date.now() });
    } catch {
      setSync({ s: "offline", at: Date.now() });
    }
  }, []);

  useEffect(() => {
    pull();
    const iv = setInterval(pull, 20000);
    const onVis = () => { if (document.visibilityState === "visible") pull(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [pull]);

  /* ----- derived ----- */
  const { workOrders, timePMs, usagePMs, parts, dailyText } = state;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return workOrders;
    return workOrders.filter(
      (w) => w.entity.toLowerCase().includes(q) || w.desc.toLowerCase().includes(q) || String(w.id).includes(q)
    );
  }, [workOrders, search]);

  const updateWO = (id, patch) =>
    mutate((s) => ({
      ...s,
      workOrders: s.workOrders.map((w) => (w.id === id ? { ...w, ...patch, updated: Date.now(), updatedBy: me } : w)),
    }));

  const openDetail = (id) => setView({ page: "detail", id });
  const current = view.page === "detail" ? workOrders.find((w) => w.id === view.id) : null;

  /* ----- create form ----- */
  const [form, setForm] = useState({ entity: "", zone: "Base", desc: "", priority: 3, status: "Running" });
  const submitCreate = () => {
    if (!form.entity.trim() || !form.desc.trim()) return flash("Entity and Description are required.");
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = {
        id, entity: form.entity.trim().toUpperCase(), zone: form.zone, level: "L8", status: form.status,
        priority: Number(form.priority), flow: "Open", desc: form.desc.trim(), comment: "Add a value",
        checklist: "", checklistState: "", updatedBy: me, updated: Date.now(), contacts: [me],
        rootCause: "None Entered", preventable: "None Entered", assigned: "On-Call Homeowner",
        created: Date.now(), createdBy: me, gameplan: [], log: [],
      };
      flash(`Work Order #${id} created.`);
      return { ...s, woSeq: id, workOrders: [wo, ...s.workOrders] };
    });
    setForm({ entity: "", zone: "Base", desc: "", priority: 3, status: "Running" });
    setShowCreate(false);
  };

  const applyBulk = () => {
    const ids = Object.keys(checked).filter((k) => checked[k]).map(Number);
    if (!ids.length) return flash("No workorders selected.");
    mutate((s) => ({
      ...s,
      workOrders: s.workOrders.map((w) =>
        ids.includes(w.id) ? { ...w, status: bulkStatus, updated: Date.now(), updatedBy: me } : w
      ),
    }));
    setChecked({});
    flash(`Updated ${ids.length} workorder(s) → ${bulkStatus}.`);
  };

  /* ----- PM actions ----- */
  const completeTimePM = (pm) => {
    const nextDue = Date.now() + pm.freqH * H;
    mutate((s) => ({ ...s, timePMs: s.timePMs.map((p) => (p.id === pm.id ? { ...p, due: nextDue } : p)) }));
    setPmMenu(null);
    flash(`${pm.name} marked complete — next due ${fmt(nextDue)}.`);
  };
  const completeUsagePM = (pm) => {
    mutate((s) => ({ ...s, usagePMs: s.usagePMs.map((p) => (p.id === pm.id ? { ...p, count: 0 } : p)) }));
    setPmMenu(null);
    flash(`${pm.name} counter reset to 0 ${pm.unit}.`);
  };
  const pmToWO = (tool, name) => {
    mutate((s) => {
      const id = s.woSeq + 1;
      const wo = {
        id, entity: tool, zone: "Base", level: "L8", status: "Running", priority: 4, flow: "Open",
        desc: `Execute ${name}`, comment: "Generated from OnDeck PM", checklist: name, checklistState: "Not Started",
        updatedBy: me, updated: Date.now(), contacts: [me], rootCause: "N/A", preventable: "N/A",
        assigned: "On-Call Homeowner", created: Date.now(), createdBy: me, gameplan: [], log: [],
      };
      flash(`Work Order #${id} created from ${name}.`);
      return { ...s, woSeq: id, workOrders: [...s.workOrders, wo] };
    });
    setPmMenu(null);
  };

  /* ----- parts actions ----- */
  const advancePart = (id) =>
    mutate((s) => ({
      ...s,
      parts: s.parts.map((p) => {
        if (p.id !== id) return p;
        const next = PART_FLOW[Math.min(PART_FLOW.indexOf(p.status) + 1, PART_FLOW.length - 1)];
        return { ...p, status: next, eta: next === "Ordered" || next === "Shipped" ? p.eta || Date.now() + 72 * H : p.eta };
      }),
    }));
  const toggleExpedite = (id) =>
    mutate((s) => ({ ...s, parts: s.parts.map((p) => (p.id === id ? { ...p, expedite: !p.expedite } : p)) }));
  const addPart = (woId, tool, f) => {
    mutate((s) => ({
      ...s,
      partSeq: s.partSeq + 1,
      parts: [
        ...s.parts,
        { id: s.partSeq + 1, part: f.name, tool, wo: woId, qty: Number(f.qty) || 1, source: f.source || "TBD", status: "Requested", eta: null, expedite: false },
      ],
    }));
    flash(`Part request logged for ${tool} (WO #${woId}).`);
  };

  const syncDot = { local: "#8a99a8", syncing: "#e8b90c", synced: "#2fa14a", offline: "#c0271a" }[sync.s];
  const syncLabel =
    sync.s === "local" ? "Local only" :
    sync.s === "syncing" ? "Syncing…" :
    sync.s === "synced" ? `Synced ${sync.at ? fmtClock(sync.at) : ""}` :
    "Offline — saved locally";

  return (
    <div className="app">
      {/* ---- top chrome ---- */}
      <div className="chrome">
        <span className="chromeBrand">◉ HOMEBASE</span>
        <nav className="chromeNav">
          <span className={view.page === "passdown" ? "on" : ""} onClick={() => setView({ page: "passdown" })}>Main</span>
        </nav>
        <span className="chromeRight">
          <span className="syncChip" onClick={pull} title="Tap to sync now">
            <span className="syncDot" style={{ background: syncDot }} /> {syncLabel}
          </span>
          <u>{me}</u>&nbsp;|&nbsp;{todayStr()}
          <span className="gearTop" onClick={() => setShowSettings(true)} title="Settings">⚙</span>
        </span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {showSettings && (
        <SettingsModal
          cfg={cfg}
          onClose={() => setShowSettings(false)}
          onSave={(c) => { setCfg(c); persistCfg(c); setShowSettings(false); flash("Settings saved."); setTimeout(pull, 100); }}
          onReset={() => {
            const seed = buildSeedState();
            persistState(seed);
            setStateRaw(seed);
            setShowSettings(false);
            flash("Local data reset to demo seed.");
          }}
        />
      )}

      {view.page === "passdown" && (
        <div className="page">
          <div className="ownerLine">
            Showing Tools in Tool Group: <b>Shared-HOME Systems</b>&nbsp; Owners/Backup:&nbsp;
            <a>C. Kuehn</a>&nbsp;<a>S. Kuehn</a>&nbsp;&nbsp;Contact the owner(s) to Add/Remove Tools.
          </div>

          <div className="controls">
            <button className="btnGrad" onClick={() => { pull(); flash("Refreshed at " + fmtShort(Date.now())); }}>Refresh</button>
            <label className="chk">
              <input type="checkbox" checked={showCreate} onChange={(e) => setShowCreate(e.target.checked)} />
              Create New Workorder
            </label>
            <label className="chk">
              <input type="checkbox" checked={bulkMode} onChange={(e) => setBulkMode(e.target.checked)} />
              Bulk Update
            </label>
            {bulkMode && (
              <span className="bulkBar">
                Set selected to&nbsp;
                <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                  {Object.keys(STATUS_META).map((s) => <option key={s}>{s}</option>)}
                </select>
                <button className="btnGrad" onClick={applyBulk}>Apply</button>
              </span>
            )}
          </div>

          {showCreate && (
            <div className="createForm">
              <b>New Work Order</b>
              <div className="createGrid">
                <label>Entity
                  <input value={form.entity} placeholder="e.g. HVAC01" onChange={(e) => setForm({ ...form, entity: e.target.value })} />
                </label>
                <label>Zone
                  <select value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })}>
                    <option>Base</option><option>Kitch</option><option>Yard</option><option>Gar</option><option>Roof</option>
                  </select>
                </label>
                <label>Priority
                  <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                  </select>
                </label>
                <label>Status
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option>Running</option><option>UTP</option><option>OOC</option><option>SchQual</option>
                  </select>
                </label>
                <label className="wide">Description
                  <input value={form.desc} placeholder="What needs doing?" onChange={(e) => setForm({ ...form, desc: e.target.value })} />
                </label>
              </div>
              <button className="btnGrad" onClick={submitCreate}>Create</button>
              <button className="btnGrad" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          )}

          {/* ---- prioritized workorders ---- */}
          <div className="sectionTitle">Prioritized Workorders</div>
          <div className="tableWrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="thSearch">
                    <span className="mag">⌕</span>
                    <input className="searchBox" value={search} placeholder="ENTITY" onChange={(e) => setSearch(e.target.value)} />
                  </th>
                  <th style={{ width: 120 }}>STATUS ▾</th>
                  <th>DESCRIPTION</th>
                  <th>COMMENT</th>
                  <th style={{ width: 170 }}>CHECKLISTS</th>
                  <th style={{ width: 110 }}>LAST UPDATED ▾</th>
                  <th style={{ width: 96 }}>CONTACTS</th>
                </tr>
              </thead>
              <tbody>
                {PRIORITIES.map((p) => {
                  const rows = filtered.filter((w) => w.priority === p.id && w.status !== "Closed");
                  const isCollapsed = collapsed[p.id];
                  return (
                    <React.Fragment key={p.id}>
                      <tr className={`band ${p.band}`} onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
                        <td colSpan={7}>
                          <span className="bandToggle">{isCollapsed ? "+" : "−"}</span> {p.label}
                          <span className="bandCount">{rows.length ? ` (${rows.length})` : " (0)"}</span>
                        </td>
                      </tr>
                      {!isCollapsed && rows.map((w, i) => (
                        <tr key={w.id} className={i % 2 ? "rowAlt" : "row"}>
                          <td className="entityCell">
                            <div className="entityTop">
                              <input
                                type="checkbox"
                                checked={!!checked[w.id]}
                                onChange={(e) => setChecked((c) => ({ ...c, [w.id]: e.target.checked }))}
                              />
                              <span className="rank">{i + 1}</span>
                              <b>{w.entity}</b>
                              <span className="d1h">D1H</span>
                              <a className="woLink" onClick={() => openDetail(w.id)}>{w.id}</a>
                            </div>
                            <div className="entitySub">
                              <span className="zone">{w.zone}</span>
                              <StatusCell level={w.level} status={w.status} />
                            </div>
                          </td>
                          <td className="flowCell"><a onClick={() => openDetail(w.id)}>{w.flow}</a></td>
                          <td className="descCell" onClick={() => openDetail(w.id)}>{w.desc}</td>
                          <td className="commentCell">
                            {w.comment === "Add a value" ? <a className="addVal" onClick={() => openDetail(w.id)}>Add a value</a> : w.comment}
                          </td>
                          <td className="chkCell">
                            {w.checklist ? (
                              <>
                                <a className="woLink">{w.checklist}</a>
                                <div className="chkState">{w.checklistState}</div>
                              </>
                            ) : ""}
                          </td>
                          <td className="updCell">
                            <a>{w.updatedBy}</a>
                            <div className="updTime">{fmtShort(w.updated)}</div>
                          </td>
                          <td className="ctCell">
                            {w.contacts.map((c) => <div key={c}><a>{c}</a></div>)}
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
            <span className="pmHeaderTitle">□&nbsp;&nbsp;O n D e c k&nbsp;&nbsp;P M s&nbsp;&nbsp;-&nbsp;&nbsp;T I M E&nbsp;&nbsp;B A S E D</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>to the top ▲</a>
          </div>
          <div className="pmSub">
            Schedules as of {fmt(Date.now())}&nbsp;
            <button className="btnGrad" onClick={() => flash("PM schedules refreshed.")}>Refresh</button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 56 }}>Actions</th>
                  <th style={{ width: 90 }}>Tool ⇅</th>
                  <th>PM Name ⇅</th>
                  <th style={{ width: 120 }}>PM Status ⇅</th>
                  <th style={{ width: 66 }}>Pre PM</th>
                  <th style={{ width: 120 }} className="thHi">Hours Until Overdue ↓</th>
                  <th style={{ width: 100 }}>Hours Until Due</th>
                  <th style={{ width: 110 }}>Due Date ⇅</th>
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
                          <span className="gear" onClick={() => setPmMenu(pmMenu?.type === "t" && pmMenu.id === pm.id ? null : { type: "t", id: pm.id })}>⚙</span>
                          {pmMenu?.type === "t" && pmMenu.id === pm.id && (
                            <div className="gearMenu">
                              <div onClick={() => completeTimePM(pm)}>✓ Mark PM complete</div>
                              <div onClick={() => pmToWO(pm.tool, pm.name)}>+ Create Work Order</div>
                            </div>
                          )}
                        </td>
                        <td><b>{pm.tool}</b></td>
                        <td className="pmName">{pm.name}</td>
                        <td><PMStatusBadge status={status} /></td>
                        <td>{pm.pre}</td>
                        <td className="numCell hiCol">{overdueIn > 0 ? overdueIn : <span className="neg">{overdueIn}</span>}</td>
                        <td className="numCell">{hrsToDue > 0 ? hrsToDue : ""}</td>
                        <td className="numCell">{fmt(pm.due)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {/* ---- OnDeck usage based PMs ---- */}
          <div className="pmHeader">
            <span className="pmHeaderTitle">□&nbsp;&nbsp;O n D e c k&nbsp;&nbsp;U s a g e&nbsp;&nbsp;B a s e d&nbsp;&nbsp;P M s</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>to the top ▲</a>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th style={{ width: 56 }}>Actions</th>
                  <th style={{ width: 90 }}>Tool ⇅</th>
                  <th>PM Name ⇅</th>
                  <th style={{ width: 120 }}>PM Status ⇅</th>
                  <th style={{ width: 170 }} className="thHi">Count Until Overdue ↓</th>
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
                          <span className="gear" onClick={() => setPmMenu(pmMenu?.type === "u" && pmMenu.id === pm.id ? null : { type: "u", id: pm.id })}>⚙</span>
                          {pmMenu?.type === "u" && pmMenu.id === pm.id && (
                            <div className="gearMenu">
                              <div onClick={() => completeUsagePM(pm)}>✓ Complete + reset counter</div>
                              <div onClick={() => pmToWO(pm.tool, pm.name)}>+ Create Work Order</div>
                            </div>
                          )}
                        </td>
                        <td><b>{pm.tool}</b></td>
                        <td className="pmName">{pm.name}</td>
                        <td><PMStatusBadge status={status} /></td>
                        <td className="numCell hiCol">{pctOver}% ({pm.count} / {pm.limit} {pm.unit})</td>
                        <td className="numCell">{pctDue}% ({pm.count} / {pm.due} {pm.unit})</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {/* ---- parts / shopping list ---- */}
          <div className="pmHeader">
            <span className="pmHeaderTitle">□&nbsp;&nbsp;W I I N G S&nbsp;&nbsp;P a r t s&nbsp;&nbsp;-&nbsp;&nbsp;H o m e&nbsp;&nbsp;S t o c k&nbsp;&nbsp;&amp;&nbsp;&nbsp;O r d e r s</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>to the top ▲</a>
          </div>
          <div className="pmSub">
            {parts.filter((p) => p.status !== "Installed").length} open part request(s)&nbsp;
            <button className="btnGrad" onClick={() => flash("Use 'Order Parts' inside a Work Order to add a request.")}>Order Parts</button>
            <button className="btnGrad" onClick={() => flash(parts.some((p) => p.expedite) ? "Expedited: " + parts.filter((p) => p.expedite).map((p) => p.part).join("; ") : "No expedited parts.")}>Track Expedites</button>
          </div>
          <div className="tableWrap">
            <table className="grid pmGrid">
              <thead>
                <tr className="pmHead">
                  <th>Part ⇅</th>
                  <th style={{ width: 80 }}>For Tool</th>
                  <th style={{ width: 80 }}>WO #</th>
                  <th style={{ width: 44 }}>Qty</th>
                  <th style={{ width: 110 }}>Source</th>
                  <th style={{ width: 100 }}>Status ⇅</th>
                  <th style={{ width: 100 }}>ETA</th>
                  <th style={{ width: 74 }}>Expedite</th>
                  <th style={{ width: 120 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...parts]
                  .sort((a, b) => PART_FLOW.indexOf(a.status) - PART_FLOW.indexOf(b.status))
                  .map((p, i) => (
                    <tr key={p.id} className={(i % 2 ? "rowAlt" : "row") + (p.status === "Installed" ? " partDone" : "")}>
                      <td>{p.expedite && <span className="expFlag">EXPEDITE</span>}{p.part}</td>
                      <td><b>{p.tool}</b></td>
                      <td>{p.wo ? <a className="woLink" onClick={() => workOrders.some((w) => w.id === p.wo) && openDetail(p.wo)}>{p.wo}</a> : "—"}</td>
                      <td className="numCell">{p.qty}</td>
                      <td>{p.source}</td>
                      <td><span className={`partBadge pb${PART_FLOW.indexOf(p.status)}`}>{p.status}</span></td>
                      <td className="numCell">{p.eta ? fmt(p.eta) : "—"}</td>
                      <td style={{ textAlign: "center" }}>
                        <input type="checkbox" checked={p.expedite} onChange={() => toggleExpedite(p.id)} />
                      </td>
                      <td>
                        {p.status !== "Installed" ? (
                          <button className="btnGrad btnSm" onClick={() => advancePart(p.id)}>
                            ▶ {PART_FLOW[PART_FLOW.indexOf(p.status) + 1]}
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

          {/* ---- daily checklist ---- */}
          <div className="pmHeader">
            <span className="pmHeaderTitle">□&nbsp;&nbsp;D a i l y&nbsp;&nbsp;C h e c k l i s t</span>
            <a className="toTop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>to the top ▲</a>
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
                Last Updated By: {state.dailyBy} [ {fmt(state.dailyAt)} ]
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ============ DETAIL VIEW ============ */}
      {view.page === "detail" && current && (
        <DetailView
          wo={current}
          me={me}
          onBack={() => setView({ page: "passdown" })}
          onUpdate={(patch) => updateWO(current.id, patch)}
          onAddPart={(f) => addPart(current.id, current.entity, f)}
          flash={flash}
        />
      )}
      {view.page === "detail" && !current && (
        <div className="page">
          <div className="muted">Work order not found (may have been removed on another device).</div>
          <button className="btnGrad" onClick={() => setView({ page: "passdown" })}>← Back to Passdown</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- settings ---------------- */

function SettingsModal({ cfg, onClose, onSave, onReset }) {
  const [f, setF] = useState({ userName: cfg.userName || "", sbUrl: cfg.sbUrl || "", sbKey: cfg.sbKey || "" });
  const [test, setTest] = useState("");

  const runTest = async () => {
    if (!f.sbUrl || !f.sbKey) return setTest("Enter URL and key first.");
    setTest("Testing…");
    try {
      await remoteGet({ sbUrl: f.sbUrl, sbKey: f.sbKey });
      setTest("✓ Connected — table reachable.");
    } catch (e) {
      setTest("✗ " + String(e.message || e).slice(0, 160) + " (Did you run the setup SQL? See README.)");
    }
  };

  return (
    <div className="modalWrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalTitle">Settings</div>
        <label className="modalField">Display name (shows on your updates)
          <input value={f.userName} placeholder="e.g. C. Kuehn" onChange={(e) => setF({ ...f, userName: e.target.value })} />
        </label>
        <div className="modalSection">Household sync (Supabase — optional)</div>
        <label className="modalField">Project URL
          <input value={f.sbUrl} placeholder="https://xxxx.supabase.co" onChange={(e) => setF({ ...f, sbUrl: e.target.value })} />
        </label>
        <label className="modalField">Anon (public) API key
          <input value={f.sbKey} placeholder="eyJ…" onChange={(e) => setF({ ...f, sbKey: e.target.value })} />
        </label>
        <div className="modalHint">
          One-time setup lives in the README: create a free Supabase project, run the setup SQL, then paste the same
          URL + key on every phone. Leave blank to run local-only.
        </div>
        {test && <div className="modalTest">{test}</div>}
        <div className="modalBtns">
          <button className="btnGrad" onClick={runTest}>Test connection</button>
          <button className="btnGrad" onClick={() => onSave({ userName: f.userName.trim() || "Me", sbUrl: f.sbUrl.trim(), sbKey: f.sbKey.trim() })}>Save</button>
          <button className="btnGrad" onClick={onClose}>Cancel</button>
          <button className="btnDanger" onClick={() => { if (confirm("Replace local data with the demo seed?")) onReset(); }}>Reset demo data</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- detail view ---------------- */

function DetailView({ wo, me, onBack, onUpdate, onAddPart, flash }) {
  const [tab, setTab] = useState("Entry Editor");
  const [downtimeAns, setDowntimeAns] = useState("");
  const [newComment, setNewComment] = useState("");
  const [statusPick, setStatusPick] = useState(wo.status);
  const [showStatus, setShowStatus] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [partForm, setPartForm] = useState({ name: "", qty: 1, source: "" });

  const isDown = wo.status === "OOC" || wo.status === "UTP";

  const ribbon = [
    { label: "Edit Details", ic: "✎" },
    { label: "Change Status", ic: "⇄", act: () => setShowStatus((s) => !s) },
    { label: "Close Entry", ic: "✔", act: () => { onUpdate({ status: "Closed", flow: "Closed" }); flash(`Entry #${wo.id} closed.`); onBack(); } },
    { label: "Add Comment", ic: "🗨", act: () => document.getElementById("cmtBox")?.focus() },
    { label: "Contacts", ic: "👥" },
    { label: "GamePlan", ic: "📋" },
    { label: "Order Parts", ic: "🛒", act: () => setShowParts((s) => !s) },
  ];

  const addComment = () => {
    if (!newComment.trim()) return;
    onUpdate({ log: [...wo.log, { by: me, ts: Date.now(), text: newComment.trim() }] });
    setNewComment("");
  };

  const toggleGP = (idx) => {
    const gp = wo.gameplan.map((g, i) => (i === idx ? { ...g, done: !g.done, by: !g.done ? me : "" } : g));
    onUpdate({ gameplan: gp });
  };

  return (
    <div className="page">
      <div className="crumbLine">
        <a onClick={onBack}>← Passdown</a>&nbsp;&nbsp;/&nbsp;&nbsp;
        <b>{wo.entity} - D1H Homebase - Edit Work Order #{wo.id}</b>
      </div>

      <div className="detailTabs">
        {["Entry Editor", "FYIs", "Communication", "Reference"].map((t) => (
          <span key={t} className={tab === t ? "dtOn" : ""} onClick={() => setTab(t)}>{t}</span>
        ))}
      </div>

      <div className="ribbon">
        {ribbon.map((r) => (
          <div key={r.label} className="ribBtn" onClick={r.act || (() => flash(`${r.label}: coming in a later rev.`))}>
            <div className="ribIc">{r.ic}</div>
            <div className="ribLb">{r.label}</div>
          </div>
        ))}
      </div>

      {showStatus && (
        <div className="statusPicker">
          Change tool status:&nbsp;
          <select value={statusPick} onChange={(e) => setStatusPick(e.target.value)}>
            {Object.keys(STATUS_META).filter((s) => s !== "Closed").map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btnGrad" onClick={() => { onUpdate({ status: statusPick }); setShowStatus(false); flash(`Status → ${statusPick}`); }}>
            Apply
          </button>
        </div>
      )}

      {showParts && (
        <div className="statusPicker">
          <b>Order Parts → WIINGS:</b>
          <input className="partInput" value={partForm.name} placeholder="Part description" onChange={(e) => setPartForm({ ...partForm, name: e.target.value })} />
          Qty
          <input className="partQty" type="number" min="1" value={partForm.qty} onChange={(e) => setPartForm({ ...partForm, qty: e.target.value })} />
          <input className="partSrc" value={partForm.source} placeholder="Source (Amazon, Home Depot…)" onChange={(e) => setPartForm({ ...partForm, source: e.target.value })} />
          <button
            className="btnGrad"
            onClick={() => {
              if (!partForm.name.trim()) return flash("Part description required.");
              onAddPart({ name: partForm.name.trim(), qty: partForm.qty, source: partForm.source.trim() });
              setPartForm({ name: "", qty: 1, source: "" });
              setShowParts(false);
            }}
          >
            Submit Request
          </button>
        </div>
      )}

      {isDown && !downtimeAns && (
        <div className="downtime">
          <div className="dtQ">
            <b>{wo.entity} is down ({wo.status}).</b><br />
            Would you like to associate this Work Order to the current downtime?
          </div>
          <div className="dtBtns">
            <button className="dtYes" onClick={() => { setDowntimeAns("yes"); flash("Associated to current downtime."); }}>✔ Yes ▾</button>
            <button onClick={() => setDowntimeAns("future")}>🕐 No - Future downtime</button>
            <button className="dtNoReq" onClick={() => setDowntimeAns("none")}>✖ No - Downtime not required</button>
          </div>
        </div>
      )}

      {wo.checklist && (
        <div className="fyiBar">
          <span className="fyiTag">• FYI</span>
          <b>Completed PMs in Executed Order:</b>&nbsp;
          <a className="woLink">{wo.checklist} for {wo.entity}</a>&nbsp;
          <span className="fyiMeta">{wo.checklistState === "Done" ? `Completed on ${fmtShort(wo.updated)}` : `Status: ${wo.checklistState || "Not Started"}`}</span>
        </div>
      )}

      <div className="edTitle">Entry Details for Work Order # {wo.id}</div>
      <div className="edBlock">
        <div className="edTool">Tool Affected:&nbsp; <b>{wo.entity}</b> <span className="stIcon stUtp">▲</span></div>
        <table className="kvTable"><tbody>
          <tr><td>Description:</td><td>{wo.desc}</td></tr>
          <tr><td>Root Cause:</td><td>{wo.rootCause}</td></tr>
          <tr><td>Preventable Actions:</td><td>{wo.preventable}</td></tr>
          <tr><td>Entry Status:</td><td>{wo.flow}</td></tr>
          <tr><td>Priority:</td><td>{wo.priority}</td></tr>
          <tr><td>Assigned to:</td><td>{wo.assigned}</td></tr>
          <tr><td>Created on:</td><td>{fmt(wo.created)} by {wo.createdBy}</td></tr>
          <tr><td>Last Updated on:</td><td>{fmt(wo.updated)} by {wo.updatedBy}</td></tr>
        </tbody></table>
      </div>

      <div className="edTitle">Additional Contacts</div>
      <div className="edBlock">
        {wo.contacts.map((c) => <div key={c} className="ctRow">• <a>{c}</a></div>)}
      </div>

      <div className="edTitle">Gameplan</div>
      <div className="edBlock">
        <div className="gpHead">Active Items</div>
        {wo.gameplan.filter((g) => !g.done).length === 0 && <div className="muted">No active gameplan items</div>}
        {wo.gameplan.map((g, i) =>
          g.done ? null : (
            <div key={i} className="gpItem">
              ▪ {i + 1})&nbsp;
              <input type="checkbox" checked={false} onChange={() => toggleGP(i)} />
              &nbsp;{g.text}
            </div>
          )
        )}
        <div className="gpHead" style={{ marginTop: 8 }}>Completed Items</div>
        {wo.gameplan.filter((g) => g.done).length === 0 && <div className="muted">There are no completed gameplan items</div>}
        {wo.gameplan.map((g, i) =>
          !g.done ? null : (
            <div key={i} className="gpItem gpDone">
              ▪ {i + 1})&nbsp;
              <input type="checkbox" checked onChange={() => toggleGP(i)} />
              &nbsp;<s>{g.text}</s>&nbsp;<span className="gpBy">(by {g.by})</span>
            </div>
          )
        )}
      </div>

      <div className="edTitle">Comments / Log Events</div>
      <div className="edBlock">
        {wo.log.length === 0 && <div className="muted">No comments logged yet.</div>}
        {wo.log.map((l, i) => (
          <div key={i} className="logRow">
            <span className="logMeta">{fmtShort(l.ts)} — <a>{l.by}</a>:</span> {l.text}
          </div>
        ))}
        <div className="cmtAdd">
          <input
            id="cmtBox"
            value={newComment}
            placeholder="Add comment…"
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addComment()}
          />
          <button className="btnGrad" onClick={addComment}>Add Comment</button>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<HomebasePassdown />);
