// Home page (/): today at a glance (each card opens its app), quick-add buttons that open an
// app straight into its dialog (it comes back here afterwards), and the apps in the bottom bar.

import { $, esc, localToday, toast, fetchJson, setupIdentity, checkIdentity } from "/common.js";
import { dayTargets, exerciseAddsBack, settleUp } from "/calc.js";

const money = (c) => `S$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (v) => Math.round(v).toLocaleString("en-US");
const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);

// Who uses this phone: asked once, with a button for each of us.
setupIdentity();
checkIdentity(["Karstin", "Lilin"]);

// The message from the dialog just used, e.g. "Added S$12.50".
try {
  const msg = sessionStorage.getItem("home.toast");
  if (msg) {
    sessionStorage.removeItem("home.toast");
    toast(`✅ ${msg}`);
  }
} catch { /* private mode */ }

// ---------------------------------------------------------------- today at a glance
// Shown straight away at the top; each card opens its app.

const me = () => {
  const n = (localStorage.getItem("trip.name") || "").toLowerCase().replace(/\s+/g, "");
  return ["Karstin", "Lilin"].find((p) => n && (n.startsWith(p.toLowerCase()) || p.toLowerCase().startsWith(n))) ?? null;
};
// The phone's person first.
const order = (people) => { const m = me(); return m ? [m, ...people.filter((p) => p !== m)] : people; };
const row = (who, big, sub, cls = "") => `<div class="g-row ${cls}"><span class="g-who">${esc(who)}</span><b>${big}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
const failed = (id) => { $(`#${id} .g-body`).innerHTML = `<p class="muted small">Couldn't load. Tap to open.</p>`; };

function renderFood(doc) {
  const today = localToday();
  $("#gFood .g-body").innerHTML = order(doc.people).map((p) => {
    const goal = dayTargets(doc, p, today).kcal;
    const eaten = sum(doc.foods.filter((f) => f.person === p && f.date === today), "kcal");
    const burned = exerciseAddsBack(doc, p) ? sum(doc.exercises.filter((x) => x.person === p && x.date === today), "kcal") : 0;
    const left = goal - eaten + burned;
    const pct = Math.min(100, (eaten / ((goal + burned) || 1)) * 100);
    return `<div class="g-row"><span class="g-who">${esc(p)}</span><b class="${left < 0 ? "over" : ""}">${fmt(Math.abs(left))} ${left < 0 ? "over" : "left"}</b>
      <small>${fmt(eaten)} / ${fmt(goal + burned)} kcal</small><span class="g-meter${left < 0 ? " over" : ""}"><i style="width:${pct}%"></i></span></div>`;
  }).join("");
}

function renderToilet(doc) {
  const today = localToday();
  const log = doc.toilet ?? [];
  $("#gToilet .g-body").innerHTML = order(doc.people).map((p) => {
    const mine = log.filter((x) => x.person === p).sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
    const n = mine.filter((x) => x.date === today).length;
    const last = mine[0];
    return row(p, `${n} today`, last ? `last ${last.date === today ? `at ${last.time || "today"}` : last.date.slice(5)} · type ${last.type}` : "none yet");
  }).join("");
}

let fitDoc = null, dailyDoc = null;
async function loadFitnessCards() {
  try {
    const { doc } = await fetchJson("/api/fitness");
    fitDoc = doc;
    renderCal();
    renderFood(doc);
    renderToilet(doc);
  } catch { failed("gFood"); failed("gToilet"); }
}

async function loadSpending() {
  try {
    const { doc } = await fetchJson("/api/daily");
    dailyDoc = doc;
    if (fitDoc) renderCal();
    const today = localToday(), month = today.slice(0, 7);
    const personal = doc.items.filter((i) => i.kind === "personal" && i.date.startsWith(month));
    const shared = doc.items.filter((i) => i.kind === "shared" && i.date.startsWith(month));
    const owed = settleUp(doc);
    $("#gSpend .g-body").innerHTML = order(doc.people).map((p) => {
      const mine = personal.filter((i) => i.owner === p);
      return row(p, money(sum(mine, "a")), `${money(sum(mine.filter((i) => i.date === today), "a"))} today`);
    }).join("") + row("Shared", money(sum(shared, "a")), "this month") +
      `<p class="g-note">${owed.length ? owed.map((x) => `${esc(x.from)} owes ${esc(x.to)} ${money(x.a)}`).join(" · ") : "✅ All square"}</p>`;
  } catch { failed("gSpend"); }
}

async function loadInsurance() {
  try {
    const { doc } = await fetchJson("/api/insurance");
    const live = doc.plans.filter((p) => p.status === "active" || p.status === "pending");
    if (!live.length) return; // card stays hidden until there are plans
    const today = localToday();
    const dated = live.filter((p) => p.nextDue).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    const overdue = dated.filter((p) => p.nextDue < today).length;
    const next = dated.find((p) => p.nextDue >= today);
    $("#gIns .g-body").innerHTML = row("Next payment", next ? esc(next.name) : "—", next ? next.nextDue : "") +
      (overdue ? `<p class="g-note over">⚠️ ${overdue} overdue</p>` : "");
    $("#gIns").hidden = false;
  } catch { /* stays hidden */ }
}

// ---------------------------------------------------------------- 📅 calendar
// A month at a glance for one of us: calories met or over, toilet visits, and (tap a
// day) what was eaten, logged and spent.

const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const monthAdd = (ym, n) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
let calWho = null, calMonth = localToday().slice(0, 7), calPick = null;

function dayInfo(p, d) {
  const eaten = sum(fitDoc.foods.filter((f) => f.person === p && f.date === d), "kcal");
  const burned = exerciseAddsBack(fitDoc, p) ? sum(fitDoc.exercises.filter((x) => x.person === p && x.date === d), "kcal") : 0;
  const goal = dayTargets(fitDoc, p, d).kcal + burned;
  const poops = (fitDoc.toilet ?? []).filter((x) => x.person === p && x.date === d);
  const spent = dailyDoc ? sum(dailyDoc.items.filter((i) => i.date === d && i.kind === "personal" && i.owner === p), "a")
    + dailyDoc.items.filter((i) => i.date === d && i.kind === "shared").reduce((a, i) => a + i.a * (i.shares?.[p] ?? 0), 0) : 0;
  return { eaten, goal, over: eaten - goal, poops, spent };
}

function renderCal() {
  const today = localToday();
  const people = fitDoc.people;
  calWho ??= me() ?? people[0];
  $("#calWho").innerHTML = people.map((p) => `<label><input type="radio" name="calWho" value="${esc(p)}" ${p === calWho ? "checked" : ""} /><span>${esc(p)}</span></label>`).join("");
  const [y, m] = calMonth.split("-").map(Number);
  const first = `${calMonth}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  $("#calTitle").textContent = new Date(`${first}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  $("#calNext").disabled = calMonth >= today.slice(0, 7);
  let within = 0, logged = 0, poopDays = 0, spent = 0;
  const cells = Array.from({ length: lead }, () => `<span class="cal-day blank"></span>`);
  for (let n = 1; n <= days; n++) {
    const d = `${calMonth}-${String(n).padStart(2, "0")}`;
    const future = d > today;
    const r = future ? null : dayInfo(calWho, d);
    // 🍔 when that day's calories stayed within the goal (today: so far), 💩 when a poop was recorded.
    const burger = !!r?.eaten && r.over <= 0;
    if (r?.eaten) { logged++; if (burger) within++; }
    if (r?.poops.length) poopDays++;
    if (r) spent += r.spent;
    const marks = `${burger ? "🍔" : ""}${r?.poops.length ? "💩" : ""}`;
    const label = `${n}${burger ? ", calories within the goal" : ""}${r?.poops.length ? `, pooped ${r.poops.length} time${r.poops.length > 1 ? "s" : ""}` : ""}`;
    cells.push(`<button type="button" class="cal-day${d === today ? " today" : ""}${d === calPick ? " picked" : ""}" data-day="${d}" ${future ? "disabled" : ""} aria-label="${label}">
      <b>${n}</b><span class="cal-emoji" aria-hidden="true">${marks}</span></button>`);
  }
  $("#calGrid").innerHTML = ["M", "T", "W", "T", "F", "S", "S"].map((w) => `<span class="cal-wd">${w}</span>`).join("") + cells.join("");
  $("#calSummary").textContent = `${calWho}: 🍔 on ${within} of ${logged} day${logged === 1 ? "" : "s"} with food logged · 💩 on ${poopDays} day${poopDays === 1 ? "" : "s"}${dailyDoc ? ` · ${money(spent)} spent` : ""}`;
  renderCalDay();
}

function renderCalDay() {
  if (!calPick || !calPick.startsWith(calMonth)) { $("#calDay").hidden = true; return; }
  const r = dayInfo(calWho, calPick);
  const label = new Date(`${calPick}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  $("#calDay").hidden = false;
  $("#calDay").innerHTML = `<h3>${label}</h3>
    <div class="g-row"><span class="g-who">🥗 Calories</span><b class="${r.over > 0 ? "over" : ""}">${r.eaten ? `${fmt(r.eaten)} / ${fmt(r.goal)}` : "nothing logged"}</b>${r.eaten ? `<small>${r.over > 0 ? `${fmt(r.over)} over` : `${fmt(-r.over)} under`}</small>` : ""}</div>
    <div class="g-row"><span class="g-who">🚽 Toilet</span><b>${r.poops.length || "none"}</b>${r.poops.length ? `<small>${r.poops.map((x) => `${x.time || "?"} · type ${x.type}`).join(", ")}</small>` : ""}</div>
    ${dailyDoc ? `<div class="g-row"><span class="g-who">💸 Spent</span><b>${money(r.spent)}</b><small>own expenses plus share of shared</small></div>` : ""}
    <a class="btn ghost small-btn" href="/fitness/#diary">Open the food diary</a>`;
}

$("#calWho").addEventListener("change", (e) => { calWho = e.target.value; renderCal(); });
$("#calPrev").addEventListener("click", () => { calMonth = monthAdd(calMonth, -1); calPick = null; renderCal(); });
$("#calNext").addEventListener("click", () => { calMonth = monthAdd(calMonth, 1); calPick = null; renderCal(); });
$("#calGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-day]");
  if (!b || b.disabled) return;
  calPick = b.dataset.day;
  renderCal();
});

loadFitnessCards();
loadSpending();
loadInsurance();
