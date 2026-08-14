/* ============================================================
   ATTUNE — tester MVP
   Objective, low-burden logging + a deterministic (non-LLM)
   pattern engine with hard evidence thresholds.

   No servers, no accounts. Everything lives in this browser's
   localStorage. Use "Export data as JSON" to back it up or move
   it to another device.
   ============================================================ */

const STORE_KEY = "attune_mvp_v1";
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
  } catch (e) {
    console.error("Attune: failed to save data.", e);
    showToast("Couldn't save — storage may be full or disabled.");
  }
}

let state = loadData();

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

// ============================================================
// ROUGH MOMENT — one-tap real-time capture
// ============================================================
let pendingMomentId = null;
let selectedMomentTag = null;

document.getElementById("momentBtn").addEventListener("click", () => {
  const m = { id: uid(), timestamp: new Date().toISOString(), tag: null, recovery: null, note: "" };
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
});

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
  const map = { tired: "Tired", hungry: "Hungry", transition: "Transition", overwhelmed: "Overwhelm", sensory: "Sensory", unknown: "Not sure" };
  return tag ? map[tag] || tag : "no tag added";
}
function recoveryLabel(r) {
  const map = { quick: "recovered quickly", slow: "took longer to settle", unsure: "recovery unclear" };
  return r ? map[r] : null;
}

function momentNode(m) {
  const div = document.createElement("div");
  div.className = "log-entry";
  const rec = recoveryLabel(m.recovery);
  div.innerHTML = `
    <div class="lt">${new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
    <div class="ld">Rough moment</div>
    <div class="tagline">${tagLabel(m.tag)}${rec ? " · " + rec : ""}${m.note ? `<div class="moment-note">${escapeHtml(m.note)}</div>` : ""}</div>
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
    if (e.meals) rec.factors["all_meals_eaten"] = e.meals.length >= 3 ? "yes" : "no";
  });
  const sickDates = new Set(state.sickDays.map((entry) => entry.date));
  return Object.values(byDate).filter((day) => !sickDates.has(day.date));
}

// ============================================================
// STATS ENGINE — deterministic, evidence-gated
// (MVP simplification: no recency decay or holdout split yet —
//  see README "Next steps for the stats engine".)
// ============================================================
function computePatterns() {
  const days = buildDayRecords();
  const factorKeys = new Set();
  days.forEach((d) => Object.keys(d.factors).forEach((k) => factorKeys.add(k)));

  const results = [];
  factorKeys.forEach((key) => {
    const groups = {};
    days.forEach((d) => {
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
        results.push({ factor: key, higherVal, lowerVal, higherRate, lowerRate, nHigher, nLower, diff, confidence });
      }
    }
  });
  results.sort((a, b) => b.diff - a.diff);
  return { results, totalDays: days.length };
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
};
const VALUE_LABELS = {
  short: "under 10 hours", adequate: "10+ hours",
  frequent: "2 or more", few: "0–1",
  yes: "yes", no: "no",
  none: "none", under30: "under 30 min", "30to60": "30–60 min", over60: "over 60 min",
  under15: "under 15 min", "15to45": "15–45 min", over45: "over 45 min",
  some: "some", alot: "a lot",
};
function renderUnderstanding() {
  const zone = document.getElementById("understandZone");
  const { results, totalDays } = computePatterns();

  if (totalDays < 7) {
    zone.innerHTML = `
      <div class="card theory-card">
        <span class="confidence-tag">still learning</span>
        <div class="theory-line">Attune needs a couple weeks of logging before it can say anything trustworthy — right now there's ${totalDays} day${totalDays === 1 ? "" : "s"} of data. Guessing early would just be noise dressed up as insight.</div>
        <div class="evidence-line">Keep tapping "Rough Moment" when it happens, and fill in the two daily check-ins — that's genuinely the whole job for now.</div>
      </div>
    `;
    return;
  }

  if (results.length === 0) {
    zone.innerHTML = `
      <div class="card theory-card">
        <span class="confidence-tag">still learning</span>
        <div class="theory-line">${totalDays} days logged, and nothing has separated itself clearly yet from day-to-day noise. That's a fine, honest place to be.</div>
        <div class="evidence-line">Keep going — real patterns need enough days on both sides of a comparison (at least ${MIN_N} each) before Attune will say anything.</div>
      </div>
    `;
    return;
  }

  const top = results[0];
  const factorLabel = FACTOR_LABELS[top.factor] || top.factor;
  const higherLabel = VALUE_LABELS[top.higherVal] || top.higherVal;
  const lowerLabel = VALUE_LABELS[top.lowerVal] || top.lowerVal;
  const pctHigher = Math.round(top.higherRate * 100);
  const pctLower = Math.round(top.lowerRate * 100);
  const confidenceDisplay = { weak_early_signal: "weak early signal", emerging_pattern: "emerging pattern", strong_pattern: "strong pattern" }[top.confidence];

  zone.innerHTML = `
    <div class="card theory-card">
      <span class="confidence-tag">${confidenceDisplay}</span>
      <div class="theory-line">Rough moments have shown up more when <strong>${factorLabel}</strong> was <strong>${higherLabel}</strong>, compared with <strong>${lowerLabel}</strong>.</div>
      <div class="evidence-line">${pctHigher}% of ${top.nHigher} days like that had a rough moment, vs. ${pctLower}% of ${top.nLower} days on the other side. ${top.confidence === "weak_early_signal" ? "Early days — worth watching, not acting on hard yet." : ""}</div>
      <div class="try-box">
        <span class="lbl">Worth trying</span>
        Over the next few comparable days, notice what happens when ${factorLabel} is ${lowerLabel} versus ${higherLabel}. Keep the rest of the routine similar when practical—no need to force a change.
      </div>
      <div class="try-box">
        <span class="lbl">How you'll know</span>
        The difference shows up again across several days, rather than disappearing with the next observation. Attune will keep counting both outcomes.
      </div>
    </div>
    ${results.length > 1 ? `<div class="section-title">Other early signals (${results.length - 1})</div>` : ""}
    ${results.slice(1, 4).map((r) => `
      <div class="card">
        <span class="eyebrow">${{ weak_early_signal: "weak early signal", emerging_pattern: "emerging pattern", strong_pattern: "strong pattern" }[r.confidence]}</span>
        <div style="font-size:0.88rem; color:var(--text-muted);">${FACTOR_LABELS[r.factor] || r.factor}: ${VALUE_LABELS[r.higherVal] || r.higherVal} vs ${VALUE_LABELS[r.lowerVal] || r.lowerVal} (${r.nHigher}/${r.nLower} days)</div>
      </div>
    `).join("")}
  `;
}

// ============================================================
// INIT
// ============================================================
renderTodayStatus();
