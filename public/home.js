// Home page (/): today at a glance (each card opens its app), quick-add buttons (above the habits
// calendar) that open an
// app straight into its dialog (it comes back here afterwards), and the apps in the bottom bar.

import { $, esc, store, localToday, toast, fetchJson, setupIdentity, checkIdentity } from "/common.js";
import { FEATURES } from "/new/features.js";
import { dayTargets, exerciseAddsBack, settleUp } from "/calc.js";

const money = (c) => `S$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (v) => Math.round(v).toLocaleString("en-US");
const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);

// ✨ What's new button (top right): a dot until the latest features have been seen on this phone.
{
  let seen = [];
  try { seen = JSON.parse(store.get("new.seen") || "[]"); } catch { /* ignore */ }
  const unseen = FEATURES.filter((f) => !seen.includes(f.id)).length;
  if (unseen) {
    $("#newTab").classList.add("has-new");
    $("#newTab").setAttribute("aria-label", `What's new, ${unseen} feature${unseen === 1 ? "" : "s"} you haven't seen`);
  }
}

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

let fitDoc = null, dailyDoc = null;
async function loadFitnessCards() {
  try {
    const { doc } = await fetchJson("/api/fitness");
    fitDoc = doc;
    renderCal();
    renderFood(doc);
  } catch { failed("gFood"); }
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
    if (!live.length) return; // the line stays hidden until there are plans
    const today = localToday();
    const dated = live.filter((p) => p.nextDue).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    const overdue = dated.filter((p) => p.nextDue < today).length;
    const next = dated.find((p) => p.nextDue >= today);
    // One line in the Spending card: the next insurance payment (or how many are overdue).
    $("#gInsLine").innerHTML = overdue ? `🛡️ <span class="over">⚠️ ${overdue} insurance payment${overdue > 1 ? "s" : ""} overdue</span>`
      : next ? `🛡️ ${esc(next.name)} due ${new Date(`${next.nextDue}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })}` : "";
    $("#gInsLine").hidden = !$("#gInsLine").innerHTML;
  } catch { /* stays hidden */ }
}

// ---------------------------------------------------------------- 📅 habits calendar
// The calendar's ✓ and ✕, drawn as cute blue icons (alt text keeps the symbol for screen readers).
const TICK = `<img class="cal-icon" src="/icons/cal-tick.png" alt="✓" />`;
const CROSS = `<img class="cal-icon" src="/icons/cal-x.png" alt="✕" />`;

// A week or month for one of us. A day gets ✓ when both habits were kept (calories within the
// goal and a poop logged), ○ when one was, and stays grey otherwise. Below it, how many days
// each habit was kept in the period so far. Tap a day for what was eaten, logged and spent.

const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const monthAdd = (ym, n) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const mondayOf = (iso) => shift(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const fmtD = (iso, o) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
let calWho = null, calMonth = localToday().slice(0, 7), calWeek = mondayOf(localToday()), calPick = null;
let calMode = store.get("home.calMode") === "week" ? "week" : "month";
// Which habit the calendar shows: "all" (✓ both kept, ○ one), or one habit on its own, picked
// by tapping it in the progress list (‹ goes back)
// (✓ met, ✕ not met, grey not logged) with its own totals underneath.
let calCat = "all";
const CATS = {
  all: { icon: "📅", name: "Habits", sub: "Calories met & pooped, every day" },
  cals: { icon: "🍔", name: "Calories", sub: "Within your calorie goal", href: "/fitness/#progress", open: "Open the food diary" },
  poop: { icon: "💩", name: "Poop", sub: "A poop logged that day", href: "/toilet/", open: "Open the toilet log" },
};
// One day for the chosen habit: "met", "miss" (not met) or "none" (nothing logged yet).
function catStatus(r, d, today) {
  if (calCat === "cals") return r.eaten === 0 ? "none" : r.cals ? "met" : "miss";
  if (calCat === "poop") return r.pooped ? "met" : d === today ? "none" : "miss";
  return r.status;
}

function dayInfo(p, d) {
  const eaten = sum(fitDoc.foods.filter((f) => f.person === p && f.date === d), "kcal");
  const burned = exerciseAddsBack(fitDoc, p) ? sum(fitDoc.exercises.filter((x) => x.person === p && x.date === d), "kcal") : 0;
  const goal = dayTargets(fitDoc, p, d).kcal + burned;
  const poops = (fitDoc.toilet ?? []).filter((x) => x.person === p && x.date === d);
  const spent = dailyDoc ? sum(dailyDoc.items.filter((i) => i.date === d && i.kind === "personal" && i.owner === p), "a")
    + dailyDoc.items.filter((i) => i.date === d && i.kind === "shared").reduce((a, i) => a + i.a * (i.shares?.[p] ?? 0), 0) : 0;
  const cals = eaten > 0 && eaten <= goal; // calories met (today: so far)
  const pooped = poops.length > 0;
  return { eaten, goal, over: eaten - goal, poops, spent, cals, pooped, status: cals && pooped ? "all" : cals || pooped ? "some" : "none" };
}

function calRange() {
  if (calMode === "week") return { from: calWeek, to: shift(calWeek, 6) };
  const [y, m] = calMonth.split("-").map(Number);
  return { from: `${calMonth}-01`, to: `${calMonth}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
}

function renderCal() {
  const today = localToday();
  const people = fitDoc.people;
  calWho ??= me() ?? people[0];
  $("#calWho").innerHTML = people.map((p) => `<label><input type="radio" name="calWho" value="${esc(p)}" ${p === calWho ? "checked" : ""} /><span>${esc(p)}</span></label>`).join("");
  for (const r of document.querySelectorAll('input[name="calMode"]')) r.checked = r.value === calMode;
  const { from, to } = calRange();
  $("#calTitle").textContent = calMode === "week"
    ? `${fmtD(from, { month: "short", day: "numeric" })} – ${fmtD(to, from.slice(0, 7) === to.slice(0, 7) ? { day: "numeric" } : { month: "short", day: "numeric" })}`
    : fmtD(from, { month: "long", year: "numeric" });
  $("#calNext").disabled = shift(to, 1) > today;
  $("#habitsTitle").closest(".habits").dataset.mode = calMode;

  const cat = CATS[calCat];
  $("#calBack").hidden = calCat === "all";
  $("#habIcon").textContent = cat.icon;
  $("#habitsTitle").textContent = cat.name;
  $("#habSub").textContent = cat.sub;
  $("#habKey").innerHTML = calCat === "all"
    ? `<span><i class="hk all ic">${TICK}</i> All habits met</span><span><i class="hk some">○</i> Some met</span><span><i class="hk none"></i> Not met</span>`
    : `<span><i class="hk all ic">${TICK}</i> Met</span><span><i class="hk miss ic">${CROSS}</i> Not met</span><span><i class="hk none"></i> Not logged</span>`;
  const counts = { days: 0, cals: 0, pooped: 0, all: 0, met: 0, miss: 0, none: 0 };
  const lead = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: lead }, () => `<span class="cal-day blank"></span>`);
  for (let d = from; d <= to; d = shift(d, 1)) {
    const future = d > today;
    const r = future ? null : dayInfo(calWho, d);
    if (r) { counts.days++; if (r.cals) counts.cals++; if (r.pooped) counts.pooped++; if (r.status === "all") counts.all++; }
    const status = r ? catStatus(r, d, today) : "future";
    if (r && calCat !== "all") counts[status]++;
    const mark = status === "all" || status === "met" ? TICK : status === "some" ? "○" : status === "miss" ? CROSS : "";
    const label = `${fmtD(d, { month: "short", day: "numeric" })}${r ? `: ${r.cals ? "calories met" : "calories not met"}, ${r.pooped ? "pooped" : "no poop logged"}` : ""}`;
    cells.push(`<button type="button" class="cal-day st-${status}${d === today ? " today" : ""}${d === calPick ? " picked" : ""}" data-day="${d}" ${future ? "disabled" : ""} aria-label="${label}">
      <b>${Number(d.slice(8))}</b><span class="cal-tick" aria-hidden="true">${mark}</span></button>`);
  }
  $("#calGrid").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => `<span class="cal-wd">${w}</span>`).join("") + cells.join("");

  // Progress for the days so far in this week or month.
  $("#progTitle").textContent = calMode === "week" ? "Weekly progress" : "Monthly progress";
  $("#progRange").textContent = `(${fmtD(from, { month: "short", day: "numeric" })} – ${fmtD(to, { month: "short", day: "numeric" })})`;
  const n = counts.days;
  const prog = (icon, name, k, href) => { // href: the habit to show when tapped
    const pct = n ? Math.round((counts[k] / n) * 100) : 0;
    const inner = `<span class="hp-ic" aria-hidden="true">${icon}</span><b class="hp-name">${name}</b><span class="hp-days">${counts[k]} / ${n} day${n === 1 ? "" : "s"}</span>
      <span class="hp-bar"><i style="width:${pct}%"></i></span><span class="hp-pct">${pct}%</span><span class="hp-go" aria-hidden="true">${href ? "›" : ""}</span>`;
    return `<li>${href ? `<button type="button" data-cat="${href}" aria-label="Show ${name} on the calendar">${inner}</button>` : `<div>${inner}</div>`}</li>`;
  };
  $("#progList").hidden = calCat !== "all";
  $("#catStats").hidden = calCat === "all";
  $("#progList").innerHTML = prog("🍔", "Calories", "cals", "cals") + prog("💩", "Poop", "pooped", "poop") + prog("✅", "All habits", "all", "");
  if (calCat !== "all") {
    const rate = n ? Math.round((counts.met / n) * 100) : 0;
    const stat = (cls, mark, v, label) => `<div class="hs"><b>${mark ? `<i class="hk ${cls}">${mark}</i>` : ""}${v}</b><span>${label}</span></div>`;
    $("#catStats").innerHTML = `<div class="hs-row">${stat("all ic", TICK, counts.met, "Met")}${stat("miss ic", CROSS, counts.miss, "Not met")}${stat("none", " ", counts.none, "Not logged")}${stat("", "", `${rate}%`, "Success rate")}</div>
      <a class="hs-open" href="${cat.href}">${cat.open} ›</a>`;
  }
  renderCalDay();
}

function renderCalDay() {
  if (!calPick) { if ($("#calDayDlg").open) $("#calDayDlg").close(); return; }
  const r = dayInfo(calWho, calPick);
  const label = fmtD(calPick, { weekday: "long", day: "numeric", month: "short" });
  $("#calDay").innerHTML = `<h3>${label} · ${r.status === "all" ? "✓ all habits met" : r.status === "some" ? "○ some met" : "not met"}</h3>
    <div class="g-row"><span class="g-who">🍔 Calories</span><b class="${r.over > 0 ? "over" : ""}">${r.eaten ? `${fmt(r.eaten)} / ${fmt(r.goal)}` : "nothing logged"}</b>${r.eaten ? `<small>${r.over > 0 ? `${fmt(r.over)} over` : `${fmt(-r.over)} under`}</small>` : ""}</div>
    <div class="g-row"><span class="g-who">💩 Poop</span><b>${r.poops.length || "none"}</b>${r.poops.length ? `<small>${r.poops.map((x) => `${x.time || "?"} · type ${x.type}`).join(", ")}</small>` : ""}</div>
    ${dailyDoc ? `<div class="g-row"><span class="g-who">💸 Spent</span><b>${money(r.spent)}</b><small>own expenses plus share of shared</small></div>` : ""}
    <a class="btn ghost small-btn" href="/fitness/#diary">Open the food diary</a>`;
}

$("#calWho").addEventListener("change", (e) => { calWho = e.target.value; renderCal(); });
$("#calBack").addEventListener("click", () => { calCat = "all"; renderCal(); });
$("#progList").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) { calCat = b.dataset.cat; renderCal(); } });
$("#calMode").addEventListener("change", (e) => {
  calMode = e.target.value; store.set("home.calMode", calMode);
  // Keep looking at roughly the same time: the week of the month's last day shown, or the week's month.
  const today = localToday();
  if (calMode === "week") { const end = calRange().to; calWeek = mondayOf(end > today ? today : end); } else calMonth = shift(calWeek, 6) > today ? today.slice(0, 7) : shift(calWeek, 6).slice(0, 7);
  calPick = null; renderCal();
});
const step = (dir) => { if (calMode === "week") calWeek = shift(calWeek, 7 * dir); else calMonth = monthAdd(calMonth, dir); calPick = null; renderCal(); };
$("#calPrev").addEventListener("click", () => step(-1));
$("#calNext").addEventListener("click", () => step(1));
$("#calGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-day]");
  if (!b || b.disabled) return;
  calPick = b.dataset.day;
  renderCal();
  $("#calDayDlg").showModal();
});
// The day's details open on top, so the home page stays one screen tall.
$("#calDayClose").addEventListener("click", () => $("#calDayDlg").close());
$("#calDayDlg").addEventListener("close", () => { calPick = null; renderCal(); });

loadFitnessCards();
loadSpending();
loadInsurance();
