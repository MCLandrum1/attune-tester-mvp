/* ============================================================
   ATTUNE — tester MVP
   Objective, low-burden logging + a deterministic (non-LLM)
   pattern engine with hard evidence thresholds.

   No servers, no accounts. Everything lives in this browser's
   localStorage. Use "Export data as JSON" to back it up or move
   it to another device.
   ============================================================ */

const STORE_KEY = "attune_mvp_v1";
const DEMO_BACKUP_KEY = "attune_mvp_demo_backup";
const DEMO_STAGE_KEY = "attune_mvp_demo_stage";
const DEMO_SCENARIO_KEY = "attune_mvp_demo_scenario";
const MIN_N = 5; // hard floor: never surface a pattern with fewer than this many days of evidence per side

function loadData() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { moments: [], mornings: [], evenings: [], sickDays: [] };
    const parsed = JSON.parse(raw);
    return {
      moments: Array.isArray(parsed.moments) ? parsed.moments : [],
      mornings: Array.isArray(parsed.mornings) ? parsed.mornings : [],
      evenings: Array.isArray(parsed.evenings) ? parsed.evenings : [],
      sickDays: Array.isArray(parsed.sickDays) ? parsed.sickDays : [],
    };
  } catch (e) {
    console.error("Attune: failed to load stored data, starting fresh.", e);
    return { moments: [], mornings: [], evenings: [], sickDays: [] };
  }
}

function saveData() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    queueCloudSave();
  } catch (e) {
    console.error("Attune: failed to save data.", e);
    showToast("Couldn't save — storage may be full or disabled.");
  }
}

let state = loadData();
let simulationMode = localStorage.getItem(DEMO_BACKUP_KEY) !== null;
let cloudClient = null;
let cloudUser = null;
let cloudSaveTimer = null;
let applyingCloudState = false;

function setCloudStatus(label, signedIn = false) {
  const status = document.getElementById("cloudStatus");
  const button = document.getElementById("cloudButton");
  status.textContent = label;
  status.classList.toggle("done", signedIn);
  button.textContent = signedIn ? "Sign out" : "Sign in";
}

function queueCloudSave() {
  if (!cloudClient || !cloudUser || applyingCloudState || simulationMode) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(saveCloudState, 350);
}

async function saveCloudState() {
  if (!cloudClient || !cloudUser) return;
  setCloudStatus("saving…", true);
  const { error } = await cloudClient.from("attune_tester_state").upsert({
    user_id: cloudUser.id,
    data: state,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("Attune: cloud save failed.", error);
    setCloudStatus("saved on this device", true);
    showToast("Saved on this device; cloud sync will retry.");
    return;
  }
  setCloudStatus("synced", true);
}

async function loadCloudState() {
  if (!cloudClient || !cloudUser) return;
  setCloudStatus("syncing…", true);
  const { data, error } = await cloudClient
    .from("attune_tester_state")
    .select("data")
    .eq("user_id", cloudUser.id)
    .maybeSingle();
  if (error) {
    console.error("Attune: cloud load failed.", error);
    setCloudStatus("saved on this device", true);
    return;
  }
  if (data && data.data) {
    applyingCloudState = true;
    const incoming = data.data;
    state = {
      moments: Array.isArray(incoming.moments) ? incoming.moments : [],
      mornings: Array.isArray(incoming.mornings) ? incoming.mornings : [],
      evenings: Array.isArray(incoming.evenings) ? incoming.evenings : [],
      sickDays: Array.isArray(incoming.sickDays) ? incoming.sickDays : [],
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    applyingCloudState = false;
    renderTodayStatus();
  } else {
    await saveCloudState();
  }
  setCloudStatus("synced", true);
}

async function initCloud() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok || !window.supabase) return;
    const config = await response.json();
    if (!config.configured) return;
    cloudClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    const { data } = await cloudClient.auth.getSession();
    cloudUser = data.session?.user || null;
    if (cloudUser) await loadCloudState();
    else setCloudStatus("device only");
    cloudClient.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user || null;
      const changed = nextUser?.id !== cloudUser?.id;
      cloudUser = nextUser;
      if (cloudUser && changed) setTimeout(loadCloudState, 0);
      if (!cloudUser) setCloudStatus("device only");
    });
  } catch (error) {
    console.warn("Attune: cloud sync unavailable; continuing on this device.", error);
  }
}

// ---------- helpers ----------
function todayStr() {
  return localDateStr(new Date());
}
function localDateStr(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function nowTimeLabel() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}
function fmtDate(d) {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ============================================================
// PARENT SIMULATION — deterministic synthetic data only.
// Real device data is backed up and cloud writes pause until restored.
// ============================================================
function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const SIMULATION_SCENARIOS = {
  changing: { label: "Changing pattern", description: "A real sleep signal weakens and reverses in recent days." },
  messy: { label: "Messy logging", description: "Missed check-ins, unsure answers, multiple moments, and skipped reviews." },
  noise: { label: "No true pattern", description: "Plenty of entries, but outcomes are intentionally unrelated to daily factors." },
  illness: { label: "Illness-heavy", description: "Many sick days test whether health context stays visible but out of comparisons." },
  supports: { label: "Mixed supports", description: "Frequent moments build strong, weak, and contradictory support histories." },
  nap_signal: { label: "Nap signal", description: "No-nap days reliably carry more rough moments." },
  setting_null: { label: "School/home null", description: "School and home days have equal outcomes, so no setting pattern should surface." },
  routine_reversal: { label: "Routine reversal", description: "Disruption predicts rough days early, then reverses in the recent holdout." },
  discomfort_thin: { label: "Discomfort inconclusive", description: "Clear discomfort appears too rarely to cross the evidence floor." },
};

function generateParentSimulation(dayCount, scenario = "changing") {
  const seedOffset = Object.keys(SIMULATION_SCENARIOS).indexOf(scenario) * 7919;
  const random = seededRandom(48271 + Math.max(0, seedOffset));
  const moments = [];
  const mornings = [];
  const evenings = [];
  const sickDays = [];
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - dayCount + 1);
  let supportIndex = 0;

  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + dayIndex);
    const dateStr = localDateStr(date);
    const shortSleep = ["changing", "messy", "illness"].includes(scenario) && dayIndex % 2 === 0;
    const recentWindow = dayCount === 32 && dayIndex >= 22;
    const nap = scenario === "nap_signal" ? (dayIndex % 2 === 0 ? "none" : "45to90") : "45to90";
    const daySetting = scenario === "setting_null" ? (dayIndex % 2 === 0 ? "school" : "home") : "mixed";
    const routineDisruption = scenario === "routine_reversal" ? (dayIndex % 2 === 0 ? "yes" : "no") : "no";
    const physicalDiscomfort = scenario === "discomfort_thin" && dayIndex % 11 === 0 ? "clear" : "none";

    const skipMorning = scenario === "messy" && dayIndex % 4 === 0;
    const skipEvening = scenario === "messy" && dayIndex % 5 === 0;
    if (!skipMorning) mornings.push({
      id: `demo-m-${dayIndex}`,
      date: dateStr,
      bedtime: shortSleep ? "21:35" : "20:20",
      wakeTime: shortSleep ? "06:25" : "07:15",
      nightWakings: 0,
      fellAsleepAlone: "yes",
      loggedAt: new Date(date.getTime() + 8 * 3600000).toISOString(),
    });

    const note = dayIndex % 6 === 0
      ? "Busy transition after school; connection before dinner seemed to settle things."
      : dayIndex % 9 === 0 ? "A quieter day than expected." : "";
    if (!skipEvening) evenings.push({
      id: `demo-e-${dayIndex}`,
      date: dateStr,
      meals: scenario === "messy" && dayIndex % 3 === 0 ? ["breakfast", "dinner"] : ["breakfast", "lunch", "dinner"],
      snackPresent: scenario === "messy" && dayIndex % 6 === 0 ? "unsure" : "no",
      outdoorTime: scenario === "messy" && dayIndex % 4 === 1 ? "unsure" : "30to60",
      structuredActivity: "no",
      focusedTime: "15to45",
      screenTime: "some",
      nap,
      daySetting,
      routineDisruption,
      physicalDiscomfort,
      note,
      loggedAt: new Date(date.getTime() + 20 * 3600000).toISOString(),
    });

    // Early data has a genuine short-sleep signal. In the final ten days the
    // outcomes even out, allowing the holdout to challenge the old pattern.
    if (scenario === "illness" && dayIndex % 3 === 0) {
      sickDays.push({ id: `demo-s-${dayIndex}`, date: dateStr, loggedAt: new Date(date.getTime() + 9 * 3600000).toISOString() });
    }

    let roughDay;
    if (scenario === "noise") roughDay = (dayIndex * 7 + 3) % 10 < 4;
    else if (scenario === "supports") roughDay = dayIndex % 5 !== 0;
    else if (scenario === "messy") roughDay = shortSleep ? dayIndex % 5 !== 0 : dayIndex % 7 === 1;
    else if (scenario === "nap_signal") roughDay = nap === "none" ? dayIndex % 6 !== 0 : dayIndex % 8 === 1;
    else if (scenario === "setting_null") roughDay = dayIndex % 4 < 2;
    else if (scenario === "routine_reversal" && recentWindow) roughDay = routineDisruption === "yes" ? dayIndex % 4 === 0 : dayIndex % 4 !== 0;
    else if (scenario === "routine_reversal") roughDay = routineDisruption === "yes" ? dayIndex % 6 !== 0 : dayIndex % 8 === 1;
    else if (scenario === "discomfort_thin") roughDay = physicalDiscomfort === "clear" || dayIndex % 5 === 2;
    else if (recentWindow) roughDay = shortSleep ? dayIndex % 4 === 0 : dayIndex % 4 !== 0;
    else roughDay = shortSleep ? dayIndex % 6 !== 0 : dayIndex % 8 === 1;
    if (!roughDay) continue;

    const timestamp = new Date(date);
    timestamp.setHours(16 + (dayIndex % 3), Math.floor(random() * 50), 0, 0);
    const tag = supportIndex % 3 === 0 ? "transition" : supportIndex % 3 === 1 ? "social" : "tired";
    const supportTried = scenario === "messy" && supportIndex % 5 === 0
      ? "skipped"
      : supportIndex % 3 === 0 ? "movement" : supportIndex % 3 === 1 ? "connection" : "snack";
    const supportHelped = supportTried === "movement"
      ? (supportIndex % 5 === 0 ? "a_little" : "yes_clearly")
      : supportTried === "connection" ? (scenario === "supports" && supportIndex % 4 === 0 ? "not_really" : "a_little")
        : supportTried === "skipped" ? null : (supportIndex % 2 ? "not_really" : "not_sure");
    moments.push({
      id: `demo-r-${dayIndex}`,
      timestamp: timestamp.toISOString(),
      tag,
      recovery: tag === "transition" ? "slow" : "quick",
      note: "",
      supportTried,
      supportHelped,
    });
    supportIndex += 1;

    if ((scenario === "messy" || scenario === "supports") && dayIndex % 3 === 0) {
      const secondTimestamp = new Date(timestamp.getTime() + 75 * 60000);
      moments.push({
        id: `demo-r2-${dayIndex}`,
        timestamp: secondTimestamp.toISOString(),
        tag: scenario === "messy" && dayIndex % 6 === 0 ? "unknown" : "overwhelmed",
        recovery: scenario === "messy" && dayIndex % 4 === 0 ? "unsure" : "quick",
        note: "Second hard moment during a crowded part of the day.",
        supportTried: supportIndex % 2 === 0 ? "quiet_space" : "movement",
        supportHelped: supportIndex % 2 === 0 ? "not_really" : "yes_clearly",
      });
      supportIndex += 1;
    }
  }

  return { moments, mornings, evenings, sickDays };
}

function startSimulation() {
  if (!simulationMode) {
    localStorage.setItem(DEMO_BACKUP_KEY, JSON.stringify(state));
    simulationMode = true;
  }
  setSimulationStage(7);
}

function setSimulationStage(dayCount) {
  localStorage.setItem(DEMO_STAGE_KEY, String(dayCount));
  const scenario = localStorage.getItem(DEMO_SCENARIO_KEY) || "changing";
  state = generateParentSimulation(dayCount, scenario);
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  renderTodayStatus();
  renderUnderstanding();
  showToast(`Simulation: ${dayCount} days of parent input.`);
}

function setSimulationScenario(scenario) {
  if (!SIMULATION_SCENARIOS[scenario]) return;
  localStorage.setItem(DEMO_SCENARIO_KEY, scenario);
  setSimulationStage(Number(localStorage.getItem(DEMO_STAGE_KEY)) || 32);
}

function restoreRealData() {
  const backup = localStorage.getItem(DEMO_BACKUP_KEY);
  state = backup ? JSON.parse(backup) : { moments: [], mornings: [], evenings: [], sickDays: [] };
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  localStorage.removeItem(DEMO_BACKUP_KEY);
  localStorage.removeItem(DEMO_STAGE_KEY);
  localStorage.removeItem(DEMO_SCENARIO_KEY);
  simulationMode = false;
  renderTodayStatus();
  renderUnderstanding();
  showToast("Real entries restored.");
}

// ============================================================
// NAV
// ============================================================
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "log") renderLog();
    if (btn.dataset.tab === "understand") renderUnderstanding();
    if (btn.dataset.tab === "today") renderTodayStatus();
  });
});

document.getElementById("todayDate").textContent = fmtDate(todayStr());

document.getElementById("cloudButton").addEventListener("click", async () => {
  if (!cloudClient) {
    showToast("Cloud sync is not configured yet.");
    return;
  }
  if (cloudUser) {
    await cloudClient.auth.signOut();
    cloudUser = null;
    setCloudStatus("device only");
    showToast("Signed out. New entries still save on this device.");
    return;
  }
  document.getElementById("authOverlay").classList.add("open");
  document.getElementById("authEmail").focus();
});

document.getElementById("authCancel").addEventListener("click", () => {
  document.getElementById("authOverlay").classList.remove("open");
});

document.getElementById("authSend").addEventListener("click", async () => {
  const email = document.getElementById("authEmail").value.trim();
  if (!email || !email.includes("@")) {
    showToast("Enter a valid email address.");
    return;
  }
  const button = document.getElementById("authSend");
  button.disabled = true;
  button.textContent = "Sending…";
  const { error } = await cloudClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  button.disabled = false;
  button.textContent = "Email me a sign-in link";
  if (error) {
    console.error("Attune: sign-in link failed.", error);
    showToast("Couldn't send the sign-in link. Try again.");
    return;
  }
  document.getElementById("authOverlay").classList.remove("open");
  showToast("Check your email for the Attune sign-in link.");
});

document.getElementById("manualReview").addEventListener("click", () => startMomentReview());

// ============================================================
// ROUGH MOMENT — one-tap real-time capture
// ============================================================
let pendingMomentId = null;
let selectedMomentTag = null;

document.getElementById("momentBtn").addEventListener("click", () => {
  const m = {
    id: uid(),
    timestamp: new Date().toISOString(),
    tag: null,
    recovery: null,
    note: "",
    supportTried: null,
    supportHelped: null,
  };
  state.moments.push(m);
  saveData();
  pendingMomentId = m.id;
  selectedMomentTag = null;
  document.querySelectorAll("#momentChips .chip").forEach((c) => c.classList.remove("selected"));
  document.getElementById("momentTimestamp").textContent = nowTimeLabel() + " · logged instantly";
  document.getElementById("momentOverlay").classList.add("open");
});

document.querySelectorAll("#momentChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#momentChips .chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    selectedMomentTag = chip.dataset.val;
    const moment = state.moments.find((x) => x.id === pendingMomentId);
    if (moment) {
      moment.tag = selectedMomentTag === "unsure" ? "unknown" : selectedMomentTag;
      saveData();
    }
  });
});

document.getElementById("momentDone").addEventListener("click", () => {
  document.getElementById("momentOverlay").classList.remove("open");
  showToast("Captured. That's the hard part done.");
  renderFollowups();
});

// Tapping outside the sheet closes it without discarding the moment itself —
// the timestamp was already saved the instant the button was pressed.
document.getElementById("momentOverlay").addEventListener("click", (e) => {
  if (e.target.id === "momentOverlay") {
    document.getElementById("momentOverlay").classList.remove("open");
    renderFollowups();
  }
});

// ---------- follow-up: "how's it going now?" for recent untagged-recovery moments ----------
function renderFollowups() {
  const zone = document.getElementById("followupZone");
  zone.innerHTML = "";
  const cutoff = Date.now() - 3 * 60 * 60 * 1000; // ask within a 3hr window, then let it go
  const candidate = [...state.moments]
    .reverse()
    .find((m) => !m.recovery && new Date(m.timestamp).getTime() > cutoff);
  if (!candidate) return;

  const box = document.createElement("div");
  box.className = "followup";
  box.innerHTML = `
    <strong>How's it going now?</strong> — the moment at ${nowLabelFor(candidate.timestamp)}
    <div class="chip-row">
      <div class="chip" data-r="quick">Recovered quickly</div>
      <div class="chip" data-r="slow">Still settling</div>
      <div class="chip unsure" data-r="unsure">Not sure</div>
    </div>
  `;
  box.querySelectorAll(".chip").forEach((c) => {
    c.addEventListener("click", () => {
      candidate.recovery = c.dataset.r;
      saveData();
      showToast("Got it — thanks.");
      renderFollowups();
    });
  });
  zone.appendChild(box);
}
function nowLabelFor(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ============================================================
// MORNING CHECK-IN (sleep — objective fields only)
// ============================================================
let nightWakings = null;
let selectedAlone = null;

document.getElementById("openMorning").addEventListener("click", () => {
  const existing = state.mornings.find((m) => m.date === todayStr());
  nightWakings = existing && Number.isInteger(existing.nightWakings) ? existing.nightWakings : null;
  selectedAlone = existing ? existing.fellAsleepAlone : null;
  document.getElementById("wakeVal").textContent = nightWakings ?? "?";
  document.getElementById("f_bedtime").value = existing ? existing.bedtime : "";
  document.getElementById("f_waketime").value = existing ? existing.wakeTime : "";
  updateAloneChips();
  document.getElementById("morningOverlay").classList.add("open");
});
document.getElementById("morningCancel").addEventListener("click", () => {
  document.getElementById("morningOverlay").classList.remove("open");
});
document.getElementById("wakeMinus").addEventListener("click", () => {
  nightWakings = Math.max(0, (nightWakings ?? 0) - 1);
  document.getElementById("wakeVal").textContent = nightWakings;
});
document.getElementById("wakePlus").addEventListener("click", () => {
  nightWakings = (nightWakings ?? 0) + 1;
  document.getElementById("wakeVal").textContent = nightWakings;
});
function updateAloneChips() {
  document.querySelectorAll("#aloneChips .chip").forEach((c) => {
    c.classList.toggle("selected", c.dataset.val === selectedAlone);
  });
}
document.querySelectorAll("#aloneChips .chip").forEach((c) => {
  c.addEventListener("click", () => {
    selectedAlone = c.dataset.val;
    updateAloneChips();
  });
});
document.getElementById("morningSave").addEventListener("click", () => {
  const date = todayStr();
  const entry = {
    id: uid(),
    date,
    bedtime: document.getElementById("f_bedtime").value || null,
    wakeTime: document.getElementById("f_waketime").value || null,
    nightWakings,
    fellAsleepAlone: selectedAlone,
    loggedAt: new Date().toISOString(),
  };
  const idx = state.mornings.findIndex((m) => m.date === date);
  if (idx >= 0) state.mornings[idx] = entry;
  else state.mornings.push(entry);
  saveData();
  document.getElementById("morningOverlay").classList.remove("open");
  showToast("Morning saved.");
  renderTodayStatus();
});

// ============================================================
// EVENING CHECK-IN (nutrition / movement / connection — objective fields)
// ============================================================
let selectedMeals = new Set();
let selectedSnack = null;
let selectedStruct = null;

document.getElementById("openEvening").addEventListener("click", () => {
  const existing = state.evenings.find((e) => e.date === todayStr());
  selectedMeals = new Set(existing ? existing.meals : []);
  selectedSnack = existing ? existing.snackPresent : null;
  selectedStruct = existing ? existing.structuredActivity : null;
  document.getElementById("f_outdoor").value = existing ? existing.outdoorTime : "unsure";
  document.getElementById("f_focus").value = existing ? existing.focusedTime : "unsure";
  document.getElementById("f_screen").value = existing ? existing.screenTime : "unsure";
  document.getElementById("f_nap").value = existing ? existing.nap || "unsure" : "unsure";
  document.getElementById("f_daySetting").value = existing ? existing.daySetting || "unsure" : "unsure";
  document.getElementById("f_routineDisruption").value = existing ? existing.routineDisruption || "unsure" : "unsure";
  document.getElementById("f_physicalDiscomfort").value = existing ? existing.physicalDiscomfort || "unsure" : "unsure";
  document.getElementById("f_eveningNote").value = existing ? existing.note || "" : "";
  updateMealsChips();
  updateSnackChips();
  updateStructChips();
  document.getElementById("eveningOverlay").classList.add("open");
});
document.getElementById("eveningCancel").addEventListener("click", () => {
  document.getElementById("eveningOverlay").classList.remove("open");
});
function updateMealsChips() {
  document.querySelectorAll("#mealsChips .chip").forEach((c) => {
    c.classList.toggle("selected", selectedMeals.has(c.dataset.val));
  });
}
document.querySelectorAll("#mealsChips .chip").forEach((c) => {
  c.addEventListener("click", () => {
    if (selectedMeals.has(c.dataset.val)) selectedMeals.delete(c.dataset.val);
    else selectedMeals.add(c.dataset.val);
    updateMealsChips();
  });
});
function updateSnackChips() {
  document.querySelectorAll("#snackChips .chip").forEach((c) => c.classList.toggle("selected", c.dataset.val === selectedSnack));
}
document.querySelectorAll("#snackChips .chip").forEach((c) => {
  c.addEventListener("click", () => { selectedSnack = c.dataset.val; updateSnackChips(); });
});
function updateStructChips() {
  document.querySelectorAll("#structChips .chip").forEach((c) => c.classList.toggle("selected", c.dataset.val === selectedStruct));
}
document.querySelectorAll("#structChips .chip").forEach((c) => {
  c.addEventListener("click", () => { selectedStruct = c.dataset.val; updateStructChips(); });
});
document.getElementById("eveningSave").addEventListener("click", () => {
  const date = todayStr();
  const entry = {
    id: uid(),
    date,
    meals: Array.from(selectedMeals),
    snackPresent: selectedSnack,
    outdoorTime: document.getElementById("f_outdoor").value,
    structuredActivity: selectedStruct,
    focusedTime: document.getElementById("f_focus").value,
    screenTime: document.getElementById("f_screen").value,
    nap: document.getElementById("f_nap").value,
    daySetting: document.getElementById("f_daySetting").value,
    routineDisruption: document.getElementById("f_routineDisruption").value,
    physicalDiscomfort: document.getElementById("f_physicalDiscomfort").value,
    note: document.getElementById("f_eveningNote").value.trim().slice(0, 1000),
    loggedAt: new Date().toISOString(),
  };
  const idx = state.evenings.findIndex((e) => e.date === date);
  if (idx >= 0) state.evenings[idx] = entry;
  else state.evenings.push(entry);
  saveData();
  document.getElementById("eveningOverlay").classList.remove("open");
  showToast("Today saved.");
  renderTodayStatus();
  startMomentReview();
});

// ============================================================
// MOMENT RETROSPECTIVE — support effectiveness is collected later,
// never while a parent is handling the rough moment itself.
// ============================================================
let reviewQueue = [];
let reviewIdx = 0;
let reviewSelectedTried = null;
let reviewSelectedHelped = null;

function startMomentReview() {
  const cutoff = Date.now() - 36 * 60 * 60 * 1000;
  reviewQueue = state.moments
    .filter((m) => m.supportTried == null && new Date(m.timestamp).getTime() > cutoff)
    .slice(-2);
  reviewIdx = 0;
  if (reviewQueue.length) showReviewStep();
  else showToast("No recent moments need a look back.");
}

function showReviewStep() {
  if (reviewIdx >= reviewQueue.length) {
    document.getElementById("reviewOverlay").classList.remove("open");
    return;
  }
  reviewSelectedTried = null;
  reviewSelectedHelped = null;
  const moment = reviewQueue[reviewIdx];
  document.getElementById("reviewMomentLabel").textContent = `The moment at ${nowLabelFor(moment.timestamp)} (${tagLabel(moment.tag)})`;
  document.querySelectorAll("#triedChips .chip, #helpedChips .chip").forEach((chip) => chip.classList.remove("selected"));
  document.getElementById("helpedField").style.display = "none";
  document.getElementById("reviewOverlay").classList.add("open");
}

document.querySelectorAll("#triedChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#triedChips .chip").forEach((item) => item.classList.remove("selected"));
    chip.classList.add("selected");
    reviewSelectedTried = chip.dataset.val;
    reviewSelectedHelped = null;
    document.querySelectorAll("#helpedChips .chip").forEach((item) => item.classList.remove("selected"));
    document.getElementById("helpedField").style.display = reviewSelectedTried === "nothing" ? "none" : "block";
  });
});

document.querySelectorAll("#helpedChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#helpedChips .chip").forEach((item) => item.classList.remove("selected"));
    chip.classList.add("selected");
    reviewSelectedHelped = chip.dataset.val;
  });
});

function finishReviewStep(skipped = false) {
  const moment = reviewQueue[reviewIdx];
  if (skipped || !reviewSelectedTried) {
    moment.supportTried = "skipped";
    moment.supportHelped = null;
  } else {
    moment.supportTried = reviewSelectedTried;
    moment.supportHelped = reviewSelectedTried === "nothing" ? null : reviewSelectedHelped;
  }
  saveData();
  reviewIdx += 1;
  showReviewStep();
}

document.getElementById("reviewSkip").addEventListener("click", () => finishReviewStep(true));
document.getElementById("reviewNext").addEventListener("click", () => finishReviewStep(false));

// ============================================================
// TODAY STATUS PILLS
// ============================================================
function renderTodayStatus() {
  const d = todayStr();
  const m = state.mornings.find((x) => x.date === d);
  const e = state.evenings.find((x) => x.date === d);
  const sick = state.sickDays.find((x) => x.date === d);
  const ms = document.getElementById("morningStatus");
  const es = document.getElementById("eveningStatus");
  ms.textContent = m ? "logged" : "not yet";
  ms.classList.toggle("done", !!m);
  es.textContent = e ? "logged" : "not yet";
  es.classList.toggle("done", !!e);
  const ss = document.getElementById("sickStatus");
  ss.textContent = sick ? "logged · tap to undo" : "not marked";
  ss.classList.toggle("done", !!sick);
  renderFollowups();
}

document.getElementById("sickBtn").addEventListener("click", () => {
  const date = todayStr();
  const index = state.sickDays.findIndex((x) => x.date === date);
  if (index >= 0) {
    state.sickDays.splice(index, 1);
    showToast("Sick-day marker removed.");
  } else {
    state.sickDays.push({ id: uid(), date, loggedAt: new Date().toISOString() });
    showToast("Sick day logged.");
  }
  saveData();
  renderTodayStatus();
});

// ============================================================
// LOG TAB
// ============================================================
function renderLog() {
  const list = document.getElementById("logList");
  const items = [];
  state.moments.forEach((m) =>
    items.push({ type: "moment", t: m.timestamp, node: momentNode(m) })
  );
  state.mornings.forEach((m) =>
    items.push({ type: "morning", t: m.loggedAt || m.date, node: morningNode(m) })
  );
  state.evenings.forEach((e) =>
    items.push({ type: "evening", t: e.loggedAt || e.date, node: eveningNode(e) })
  );
  state.sickDays.forEach((s) =>
    items.push({ type: "sick", t: s.loggedAt || s.date, node: sickNode(s) })
  );
  items.sort((a, b) => new Date(b.t) - new Date(a.t));

  if (items.length === 0) {
    list.innerHTML = `<div class="empty">Nothing logged yet. Once you tap "Rough Moment" or fill in a check-in, it'll show up here.</div>`;
    return;
  }
  list.innerHTML = "";
  items.forEach((i) => list.appendChild(i.node));
}

function tagLabel(tag) {
  const map = {
    tired: "Tired", hungry: "Hungry", transition: "Transition",
    limit_set: "Told no / limits", overwhelmed: "Too much going on",
    social: "Sibling / social", sensory: "Sensory", unknown: "Not sure",
  };
  return tag ? map[tag] || tag : "no tag added";
}
function recoveryLabel(r) {
  const map = { quick: "recovered quickly", slow: "took longer to settle", unsure: "recovery unclear" };
  return r ? map[r] : null;
}
function triedLabel(value) {
  const map = {
    movement: "Movement / outside", snack: "Snack", quiet_space: "Quiet space",
    connection: "Cuddle / connection", something_else: "Something else", nothing: "Nothing tried",
  };
  return value ? map[value] || value : null;
}
function helpedLabel(value) {
  const map = {
    yes_clearly: "helped clearly", a_little: "helped a little",
    not_really: "didn't really help", not_sure: "unclear if it helped",
  };
  return value ? map[value] || value : null;
}

function momentNode(m) {
  const div = document.createElement("div");
  div.className = "log-entry";
  const rec = recoveryLabel(m.recovery);
  const tried = m.supportTried && m.supportTried !== "skipped" ? triedLabel(m.supportTried) : null;
  const helped = tried && m.supportTried !== "nothing" ? helpedLabel(m.supportHelped) : null;
  div.innerHTML = `
    <div class="lt">${new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
    <div class="ld">Rough moment</div>
    <div class="tagline">${tagLabel(m.tag)}${rec ? " · " + rec : ""}${tried ? `<div class="moment-note">Tried: ${escapeHtml(tried)}${helped ? ` · ${escapeHtml(helped)}` : ""}</div>` : ""}${m.note ? `<div class="moment-note">${escapeHtml(m.note)}</div>` : ""}</div>
    <button class="entry-remove" type="button">Remove</button>
  `;
  div.querySelector(".entry-remove").addEventListener("click", () => {
    state.moments = state.moments.filter((item) => item.id !== m.id);
    saveData();
    renderLog();
    showToast("Moment removed.");
  });
  return div;
}
function morningNode(m) {
  const div = document.createElement("div");
  div.className = "log-entry morning";
  const dur = sleepDurationMinutes(m);
  div.innerHTML = `
    <div class="lt">${fmtDate(m.date)} · morning</div>
    <div class="ld">Sleep logged</div>
    <div class="tagline">${m.bedtime || "?"}–${m.wakeTime || "?"}${dur ? ` (${(dur / 60).toFixed(1)}h)` : ""} · ${Number.isInteger(m.nightWakings) ? `${m.nightWakings} waking${m.nightWakings === 1 ? "" : "s"}` : "wakings not sure"}</div>
  `;
  return div;
}
function eveningNode(e) {
  const div = document.createElement("div");
  div.className = "log-entry evening";
  const meals = Array.isArray(e.meals) && e.meals.length ? e.meals.join(", ") : "meals not marked";
  div.innerHTML = `
    <div class="lt">${fmtDate(e.date)} · evening</div>
    <div class="ld">Day logged</div>
    <div class="tagline">${meals} · outdoor: ${e.outdoorTime} · focus time: ${e.focusedTime}${e.note ? `<div class="moment-note">${escapeHtml(e.note)}</div>` : ""}</div>
  `;
  return div;
}
function sickNode(s) {
  const div = document.createElement("div");
  div.className = "log-entry sick";
  div.innerHTML = `
    <div class="lt">${fmtDate(s.date)} · health context</div>
    <div class="ld">Sick day</div>
    <div class="tagline">Kept in the log and excluded from ordinary pattern comparisons.</div>
    <button class="entry-remove" type="button">Remove</button>
  `;
  div.querySelector(".entry-remove").addEventListener("click", () => {
    state.sickDays = state.sickDays.filter((item) => item.id !== s.id);
    saveData();
    renderLog();
    showToast("Sick-day marker removed.");
  });
  return div;
}

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attune-export-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".overlay.open").forEach((overlay) => overlay.classList.remove("open"));
});

// ============================================================
// DERIVATION LAYER
// ============================================================
function sleepDurationMinutes(m) {
  if (!m.bedtime || !m.wakeTime) return null;
  const [bh, bm] = m.bedtime.split(":").map(Number);
  const [wh, wm] = m.wakeTime.split(":").map(Number);
  let bedMinutes = bh * 60 + bm;
  let wakeMinutes = wh * 60 + wm;
  if (wakeMinutes <= bedMinutes) wakeMinutes += 24 * 60; // crossed midnight
  return wakeMinutes - bedMinutes;
}

// Build one combined record per calendar day: morning + evening + moment outcomes for that date.
function buildDayRecords() {
  const byDate = {};
  function ensure(date) {
    if (!byDate[date]) byDate[date] = { date, moments: 0, factors: {} };
    return byDate[date];
  }
  state.moments.forEach((m) => {
    const d = localDateStr(m.timestamp);
    ensure(d).moments += 1;
  });
  state.mornings.forEach((m) => {
    const rec = ensure(m.date);
    const dur = sleepDurationMinutes(m);
    if (dur != null) rec.factors["sleep_duration"] = dur < 600 ? "short" : "adequate"; // <10h flagged short; simple fixed heuristic for MVP
    if (m.nightWakings != null) rec.factors["night_wakings"] = m.nightWakings >= 2 ? "frequent" : "few";
    if (m.fellAsleepAlone && m.fellAsleepAlone !== "unsure") rec.factors["fell_asleep_alone"] = m.fellAsleepAlone;
  });
  state.evenings.forEach((e) => {
    const rec = ensure(e.date);
    if (e.outdoorTime && e.outdoorTime !== "unsure") rec.factors["outdoor_time"] = e.outdoorTime;
    if (e.focusedTime && e.focusedTime !== "unsure") rec.factors["focused_time"] = e.focusedTime;
    if (e.screenTime && e.screenTime !== "unsure") rec.factors["screen_time"] = e.screenTime;
    if (e.snackPresent && e.snackPresent !== "unsure") rec.factors["snack_present"] = e.snackPresent;
    if (e.structuredActivity && e.structuredActivity !== "unsure") rec.factors["structured_activity"] = e.structuredActivity;
    if (e.nap && e.nap !== "unsure") rec.factors["nap_duration"] = e.nap;
    if (e.daySetting && e.daySetting !== "unsure") rec.factors["day_setting"] = e.daySetting;
    if (e.routineDisruption && e.routineDisruption !== "unsure") rec.factors["routine_disruption"] = e.routineDisruption;
    if (e.physicalDiscomfort && e.physicalDiscomfort !== "unsure") rec.factors["physical_discomfort"] = e.physicalDiscomfort;
    if (e.meals) rec.factors["all_meals_eaten"] = e.meals.length >= 3 ? "yes" : "no";
  });
  const sickDates = new Set(state.sickDays.map((entry) => entry.date));
  return Object.values(byDate).filter((day) => !sickDates.has(day.date));
}

// ============================================================
// STATS ENGINE — deterministic, evidence-gated, with a recent-data
// holdout so an old pattern cannot remain "strong" indefinitely.
// ============================================================
function computePatterns() {
  const days = buildDayRecords().sort((a, b) => a.date.localeCompare(b.date));
  const factorKeys = new Set();
  days.forEach((d) => Object.keys(d.factors).forEach((k) => factorKeys.add(k)));

  const splitIdx = Math.floor(days.length * 0.7);
  const canHoldout = days.length >= 10;
  const trainDays = canHoldout ? days.slice(0, splitIdx) : days;
  const testDays = canHoldout ? days.slice(splitIdx) : [];

  function rateFor(dayset, key, value) {
    const rows = dayset.filter((day) => day.factors[key] === value);
    if (!rows.length) return null;
    return { n: rows.length, rate: rows.filter((day) => day.moments > 0).length / rows.length };
  }

  const results = [];
  factorKeys.forEach((key) => {
    const groups = {};
    trainDays.forEach((d) => {
      const val = d.factors[key];
      if (val === undefined) return;
      if (!groups[val]) groups[val] = { n: 0, moments: 0 };
      groups[val].n += 1;
      groups[val].moments += d.moments > 0 ? 1 : 0; // "rough day" = at least one logged moment
    });
    const values = Object.keys(groups);
    if (values.length < 2) return;
    // compare each pair of values for this factor
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const a = values[i], b = values[j];
        const ga = groups[a], gb = groups[b];
        if (ga.n < MIN_N || gb.n < MIN_N) continue; // hard floor
        const rateA = ga.moments / ga.n;
        const rateB = gb.moments / gb.n;
        const diff = Math.abs(rateA - rateB);
        if (diff < 0.15) continue; // not a meaningful gap
        const higherVal = rateA > rateB ? a : b;
        const lowerVal = rateA > rateB ? b : a;
        const higherRate = Math.max(rateA, rateB);
        const lowerRate = Math.min(rateA, rateB);
        const nHigher = rateA > rateB ? ga.n : gb.n;
        const nLower = rateA > rateB ? gb.n : ga.n;
        let confidence = "weak_early_signal";
        if (Math.min(nHigher, nLower) >= 10 && diff >= 0.3) confidence = "strong_pattern";
        else if (Math.min(nHigher, nLower) >= MIN_N) confidence = "emerging_pattern";
        let holdoutStatus = "untested";
        if (canHoldout) {
          const testHigher = rateFor(testDays, key, higherVal);
          const testLower = rateFor(testDays, key, lowerVal);
          // The holdout uses the same evidence floor as the training comparison.
          // Calling 2–3 observations per side "confirmed" was still mostly noise.
          if (testHigher && testLower && testHigher.n >= MIN_N && testLower.n >= MIN_N) {
            holdoutStatus = testHigher.rate >= testLower.rate ? "confirmed" : "mixed_signal";
            if (holdoutStatus === "mixed_signal" && confidence === "strong_pattern") confidence = "emerging_pattern";
            else if (holdoutStatus === "mixed_signal" && confidence === "emerging_pattern") confidence = "weak_early_signal";
          }
        }
        results.push({ factor: key, higherVal, lowerVal, higherRate, lowerRate, nHigher, nLower, diff, confidence, holdoutStatus });
      }
    }
  });
  results.sort((a, b) => b.diff - a.diff);
  return { results, totalDays: days.length };
}

function computeSupportEffectiveness() {
  const weights = { yes_clearly: 1, a_little: 0.5, not_really: 0 };
  const groups = {};
  state.moments.forEach((moment) => {
    if (!moment.supportTried || ["nothing", "skipped"].includes(moment.supportTried)) return;
    if (!groups[moment.supportTried]) groups[moment.supportTried] = { n: 0, scored: 0, sum: 0 };
    const group = groups[moment.supportTried];
    group.n += 1;
    if (moment.supportHelped && moment.supportHelped !== "not_sure") {
      group.scored += 1;
      group.sum += weights[moment.supportHelped] ?? 0;
    }
  });
  return Object.entries(groups)
    .map(([support, group]) => ({
      support,
      n: group.n,
      avgHelp: group.scored ? group.sum / group.scored : null,
      evidenceLevel: group.n >= 6 ? "worth_trusting" : group.n >= 3 ? "early_signal" : "just_starting",
    }))
    .filter((result) => result.avgHelp != null)
    .sort((a, b) => b.avgHelp - a.avgHelp);
}

function computeContextInsight() {
  const moments = state.moments.filter((moment) => moment.tag && moment.tag !== "unknown" && moment.recovery && moment.recovery !== "unsure");
  if (!moments.length) return null;
  const overallSlowRate = moments.filter((moment) => moment.recovery === "slow").length / moments.length;
  const groups = {};
  moments.forEach((moment) => {
    if (!groups[moment.tag]) groups[moment.tag] = { n: 0, slow: 0 };
    groups[moment.tag].n += 1;
    if (moment.recovery === "slow") groups[moment.tag].slow += 1;
  });
  const results = Object.entries(groups)
    .filter(([, group]) => group.n >= MIN_N)
    .map(([tag, group]) => ({ tag, n: group.n, slowRate: group.slow / group.n, diff: group.slow / group.n - overallSlowRate }))
    .filter((result) => Math.abs(result.diff) >= 0.15)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return results.length ? { ...results[0], overallSlowRate } : null;
}

function computeLoggingConsistency() {
  const dates = new Set();
  state.moments.forEach((moment) => dates.add(localDateStr(moment.timestamp)));
  state.mornings.forEach((morning) => dates.add(morning.date));
  state.evenings.forEach((evening) => dates.add(evening.date));
  if (!dates.size) return null;
  const sorted = [...dates].sort();
  const spanDays = Math.round((new Date(sorted.at(-1)) - new Date(sorted[0])) / 86400000) + 1;
  const morningDays = new Set(state.mornings.map((item) => item.date)).size;
  const eveningDays = new Set(state.evenings.map((item) => item.date)).size;
  return {
    spanDays,
    morningRate: Math.round((morningDays / spanDays) * 100),
    eveningRate: Math.round((eveningDays / spanDays) * 100),
  };
}

const FACTOR_LABELS = {
  sleep_duration: "how long they slept",
  night_wakings: "night wakings",
  fell_asleep_alone: "falling asleep alone",
  outdoor_time: "outdoor time",
  focused_time: "focused 1:1 time",
  screen_time: "screen time",
  snack_present: "sugary or processed snacks",
  structured_activity: "structured activity",
  all_meals_eaten: "eating all three meals",
  nap_duration: "nap duration",
  day_setting: "school/daycare versus home",
  routine_disruption: "routine disruption",
  physical_discomfort: "signs of physical discomfort",
};
const VALUE_LABELS = {
  short: "under 10 hours", adequate: "10+ hours",
  frequent: "2 or more", few: "0–1",
  yes: "yes", no: "no",
  none: "none", under30: "under 30 min", "30to60": "30–60 min", over60: "over 60 min",
  under15: "under 15 min", "15to45": "15–45 min", over45: "over 45 min",
  some: "some", alot: "a lot",
  under45: "under 45 min", "45to90": "45–90 min", over90: "over 90 min",
  school: "school/daycare", home: "home", mixed: "a mixed day",
  possible: "possible signs", clear: "clear signs",
};
const EXPERIMENTS = {
  sleep_duration: "Aim for a slightly earlier bedtime and see whether tomorrow feels different.",
  night_wakings: "Keep tracking this; if frequent wakings persist, consider discussing them with a pediatrician.",
  outdoor_time: "Try getting outside before the day's usual harder window.",
  focused_time: "Try 15 minutes of uninterrupted, phone-down time together before the usual rough patch.",
  screen_time: "Try trimming screen time earlier in the day and see whether the evening shifts.",
  snack_present: "Try a comparable day with a different snack routine and watch what changes.",
  structured_activity: "Try one structured activity earlier in the day.",
  all_meals_eaten: "Try making sure all three meals happen, even if they're small, and watch what changes.",
  nap_duration: "Keep the nap window consistent for a few comparable days and watch whether the usual hard period shifts.",
  day_setting: "Compare similar school/daycare and home days before changing anything—the setting may be context, not a cause.",
  routine_disruption: "On a disrupted day, preview the changed plan and add one familiar anchor to see whether transitions feel easier.",
  physical_discomfort: "Treat discomfort as health context, not a behavior cause; address the physical need and seek medical guidance when appropriate.",
};
const CONFIDENCE_DISPLAY = { weak_early_signal: "weak early signal", emerging_pattern: "emerging pattern", strong_pattern: "strong pattern" };
const EVIDENCE_DISPLAY = { just_starting: "just starting", early_signal: "early signal", worth_trusting: "worth trusting" };
// Evidence answers "how much data?" Direction separately answers "did it help?"
// A well-observed coin flip must never look like an endorsement.
const DIRECTION_DISPLAY = {
  helping_consistently: "helping consistently",
  mixed_results: "mixed results",
  not_helping_much: "not helping much",
};
function directionFor(avgHelp) {
  if (avgHelp == null) return null;
  if (avgHelp >= 0.65) return "helping_consistently";
  if (avgHelp >= 0.35) return "mixed_results";
  return "not_helping_much";
}

function renderUnderstanding() {
  const zone = document.getElementById("understandZone");
  const { results, totalDays } = computePatterns();
  const supportResults = computeSupportEffectiveness();
  const contextInsight = computeContextInsight();
  const consistency = computeLoggingConsistency();
  const simulationStage = Number(localStorage.getItem(DEMO_STAGE_KEY)) || 0;
  const simulationScenario = localStorage.getItem(DEMO_SCENARIO_KEY) || "changing";
  const simulationSummary = `${state.moments.length} moments · ${state.mornings.length} mornings · ${state.evenings.length} evenings · ${state.sickDays.length} sick days`;
  let html = simulationMode
    ? `<div class="card" style="border-color:var(--teal-accent);">
        <span class="eyebrow">Parent simulation · synthetic data</span>
        <h3>${simulationStage} days observed</h3>
        <p class="desc">Cloud sync is paused. Step forward to watch the evidence change; your real entries are safely backed up on this device.</p>
        <div class="evidence-line">${simulationSummary}</div>
        <div class="section-title" style="margin-top:14px;">Boundary scenario</div>
        <div class="chip-row" id="simulationScenarios">
          ${Object.entries(SIMULATION_SCENARIOS).map(([key, item]) => `<button class="chip${key === simulationScenario ? " selected" : ""}" type="button" data-sim-scenario="${key}">${item.label}</button>`).join("")}
        </div>
        <p class="desc" style="margin-top:8px;">${SIMULATION_SCENARIOS[simulationScenario].description}</p>
        <div class="section-title" style="margin-top:14px;">Observation window</div>
        <div class="chip-row" id="simulationStages">
          ${[7, 14, 21, 32].map((days) => `<button class="chip${days === simulationStage ? " selected" : ""}" type="button" data-sim-days="${days}">${days} days</button>`).join("")}
        </div>
        <button class="btn ghost" id="restoreSimulation" type="button" style="margin-top:12px;">Exit simulation &amp; restore my data</button>
      </div>`
    : `<div class="card" style="border-color:var(--line);">
        <span class="eyebrow">Explore how Attune learns</span>
        <h3>Run a parent-input simulation</h3>
        <p class="desc">Use realistic synthetic entries to watch the outputs develop over 7, 14, 21, and 32 days. Your current data will be backed up first.</p>
        <button class="btn ghost" id="startSimulation" type="button">Start simulation</button>
      </div>`;

  if (totalDays < 7) {
    html += `
      <div class="card theory-card">
        <span class="confidence-tag">still learning</span>
        <div class="theory-line">Attune needs a couple weeks of logging before it can say anything trustworthy — right now there's ${totalDays} day${totalDays === 1 ? "" : "s"} of data. Guessing early would just be noise dressed up as insight.</div>
        <div class="evidence-line">Keep tapping "Rough Moment" when it happens, and fill in the two daily check-ins — that's genuinely the whole job for now.</div>
      </div>
    `;
  } else if (results.length === 0) {
    html += `
      <div class="card theory-card">
        <span class="confidence-tag">still learning</span>
        <div class="theory-line">${totalDays} days logged, and nothing has separated itself clearly yet from day-to-day noise. That's a fine, honest place to be.</div>
        <div class="evidence-line">Keep going — real patterns need enough days on both sides of a comparison (at least ${MIN_N} each) before Attune will say anything.</div>
      </div>
    `;
  } else {
    const top = results[0];
    const holdoutNote = top.holdoutStatus === "mixed_signal"
      ? " This did not hold as clearly in the most recent days, so confidence was reduced."
      : top.holdoutStatus === "confirmed" ? " It also held in the most recent days." : "";
    html += `
      <div class="card theory-card">
        <span class="confidence-tag">${CONFIDENCE_DISPLAY[top.confidence]}</span>
        <div class="theory-line">Rough moments show up more with <strong>${VALUE_LABELS[top.higherVal] || top.higherVal}</strong> ${FACTOR_LABELS[top.factor] || top.factor}, compared with <strong>${VALUE_LABELS[top.lowerVal] || top.lowerVal}</strong>.</div>
        <div class="evidence-line">${Math.round(top.higherRate * 100)}% of ${top.nHigher} days vs. ${Math.round(top.lowerRate * 100)}% of ${top.nLower} days.${holdoutNote}</div>
        <div class="try-box"><span class="lbl">Worth trying</span>${EXPERIMENTS[top.factor] || "Change one thing for a few comparable days and see what shifts."}</div>
        <div class="try-box"><span class="lbl">How you'll know</span>Fewer rough moments on comparable days. Attune will keep tracking both outcomes.</div>
      </div>
      ${results.length > 1 ? `<div class="section-title">Other early signals (${results.length - 1})</div>` : ""}
      ${results.slice(1, 4).map((result) => `<div class="card"><span class="eyebrow">${CONFIDENCE_DISPLAY[result.confidence]}</span><div style="font-size:0.88rem; color:var(--text-muted);">${FACTOR_LABELS[result.factor] || result.factor}: ${VALUE_LABELS[result.higherVal] || result.higherVal} vs ${VALUE_LABELS[result.lowerVal] || result.lowerVal} (${result.nHigher}/${result.nLower} days)</div></div>`).join("")}
    `;
  }

  if (consistency && consistency.spanDays >= 5 && (consistency.morningRate < 70 || consistency.eveningRate < 70)) {
    html += `<div class="card" style="border-color:var(--amber-dim);"><span class="eyebrow">Logging consistency</span><div style="font-size:0.85rem; color:var(--text-muted);">Morning check-ins are present on ${consistency.morningRate}% of days and evening check-ins on ${consistency.eveningRate}%. Thin logging can keep patterns uncertain.</div></div>`;
  }

  html += `<div class="section-title">What's helped when it's hard</div>`;
  html += supportResults.length
    ? supportResults.slice(0, 4).map((result) => {
        const direction = directionFor(result.avgHelp);
        const percentage = Math.round(result.avgHelp * 100);
        const badge = direction
          ? `${EVIDENCE_DISPLAY[result.evidenceLevel]}, ${DIRECTION_DISPLAY[direction]}`
          : EVIDENCE_DISPLAY[result.evidenceLevel];
        const body = result.evidenceLevel === "just_starting"
          ? `Only ${result.n} time${result.n === 1 ? "" : "s"} tried so far (${percentage}% helpful)—too early to trust, worth a few more observations.`
          : `Rated fully or partly helpful ${percentage}% of scored uses.`;
        return `<div class="card"><span class="eyebrow">${badge} · ${result.n} time${result.n === 1 ? "" : "s"} tried</span><h3 style="font-size:0.95rem;">${triedLabel(result.support)}</h3><div style="font-size:0.85rem; color:var(--text-muted);">${body}</div></div>`;
      }).join("")
    : `<div class="card"><div style="font-size:0.85rem; color:var(--text-muted);">No supports scored yet. Use “Look back” after recent moments to build this evidence separately from day-level patterns.</div></div>`;

  if (contextInsight) {
    const slowPct = Math.round(contextInsight.slowRate * 100);
    const overallPct = Math.round(contextInsight.overallSlowRate * 100);
    const slowCount = Math.round(contextInsight.slowRate * contextInsight.n);
    const countPhrase = slowCount === contextInsight.n
      ? `all ${contextInsight.n} tracked moments`
      : slowCount === 0
        ? `none of ${contextInsight.n} tracked moments`
        : `${slowCount} of ${contextInsight.n} tracked moments (${slowPct}%)`;
    const recoveryCopy = contextInsight.diff > 0
      ? `took longer to settle more often than moments overall—${countPhrase}, versus ${overallPct}% overall.`
      : `tended to bounce back faster than moments overall—a slow recovery in ${countPhrase}, versus ${overallPct}% overall.`;
    html += `<div class="section-title">Recovery pattern</div><div class="card"><span class="eyebrow">emerging pattern · ${contextInsight.n} moments</span><div style="font-size:0.9rem;">Moments tagged <strong>${tagLabel(contextInsight.tag)}</strong> ${recoveryCopy}</div></div>`;
  }

  zone.innerHTML = html;

  const startButton = document.getElementById("startSimulation");
  if (startButton) startButton.addEventListener("click", startSimulation);
  const restoreButton = document.getElementById("restoreSimulation");
  if (restoreButton) restoreButton.addEventListener("click", restoreRealData);
  document.querySelectorAll("[data-sim-days]").forEach((button) => {
    button.addEventListener("click", () => setSimulationStage(Number(button.dataset.simDays)));
  });
  document.querySelectorAll("[data-sim-scenario]").forEach((button) => {
    button.addEventListener("click", () => setSimulationScenario(button.dataset.simScenario));
  });
}

// ============================================================
// INIT
// ============================================================
renderTodayStatus();
initCloud();
