// Food & fitness – client for /fitness/ (netlify/functions/fitness.mjs, /api/fitness).
// A diary per person, like the big calorie-counting apps: each day's food in four meals
// (breakfast, lunch, snacks, dinner), exercise, and calories and macros left against goals
// worked out from body details and a weight goal. Food can come from a photo or a
// description that Claude recognises (/api/food-scan), from foods logged before, or be
// typed in. 📈 Progress shows weight against the goal and recent calories.

import {
  $, esc, store, localToday, fmtDay, timeAgo, toast, myName, setupIdentity, createSync,
  fetchJson, postJson,
} from "/common.js";

const MEALS = [
  { id: "breakfast", name: "Breakfast", emoji: "🌅" },
  { id: "lunch", name: "Lunch", emoji: "🍱" },
  { id: "snacks", name: "Snacks", emoji: "🍎" },
  { id: "dinner", name: "Dinner", emoji: "🍲" },
];
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very: 1.9 };
// Rough MET values for working out calories burned when none are given.
const EXERCISES = [
  ["🚶", "Walking", 3.5], ["🏃", "Running", 9.8], ["🚴", "Cycling", 7.5], ["🏋️", "Gym / weights", 5],
  ["🏊", "Swimming", 7], ["🧘", "Yoga / pilates", 3], ["🏸", "Badminton", 5.5], ["🔥", "HIIT", 8],
];
const KCAL_PER_KG = 7700;

let doc = null;
let screen = "diary";
let day = localToday();
let who = store.get("fitness.person") || "";
let review = []; // foods waiting to be logged in the add dialog
let editing = null; // food being edited
let scanRun = 0; // the latest recognise request, so an older answer can be ignored

const sync = createSync({
  path: "/api/fitness",
  schema: 1,
  onDoc(next) {
    doc = next;
    render();
  },
});

// ---------------------------------------------------------------- helpers

const r0 = (v) => Math.round(Number(v) || 0);
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const fmt = (v) => r0(v).toLocaleString("en-US");
const g = (v) => `${r1(v)}g`;
const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
};
const shiftDay = (iso, by) => new Date(Date.parse(iso + "T00:00:00Z") + by * 86400000).toISOString().slice(0, 10);
const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, "");

// The listed person this device's name belongs to ("Karstin Bok" -> Karstin).
function me() {
  const n = norm(myName());
  return doc.people.find((p) => n && (norm(p) === n || n.startsWith(norm(p)) || norm(p).startsWith(n))) ?? null;
}

const foodsOn = (d, p = who) => doc.foods.filter((f) => f.person === p && f.date === d);
const exercisesOn = (d, p = who) => doc.exercises.filter((x) => x.person === p && x.date === d);
const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);

function weighIns(p = who) {
  return doc.weights.filter((w) => w.person === p).sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
}
const latestWeight = (p = who, onOrBefore = "9999") => weighIns(p).filter((w) => w.date <= onOrBefore).at(-1) ?? null;

// Daily targets from the profile: Mifflin-St Jeor BMR x activity, plus the weekly goal.
function targets(p = who, onDay = day) {
  const pr = doc.profiles[p] ?? {};
  const w = latestWeight(p, onDay)?.kg ?? null;
  const age = pr.birthYear ? new Date().getFullYear() - pr.birthYear : null;
  let calc = null;
  if (w && pr.heightCm && age) {
    const bmr = 10 * w + 6.25 * pr.heightCm - 5 * age + (pr.sex === "male" ? 5 : pr.sex === "female" ? -161 : -78);
    const tdee = bmr * (ACTIVITY[pr.activity] ?? 1.375);
    const floor = pr.sex === "male" ? 1500 : 1200;
    calc = { bmr: r0(bmr), tdee: r0(tdee), kcal: Math.max(floor, Math.round((tdee + ((pr.weeklyKg ?? 0) * KCAL_PER_KG) / 7) / 10) * 10), floor };
  }
  const kcal = pr.kcalTarget || calc?.kcal || 2000;
  const m = pr.macros ?? { p: 30, c: 40, f: 30 };
  return {
    kcal, calc, set: !!(pr.kcalTarget || calc),
    p: (kcal * m.p) / 100 / 4, c: (kcal * m.c) / 100 / 4, f: (kcal * m.f) / 100 / 9, pct: m,
  };
}

function dayLabel(d) {
  const today = localToday();
  const name = d === today ? "Today" : d === shiftDay(today, -1) ? "Yesterday" : d === shiftDay(today, 1) ? "Tomorrow" : null;
  return name ? `${name}, ${fmtDay(d, { month: "short", day: "numeric" })}` : fmtDay(d, { weekday: "long", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!doc) return;
  if (!doc.people.includes(who)) who = me() ?? doc.people[0];
  for (const el of document.querySelectorAll("[data-only]")) el.hidden = el.dataset.only !== screen;
  for (const a of document.querySelectorAll(".screen-tabs a[data-screen]")) {
    a.classList.toggle("active", a.dataset.screen === screen);
    if (a.dataset.screen === screen) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("#personPick").innerHTML = doc.people.map((p) => `<label><input type="radio" name="who" value="${esc(p)}"
    ${p === who ? "checked" : ""} /><span>${esc(p)}</span></label>`).join("");
  $("#subtitle").textContent = `${who}'s ${screen === "diary" ? "food diary" : "progress"}`;
  if (screen === "diary") renderDiary();
  else renderProgress();
  renderLog();
}

function renderDiary() {
  $("#dayTitle").textContent = dayLabel(day);
  $("#dayInput").value = day;
  const foods = foodsOn(day);
  const ex = exercisesOn(day);
  const t = targets();
  const eaten = sum(foods, "kcal");
  const burned = sum(ex, "kcal");
  const left = t.kcal - eaten + burned;
  $("#kcalEq").innerHTML = `
    <div><b>${fmt(t.kcal)}</b><span>Goal</span></div><i>−</i>
    <div><b>${fmt(eaten)}</b><span>Food</span></div><i>+</i>
    <div><b>${fmt(burned)}</b><span>Exercise</span></div><i>=</i>
    <div class="left ${left < 0 ? "over" : ""}"><b>${fmt(left)}</b><span>${left < 0 ? "Over" : "Remaining"}</span></div>`;
  const pct = Math.min(100, (eaten / (t.kcal + burned || 1)) * 100);
  $("#kcalMeter").classList.toggle("over", left < 0);
  $("#kcalMeter span").style.width = `${pct}%`;
  $("#macroBars").innerHTML = [["p", "Protein"], ["c", "Carbs"], ["f", "Fat"]].map(([k, name]) => {
    const have = sum(foods, k);
    const want = t[k];
    return `<div class="macro macro-${k}"><div class="macro-top"><b>${name}</b><span>${fmt(have)} / ${fmt(want)}g</span></div>
      <div class="meter ${have > want * 1.05 ? "over" : ""}"><span style="width:${Math.min(100, (have / (want || 1)) * 100)}%"></span></div>
      <span class="muted small">${have <= want ? `${fmt(want - have)}g left` : `${fmt(have - want)}g over`}</span></div>`;
  }).join("");
  $("#goalHint").innerHTML = t.set ? "" : `Using a standard 2,000 kcal goal. <button type="button" class="linkish" data-open-goals>Set ${esc(who)}'s goals</button> for a personal one.`;

  for (const m of MEALS) {
    const list = foods.filter((f) => f.meal === m.id).sort((a, b) => a.t - b.t);
    const el = document.querySelector(`.meal[data-meal="${m.id}"]`);
    el.innerHTML = `
      <div class="meal-head"><h2>${m.emoji} ${m.name}</h2><span class="meal-kcal">${list.length ? `${fmt(sum(list, "kcal"))} kcal` : ""}</span></div>
      ${list.length ? `<ul class="items-list food-list">${list.map(foodRow).join("")}</ul>
        <p class="meal-macros muted small">P ${g(sum(list, "p"))} · C ${g(sum(list, "c"))} · F ${g(sum(list, "f"))}</p>` : ""}
      <button type="button" class="btn ghost meal-add" data-add-food="${m.id}">＋ Add food</button>`;
  }

  $("#exerciseKcal").textContent = ex.length ? `${fmt(burned)} kcal` : "";
  $("#exerciseList").innerHTML = ex.map((x) => `<li>
    <div class="item-main"><span class="item-note"><b>${esc(x.name)}</b>${x.note ? ` · ${esc(x.note)}` : ""}</span>
      <span class="item-meta">${x.minutes} min · added by ${esc(x.by)} ${timeAgo(x.t)}</span></div>
    <div class="item-amt">${fmt(x.kcal)} kcal</div>
    <button type="button" class="icon-btn" data-del-ex="${esc(x.id)}" title="Delete" aria-label="Delete ${esc(x.name)}">🗑</button>
  </li>`).join("");

  const w = latestWeight(who, day);
  const goal = doc.profiles[who]?.goalKg;
  $("#weighNow").innerHTML = w
    ? `<b>${w.kg} kg</b> <span class="muted small">on ${fmtDay(w.date)}${goal ? ` · ${r1(Math.abs(w.kg - goal))} kg ${w.kg > goal ? "to lose" : w.kg < goal ? "to gain" : "— at goal 🎉"}` : ""}</span>`
    : `<span class="muted">No weigh-ins yet.</span>`;
}

function foodRow(f) {
  const tag = f.source === "photo" ? "📷 " : f.source === "describe" ? "✨ " : "";
  return `<li class="food-row" data-edit-food="${esc(f.id)}" tabindex="0" role="button" aria-label="Edit ${esc(f.name)}">
    <div class="item-main">
      <span class="item-note">${tag}<b>${esc(f.name)}</b></span>
      <span class="item-meta">${[f.amount, f.grams ? `${fmt(f.grams)} g` : ""].filter(Boolean).map(esc).join(" · ")}${f.amount || f.grams ? " · " : ""}P ${g(f.p)} · C ${g(f.c)} · F ${g(f.f)}</span>
    </div>
    <div class="item-amt">${fmt(f.kcal)}</div>
  </li>`;
}

// ---------------------------------------------------------------- progress

function renderProgress() {
  const ws = weighIns();
  const pr = doc.profiles[who] ?? {};
  const t = targets(who, localToday());
  const cur = ws.at(-1);
  const first = ws[0];
  $("#pCurrent").textContent = cur ? `${cur.kg} kg` : "—";
  $("#pCurrentSub").textContent = cur
    ? (first && first !== cur ? `${cur.kg - first.kg > 0 ? "+" : ""}${r1(cur.kg - first.kg)} kg since ${fmtDay(first.date, { month: "short", day: "numeric" })}` : `on ${fmtDay(cur.date)}`)
    : "Log your weight on the diary";
  $("#pGoal").textContent = pr.goalKg ? `${pr.goalKg} kg` : "—";
  if (pr.goalKg && cur) {
    const diff = r1(cur.kg - pr.goalKg);
    const rate = Math.abs(pr.weeklyKg || 0);
    const weeks = rate && Math.sign(-diff) === Math.sign(pr.weeklyKg) ? Math.ceil(Math.abs(diff) / rate) : null;
    const when = weeks ? new Date(Date.now() + weeks * 7 * 86400000).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : null;
    $("#pGoalSub").textContent = diff === 0 ? "You're there 🎉" : `${Math.abs(diff)} kg to ${diff > 0 ? "lose" : "gain"}${when ? ` · around ${when}` : ""}`;
  } else $("#pGoalSub").textContent = "Set it in 🎯 Goals";
  $("#pKcal").textContent = `${fmt(t.kcal)} kcal`;
  $("#pKcalSub").textContent = `P ${fmt(t.p)}g · C ${fmt(t.c)}g · F ${fmt(t.f)}g${t.set ? "" : " (standard)"}`;

  const last14 = Array.from({ length: 14 }, (_, n) => shiftDay(localToday(), n - 13));
  const byDay = last14.map((d) => ({ d, kcal: sum(foodsOn(d), "kcal"), burned: sum(exercisesOn(d), "kcal"), goal: targets(who, d).kcal }));
  const logged7 = byDay.slice(7).filter((x) => x.kcal > 0);
  const avg = logged7.length ? sum(logged7, "kcal") / logged7.length : 0;
  $("#pWeek").textContent = logged7.length ? `${fmt(avg)} kcal` : "—";
  const net = logged7.reduce((s, x) => s + (x.kcal - x.burned - x.goal), 0);
  $("#pWeekSub").textContent = logged7.length
    ? `a day on average, over ${logged7.length} logged day${logged7.length === 1 ? "" : "s"} · ${fmt(Math.abs(net))} kcal ${net > 0 ? "over" : "under"} goal`
    : "Nothing logged this week";

  renderWeightChart(ws, pr.goalKg);
  renderKcalBars(byDay);
  const foods14 = doc.foods.filter((f) => f.person === who && f.date >= last14[0]);
  const days14 = new Set(foods14.map((f) => f.date)).size;
  $("#macroAvg").textContent = days14
    ? `Average on logged days: P ${fmt(sum(foods14, "p") / days14)}g · C ${fmt(sum(foods14, "c") / days14)}g · F ${fmt(sum(foods14, "f") / days14)}g`
    : "";

  $("#weightList").innerHTML = [...ws].reverse().slice(0, 60).map((w, n, arr) => {
    const prev = arr[n + 1];
    const d = prev ? r1(w.kg - prev.kg) : null;
    return `<li><div class="item-main"><span class="item-note"><b>${w.kg} kg</b>${d ? ` <span class="muted small">${d > 0 ? "+" : ""}${d}</span>` : ""}</span>
      <span class="item-meta">${fmtDay(w.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span></div>
      <button type="button" class="icon-btn" data-del-weight="${esc(w.id)}" title="Delete" aria-label="Delete weigh-in">🗑</button></li>`;
  }).join("") || `<li class="muted small">No weigh-ins yet.</li>`;
}

function renderWeightChart(ws, goal) {
  const svg = $("#weightChart");
  const title = svg.querySelector("title").outerHTML;
  const days = Number(document.querySelector('input[name="range"]:checked')?.value ?? 90);
  const from = shiftDay(localToday(), -days);
  const pts = ws.filter((w) => w.date >= from);
  $("#weightRange").textContent = pts.length ? `${fmtDay(pts[0].date, { month: "short", day: "numeric" })} – ${fmtDay(pts.at(-1).date, { month: "short", day: "numeric" })}` : "";
  if (!pts.length) {
    svg.innerHTML = `${title}<text x="300" y="120" text-anchor="middle" class="chart-empty">No weigh-ins in this period</text>`;
    return;
  }
  const vals = pts.map((w) => w.kg).concat(goal ? [goal] : []);
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const W = 600, H = 240, L = 52, R = 12, T = 16, B = 30;
  const t0 = Date.parse(from), t1 = Date.parse(localToday());
  const x = (d) => L + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + ((hi - v) / (hi - lo || 1)) * (H - T - B);
  const ticks = [hi, (hi + lo) / 2, lo];
  const line = pts.map((w, n) => `${n ? "L" : "M"}${x(w.date).toFixed(1)},${y(w.kg).toFixed(1)}`).join("");
  svg.innerHTML = title +
    ticks.map((v) => `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" /><text class="chart-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${r1(v)}</text>`).join("") +
    (goal ? `<line class="chart-goal" x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}" /><text class="chart-goal-label" x="${W - R}" y="${y(goal) - 5}" text-anchor="end">Goal ${goal} kg</text>` : "") +
    `<path class="chart-line" d="${line}" />` +
    pts.map((w) => `<circle class="chart-dot" cx="${x(w.date)}" cy="${y(w.kg)}" r="3.5"><title>${fmtDay(w.date)}: ${w.kg} kg</title></circle>`).join("") +
    `<text class="chart-axis" x="${L}" y="${H - 6}">${fmtDay(from, { month: "short", day: "numeric" })}</text><text class="chart-axis" x="${W - R}" y="${H - 6}" text-anchor="end">Today</text>`;
}

function showTip(html, x, y) {
  const tip = $("#vizTip");
  tip.innerHTML = html;
  tip.hidden = false;
  const box = tip.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(x - box.left, 60), box.width - 60)}px`;
  tip.style.top = `${y - box.top}px`;
}

function renderKcalBars(byDay) {
  const max = Math.max(...byDay.map((x) => Math.max(x.kcal, x.goal + x.burned)), 1);
  const top = Math.ceil(max / 500) * 500;
  const el = $("#kcalBars");
  el.innerHTML = `
    <div class="db-axis">${[top, top / 2, 0].map((t) => `<span>${fmt(t)}</span>`).join("")}</div>
    <div class="db-plot">${[top, top / 2, 0].map((t) => `<i class="db-grid" style="bottom:${(t / top) * 100}%"></i>`).join("")}
      ${byDay.map((x) => `<button type="button" class="db-col${x.d === localToday() ? " today" : ""}${x.kcal > x.goal + x.burned ? " over" : ""}" data-day="${x.d}" aria-label="${fmtDay(x.d)}: ${fmt(x.kcal)} kcal">
        <span class="db-bar" style="height:${x.kcal ? Math.max((x.kcal / top) * 100, 1.5) : 0}%"></span>
        <span class="db-goal" style="bottom:${((x.goal + x.burned) / top) * 100}%"></span>
        <span class="db-label">${Number(x.d.slice(8))}</span></button>`).join("")}
    </div>`;
  el.onpointermove = (e) => {
    const col = e.target.closest(".db-col");
    if (!col) return void ($("#vizTip").hidden = true);
    const x = byDay.find((b) => b.d === col.dataset.day);
    const r = col.querySelector(".db-bar").getBoundingClientRect();
    showTip(`<b>${fmtDay(x.d)}</b><br>${fmt(x.kcal)} of ${fmt(x.goal + x.burned)} kcal`, r.left + r.width / 2, r.top);
  };
  el.onpointerleave = () => { $("#vizTip").hidden = true; };
  el.onclick = (e) => {
    const col = e.target.closest(".db-col");
    if (col) { day = col.dataset.day; location.hash = "#diary"; }
  };
}

function renderLog() {
  $("#log").innerHTML = doc.log.slice(0, 40).map((e) =>
    `<li><b>${esc(e.by)}</b> ${esc(e.msg)}<time>${timeAgo(e.t)}</time></li>`).join("") || `<li class="empty">No changes yet.</li>`;
}

// ---------------------------------------------------------------- add food

const foodForm = $("#foodForm");
const src = () => foodForm.querySelector('input[name="src"]:checked').value;
const mealNow = () => foodForm.querySelector('input[name="meal"]:checked')?.value;

// The meal that fits the time of day, for a new entry on today.
function mealForNow() {
  const h = new Date().getHours();
  return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 18 ? "snacks" : "dinner";
}

function mealChips(container, name, selected) {
  $(container).innerHTML = MEALS.map((m) => `<label class="cat-choice"><input type="radio" name="${name}" value="${m.id}"
    ${m.id === selected ? "checked" : ""} required /><span><span class="emoji">${m.emoji}</span>${m.name}</span></label>`).join("");
}

function openFood(meal) {
  if (!doc) return;
  review = [];
  scanRun++;
  mealChips("#mealChoices", "meal", meal || (day === localToday() ? mealForNow() : "lunch"));
  $("#foodTitle").textContent = `Add food · ${who} · ${dayLabel(day)}`;
  const last = store.get("fitness.src") || "photo";
  foodForm.querySelector(`input[name="src"][value="${last}"]`).checked = true;
  photos = [];
  renderPhotos();
  $("#photoText").value = "";
  $("#describeText").value = "";
  $("#recentSearch").value = "";
  for (const id of ["#mName", "#mAmount", "#mKcal", "#mP", "#mC", "#mF"]) $(id).value = "";
  $("#scanStatus").hidden = true;
  showSrc();
  renderReview();
  $("#foodDlg").showModal();
}

function showSrc() {
  for (const p of foodForm.querySelectorAll(".src-pane")) p.hidden = p.dataset.src !== src();
  if (src() === "recent") renderRecent();
}

foodForm.addEventListener("change", (e) => {
  if (e.target.name === "src") { store.set("fitness.src", src()); showSrc(); }
});

// Review list: each food scales with its portion (x1 = as recognised). When its weight is
// known, the portion is set in grams instead.
function renderReview() {
  $("#reviewBox").hidden = !review.length;
  const on = review.filter((r) => r.on);
  const kcal = on.reduce((s, r) => s + r.kcal * r.x, 0);
  $("#foodSubmit").disabled = !on.length;
  $("#foodSubmit").textContent = on.length ? `Log ${on.length} food${on.length === 1 ? "" : "s"} · ${fmt(kcal)} kcal` : "Log food";
  $("#reviewTotal").textContent = on.length > 1
    ? `Total: ${fmt(kcal)} kcal · P ${g(on.reduce((s, r) => s + r.p * r.x, 0))} · C ${g(on.reduce((s, r) => s + r.c * r.x, 0))} · F ${g(on.reduce((s, r) => s + r.f * r.x, 0))}`
    : "";
  const open = new Set([...$("#reviewList").querySelectorAll("details[open]")].map((d) => d.closest("li").dataset.n));
  $("#reviewList").innerHTML = review.map((r, n) => `<li class="${r.on ? "" : "off"}" data-n="${n}">
    <label class="rv-check"><input type="checkbox" data-k="on" ${r.on ? "checked" : ""} aria-label="Log ${esc(r.name)}" /></label>
    <div class="rv-main">
      <input class="rv-name" data-k="name" value="${esc(r.name)}" maxlength="80" aria-label="Food name" />
      <div class="rv-sub">
        <input class="rv-amount" data-k="amount" value="${esc(r.amount)}" maxlength="60" placeholder="Amount" aria-label="Amount" />
        ${r.grams
          ? `<label class="rv-x"><input data-k="grams" inputmode="decimal" value="${r0(r.grams * r.x)}" aria-label="Weight in grams" /> g</label>`
          : `<label class="rv-x">× <input data-k="x" inputmode="decimal" value="${r.x}" aria-label="Portions" /></label>`}
      </div>
      <div class="rv-nums">
        <label><input data-k="kcal" inputmode="decimal" value="${r0(r.kcal * r.x)}" /><span>kcal</span></label>
        <label><input data-k="p" inputmode="decimal" value="${r1(r.p * r.x)}" /><span>P g</span></label>
        <label><input data-k="c" inputmode="decimal" value="${r1(r.c * r.x)}" /><span>C g</span></label>
        <label><input data-k="f" inputmode="decimal" value="${r1(r.f * r.x)}" /><span>F g</span></label>
      </div>
      ${r.confidence ? `<span class="rv-src muted small"><span class="conf conf-${r.confidence}">${r.confidence === "high" ? "Exact" : r.confidence === "medium" ? "Database values" : "Rough estimate"}</span>
        ${r.ref ? (r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.ref)} ↗</a>` : ` ${esc(r.ref)}`) : ""}</span>` : ""}
      ${r.ingredients?.length ? ingredientList(r.ingredients, r.x, open.has(String(n))) : ""}
    </div>
    <button type="button" class="icon-btn" data-rv-remove title="Remove" aria-label="Remove ${esc(r.name)}">✕</button>
  </li>`).join("");
}

// How a dish was worked out: each ingredient's estimated weight and nutrition, with its source.
function ingredientList(list, x = 1, open = false) {
  return `<details class="ingredients"${open ? " open" : ""}><summary>How it was worked out: ${list.length} ingredient${list.length === 1 ? "" : "s"}</summary>
    <table><thead><tr><th>Ingredient</th><th>g</th><th>kcal</th><th>P</th><th>C</th><th>F</th></tr></thead><tbody>
    ${list.map((i) => `<tr><td>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.source || "Source")}">${esc(i.name)} ↗</a>` : esc(i.name)}</td>
      <td>${fmt(i.grams * x)}</td><td>${fmt(i.kcal * x)}</td><td>${r1(i.p * x)}</td><td>${r1(i.c * x)}</td><td>${r1(i.f * x)}</td></tr>`).join("")}
    </tbody></table></details>`;
}

$("#reviewList").addEventListener("change", (e) => {
  const li = e.target.closest("li[data-n]");
  const k = e.target.dataset.k;
  if (!li || !k) return;
  const r = review[Number(li.dataset.n)];
  if (k === "on") r.on = e.target.checked;
  else if (k === "name" || k === "amount") r[k] = e.target.value;
  else if (k === "x") {
    const x = num(e.target.value);
    if (x > 0 && x <= 20) r.x = x;
  } else if (k === "grams") {
    const grams = num(e.target.value);
    if (grams > 0 && grams <= 20 * r.grams) r.x = grams / r.grams;
  } else {
    const v = num(e.target.value);
    if (v >= 0) r[k] = v / r.x; // typed numbers are for the whole portion
  }
  renderReview();
});
$("#reviewList").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-n]");
  if (li && e.target.closest("[data-rv-remove]")) { review.splice(Number(li.dataset.n), 1); renderReview(); }
});

function addToReview(items, source) {
  // source: how it was added (photo, describe, recent, manual); i.source from a scan is where
  // its numbers came from, shown as `ref`.
  for (const i of items) {
    review.push({
      on: true, x: 1, source, name: i.name, amount: i.amount ?? "",
      kcal: Number(i.kcal) || 0, p: Number(i.p) || 0, c: Number(i.c) || 0, f: Number(i.f) || 0,
      fiber: i.fiber, sugar: i.sugar, sodium: i.sodium, grams: Number(i.grams) || 0,
      ingredients: i.ingredients ?? [],
      confidence: i.confidence,
      ref: source === "photo" || source === "describe" ? i.source : i.refName ?? "",
      url: source === "photo" || source === "describe" ? i.url : i.ref ?? "",
    });
  }
  renderReview();
}

// Recognition: photo and/or words go to Claude in the background; poll for the answer.
async function recognise({ images = [], text }) {
  const run = ++scanRun;
  const status = $("#scanStatus");
  const set = (html, cls = "") => { status.hidden = false; status.className = `scan-status ${cls}`; status.innerHTML = html; };
  set(`<span class="spinner" aria-hidden="true"></span> Claude is identifying the food and estimating each ingredient's weight…`);
  for (const b of document.querySelectorAll("#photoGo, #describeGo")) b.disabled = true;
  try {
    const { id } = await postJson("/api/food-scan", { images, text, meal: mealNow() });
    const started = Date.now();
    let res;
    do {
      await new Promise((r) => setTimeout(r, 2000));
      if (run !== scanRun) return;
      res = await fetchJson(`/api/food-scan?id=${encodeURIComponent(id)}`);
      if (Date.now() - started > 20000 && res.status === "pending") set(`<span class="spinner" aria-hidden="true"></span> Looking up each ingredient in USDA FoodData Central, Open Food Facts and online. This can take a minute or two…`);
    } while (res.status === "pending" && Date.now() - started < 7 * 60000);
    if (run !== scanRun) return;
    if (res.status !== "done") throw new Error(res.error || "Couldn't recognise the food. Try again.");
    status.hidden = true;
    addToReview(res.items, images.length ? "photo" : "describe");
    $("#reviewNote").textContent = res.note || "";
    $("#reviewBox").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (err) {
    if (run === scanRun) set(`⚠️ ${esc(err.message)}`, "error");
  } finally {
    if (run === scanRun) for (const b of document.querySelectorAll("#photoGo, #describeGo")) b.disabled = false;
  }
}

// Shrinks a photo to at most 1400 px on its longer side, as JPEG, before uploading.
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That file isn't a photo this browser can read. Try a JPEG or PNG.");
  const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// Up to 3 photos per recognition: data URLs, shown as thumbnails that can be removed.
let photos = [];
function renderPhotos() {
  $("#photoStrip").innerHTML = photos.map((p, n) => `<figure><img src="${p}" alt="Photo ${n + 1}" />
    <button type="button" class="photo-x" data-photo-x="${n}" aria-label="Remove photo ${n + 1}">✕</button></figure>`).join("");
  for (const b of document.querySelectorAll(".photo-btn")) b.classList.toggle("disabled", photos.length >= 3);
}
async function addPhotos(input) {
  const files = [...input.files];
  input.value = "";
  for (const file of files) {
    if (photos.length >= 3) { toast("Up to 3 photos at a time"); break; }
    try {
      photos.push(await shrinkPhoto(file));
    } catch (err) {
      toast(err.message);
    }
  }
  renderPhotos();
}
$("#cameraInput").addEventListener("change", (e) => addPhotos(e.target));
$("#galleryInput").addEventListener("change", (e) => addPhotos(e.target));
$("#photoStrip").addEventListener("click", (e) => {
  const x = e.target.closest("[data-photo-x]");
  if (x) { photos.splice(Number(x.dataset.photoX), 1); renderPhotos(); }
});
$("#photoGo").addEventListener("click", () => {
  if (!photos.length) return toast("Take or choose a photo first");
  recognise({ images: photos.map((p) => ({ data: p.split(",")[1], mediaType: "image/jpeg" })), text: $("#photoText").value.trim() });
});
$("#describeGo").addEventListener("click", () => {
  const text = $("#describeText").value.trim();
  if (!text) return toast("Describe what you ate first");
  recognise({ text });
});

// Foods this person logged before, newest first, one per name and amount.
function renderRecent() {
  const q = norm($("#recentSearch").value);
  const seen = new Set();
  const list = [];
  for (const f of [...doc.foods].filter((x) => x.person === who).sort((a, b) => b.t - a.t)) {
    const key = `${norm(f.name)}|${norm(f.amount)}`;
    if (seen.has(key) || (q && !norm(f.name).includes(q))) continue;
    seen.add(key);
    list.push(f);
    if (list.length >= 40) break;
  }
  $("#recentList").innerHTML = list.map((f) => `<li data-recent="${esc(f.id)}" role="button" tabindex="0">
    <div class="item-main"><span class="item-note"><b>${esc(f.name)}</b></span>
      <span class="item-meta">${f.amount ? `${esc(f.amount)} · ` : ""}P ${g(f.p)} · C ${g(f.c)} · F ${g(f.f)}</span></div>
    <div class="item-amt">${fmt(f.kcal)}</div><span class="recent-add" aria-hidden="true">＋</span></li>`).join("")
    || `<li class="muted small">${q ? "No match." : "Foods you log will show up here, ready to add again."}</li>`;
}
$("#recentSearch").addEventListener("input", renderRecent);
$("#recentList").addEventListener("click", (e) => {
  const li = e.target.closest("[data-recent]");
  if (!li) return;
  const f = doc.foods.find((x) => x.id === li.dataset.recent);
  if (f) { addToReview([f], "recent"); toast(`Added ${f.name} to the list`); }
});

$("#manualAdd").addEventListener("click", () => {
  const name = $("#mName").value.trim();
  const kcal = num($("#mKcal").value);
  if (!name) return toast("Name the food");
  if (!(kcal >= 0)) return toast("Enter the calories");
  addToReview([{ name, amount: $("#mAmount").value.trim(), kcal, p: num($("#mP").value) || 0, c: num($("#mC").value) || 0, f: num($("#mF").value) || 0 }], "manual");
  for (const id of ["#mName", "#mAmount", "#mKcal", "#mP", "#mC", "#mF"]) $(id).value = "";
});

foodForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const foods = review.filter((r) => r.on).map((r) => ({
    name: r.name.trim() || "Food", source: r.source,
    amount: r.x !== 1 && !r.grams ? `${r.amount.trim() || "1 portion"} × ${r.x}` : r.amount.trim(),
    kcal: r0(r.kcal * r.x), p: r1(r.p * r.x), c: r1(r.c * r.x), f: r1(r.f * r.x),
    ...(r.fiber ? { fiber: r1(r.fiber * r.x) } : {}), ...(r.sugar ? { sugar: r1(r.sugar * r.x) } : {}), ...(r.sodium ? { sodium: r0(r.sodium * r.x) } : {}),
    ...(r.grams ? { grams: r0(r.grams * r.x) } : {}),
    ...(r.url ? { ref: r.url, refName: r.ref } : {}),
    ...(r.ingredients?.length ? { ingredients: r.ingredients.map((i) => ({
      name: i.name, grams: r0(i.grams * r.x), kcal: r0(i.kcal * r.x), p: r1(i.p * r.x), c: r1(i.c * r.x), f: r1(i.f * r.x),
      ...(i.url ? { url: i.url } : {}), ...(i.source ? { source: i.source } : {}),
    })) } : {}),
  }));
  if (!foods.length) return;
  const meal = mealNow();
  const btn = $("#foodSubmit");
  btn.disabled = true;
  const ok = await sync.runOp({ op: "addFoods", person: who, date: day, meal, foods },
    `Logged ${fmt(sum(foods, "kcal"))} kcal to ${MEALS.find((m) => m.id === meal).name.toLowerCase()}`);
  btn.disabled = false;
  if (ok) { scanRun++; $("#foodDlg").close(); }
});
$("#foodCancel").addEventListener("click", () => { scanRun++; $("#foodDlg").close(); });

// ---------------------------------------------------------------- edit a logged food

const editForm = $("#editForm");
function openEdit(f) {
  editing = f;
  mealChips("#editMeals", "editMeal", f.meal);
  for (const k of ["name", "amount", "kcal", "p", "c", "f"]) editForm.elements[k].value = f[k] ?? "";
  const extra = [f.fiber ? `fibre ${g(f.fiber)}` : "", f.sugar ? `sugar ${g(f.sugar)}` : "", f.sodium ? `sodium ${fmt(f.sodium)} mg` : ""].filter(Boolean).join(" · ");
  $("#editMeta").innerHTML = `${f.grams ? `About ${fmt(f.grams)} g. ` : ""}${esc(extra)}${extra ? ". " : ""}${f.ref ? `Source: <a href="${esc(f.ref)}" target="_blank" rel="noopener">${esc(f.refName || "link")} ↗</a>. ` : ""}Added by ${esc(f.by)} ${timeAgo(f.t)}${f.editedBy ? `, edited by ${esc(f.editedBy)}` : ""}.`
    + (f.ingredients?.length ? ingredientList(f.ingredients) : "");
  $("#editDlg").showModal();
}
editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = (k) => editForm.elements[k].value;
  if (await sync.runOp({ op: "updateFood", id: editing.id, meal: editForm.querySelector('input[name="editMeal"]:checked')?.value,
    name: v("name"), amount: v("amount"), kcal: num(v("kcal")), p: num(v("p")) || 0, c: num(v("c")) || 0, f: num(v("f")) || 0,
    fiber: editing.fiber, sugar: editing.sugar, sodium: editing.sodium }, "Saved")) $("#editDlg").close();
});
$("#editDelete").addEventListener("click", async () => {
  if (await sync.runOp({ op: "deleteFood", id: editing.id }, `Removed ${editing.name}`)) $("#editDlg").close();
});
$("#editCancel").addEventListener("click", () => $("#editDlg").close());

// ---------------------------------------------------------------- exercise and weight

const exForm = $("#exForm");
function exEstimate() {
  const name = exForm.elements.name.value.trim().toLowerCase();
  const met = EXERCISES.find(([, n]) => n.toLowerCase() === name)?.[2] ?? 5;
  const kg = latestWeight()?.kg;
  const min = num(exForm.elements.minutes.value);
  return kg && min > 0 ? r0((met * kg * min) / 60) : null;
}
function updateExHint() {
  const est = exEstimate();
  $("#exHint").textContent = exForm.elements.kcal.value.trim() ? ""
    : est ? `About ${fmt(est)} kcal for ${who} at ${latestWeight().kg} kg. Enter your watch's number to use that instead.`
      : latestWeight() ? "" : "Log your weight to have calories burned worked out for you.";
}
$("#addExercise").addEventListener("click", () => {
  exForm.reset();
  $("#exChoices").innerHTML = EXERCISES.map(([e, n]) => `<label class="cat-choice"><input type="radio" name="exPick" value="${esc(n)}" /><span><span class="emoji">${e}</span>${esc(n)}</span></label>`).join("");
  updateExHint();
  $("#exDlg").showModal();
});
exForm.addEventListener("input", (e) => {
  if (e.target.name === "exPick") exForm.elements.name.value = e.target.value;
  updateExHint();
});
exForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = exForm.elements;
  const minutes = num(f.minutes.value);
  if (!(minutes > 0)) return toast("Enter the minutes");
  const kcal = f.kcal.value.trim() ? num(f.kcal.value) : exEstimate();
  if (!(kcal >= 0)) return toast("Enter the calories burned, or log your weight so they can be worked out");
  if (await sync.runOp({ op: "addExercise", person: who, date: day, name: f.name.value, minutes, kcal, note: f.note.value }, `Added ${f.name.value}`)) $("#exDlg").close();
});
$("#exCancel").addEventListener("click", () => $("#exDlg").close());

$("#addWeight").addEventListener("click", () => {
  const f = $("#weightForm").elements;
  f.kg.value = latestWeight()?.kg ?? "";
  f.date.value = day > localToday() ? localToday() : day;
  f.date.max = localToday();
  $("#weightDlg").showModal();
  f.kg.select();
});
$("#weightForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const kg = num(f.kg.value);
  if (!(kg > 0)) return toast("Enter your weight in kg");
  if (await sync.runOp({ op: "addWeight", person: who, date: f.date.value, kg }, `Logged ${kg} kg`)) $("#weightDlg").close();
});
$("#weightCancel").addEventListener("click", () => $("#weightDlg").close());

// ---------------------------------------------------------------- goals

const goalsForm = $("#goalsForm");
function goalPreview() {
  const f = goalsForm.elements;
  const pr = {
    ...doc.profiles[who], sex: f.sex.value, birthYear: num(f.birthYear.value) || null, heightCm: num(f.heightCm.value) || null,
    weeklyKg: num(f.weeklyKg.value), activity: f.activity.value, kcalTarget: num(f.kcalTarget.value) || null,
    macros: { p: num(f.mp.value) || 0, c: num(f.mc.value) || 0, f: num(f.mf.value) || 0 },
  };
  const kg = num(f.currentKg.value);
  const saved = { profiles: doc.profiles, weights: doc.weights };
  doc.profiles = { ...doc.profiles, [who]: pr };
  if (kg > 0) doc.weights = [...doc.weights, { person: who, date: "9998-12-31", kg, t: 0 }];
  const t = targets(who, "9999");
  Object.assign(doc, saved);
  $("#goalCalc").textContent = t.calc
    ? `Burns about ${fmt(t.calc.tdee)} kcal a day, so the goal is ${fmt(t.calc.kcal)} kcal a day${t.calc.kcal === t.calc.floor ? " (the safe minimum)" : ""}.${pr.kcalTarget ? ` Using your override of ${fmt(pr.kcalTarget)} instead.` : ""}`
    : "Fill in sex, year of birth, height and weight to work out your calorie goal.";
  const total = pr.macros.p + pr.macros.c + pr.macros.f;
  $("#macroCalc").textContent = total === 100
    ? `${fmt(t.p)}g protein · ${fmt(t.c)}g carbs · ${fmt(t.f)}g fat a day`
    : `These add up to ${total}%; make them 100%.`;
}
function openGoals() {
  if (!doc) return;
  const pr = doc.profiles[who] ?? {};
  const f = goalsForm.elements;
  $("#goalsWho").textContent = who;
  f.sex.value = pr.sex ?? "";
  f.birthYear.value = pr.birthYear ?? "";
  f.heightCm.value = pr.heightCm ?? "";
  f.currentKg.value = latestWeight()?.kg ?? "";
  f.goalKg.value = pr.goalKg ?? "";
  f.weeklyKg.value = String(pr.weeklyKg ?? -0.5);
  f.activity.value = pr.activity ?? "light";
  f.kcalTarget.value = pr.kcalTarget ?? "";
  f.mp.value = pr.macros?.p ?? 30;
  f.mc.value = pr.macros?.c ?? 40;
  f.mf.value = pr.macros?.f ?? 30;
  goalPreview();
  $("#goalsDlg").showModal();
}
goalsForm.addEventListener("input", goalPreview);
goalsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = goalsForm.elements;
  const kg = num(f.currentKg.value);
  const latest = latestWeight();
  if (kg > 0 && kg !== latest?.kg && !(await sync.runOp({ op: "addWeight", person: who, date: localToday(), kg }))) return;
  if (await sync.runOp({
    op: "saveProfile", person: who, sex: f.sex.value, birthYear: f.birthYear.value, heightCm: f.heightCm.value,
    goalKg: f.goalKg.value, weeklyKg: f.weeklyKg.value, activity: f.activity.value, kcalTarget: f.kcalTarget.value,
    macros: { p: num(f.mp.value), c: num(f.mc.value), f: num(f.mf.value) },
  }, "Goals saved")) $("#goalsDlg").close();
});
$("#goalsCancel").addEventListener("click", () => $("#goalsDlg").close());
$("#goalsBtn").addEventListener("click", openGoals);

// ---------------------------------------------------------------- wiring

document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-add-food]");
  if (add) return openFood(add.dataset.addFood || null);
  if (e.target.closest("[data-open-goals]")) return openGoals();
  const row = e.target.closest("[data-edit-food]");
  if (row) return openEdit(doc.foods.find((f) => f.id === row.dataset.editFood));
  const ex = e.target.closest("[data-del-ex]");
  if (ex) return sync.runOp({ op: "deleteExercise", id: ex.dataset.delEx }, "Exercise removed");
  const w = e.target.closest("[data-del-weight]");
  if (w) return sync.runOp({ op: "deleteWeight", id: w.dataset.delWeight }, "Weigh-in removed");
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest?.("[data-edit-food], [data-recent]");
  if (el) { e.preventDefault(); el.click(); }
});

$("#personPick").addEventListener("change", (e) => {
  who = e.target.value;
  store.set("fitness.person", who);
  render();
});
$("#prevDay").addEventListener("click", () => { day = shiftDay(day, -1); render(); });
$("#nextDay").addEventListener("click", () => { day = shiftDay(day, 1); render(); });
$("#dayInput").addEventListener("change", (e) => { if (e.target.value) { day = e.target.value; render(); } });
$("#rangePick").addEventListener("change", () => render());

for (const btn of document.querySelectorAll(".fold-tab")) {
  btn.addEventListener("click", () => {
    const open = !btn.classList.contains("active");
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-expanded", String(open));
    $(`#${btn.dataset.fold}`).hidden = !open;
  });
}

function readScreen() {
  screen = location.hash === "#progress" ? "progress" : "diary";
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", readScreen);
setInterval(() => { if (doc) renderLog(); }, 60000);
setupIdentity();
readScreen();
sync.start();
