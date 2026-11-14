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

async function loadFitnessCards() {
  try {
    const { doc } = await fetchJson("/api/fitness");
    renderFood(doc);
    renderToilet(doc);
  } catch { failed("gFood"); failed("gToilet"); }
}

async function loadSpending() {
  try {
    const { doc } = await fetchJson("/api/daily");
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

loadFitnessCards();
loadSpending();
loadInsurance();
