// Home page (/): quick-add buttons that open an app straight into its dialog (it comes back
// here afterwards), and a tab per app with today's snapshot.

import { $, esc, localToday, toast, fetchJson } from "/common.js";
import { dayTargets, exerciseAddsBack, latestWeightOf, settleUp } from "/calc.js";

const money = (c) => `S$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (v) => Math.round(v).toLocaleString("en-US");
const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);

// The message from the dialog just used, e.g. "Added S$12.50".
try {
  const msg = sessionStorage.getItem("home.toast");
  if (msg) {
    sessionStorage.removeItem("home.toast");
    toast(`✅ ${msg}`);
  }
} catch { /* private mode */ }

// ---------------------------------------------------------------- tabs

const loaded = {};
const loaders = { expensesPanel: loadExpenses, fitnessPanel: loadFitness, insurancePanel: loadInsurance, toiletPanel: loadToilet };

function openTab(id) {
  for (const btn of document.querySelectorAll(".home-tabs .fold-tab")) {
    const open = btn.dataset.fold === id;
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-expanded", String(open));
    $(`#${btn.dataset.fold}`).hidden = !open;
  }
  if (id && loaders[id] && !loaded[id]) {
    loaded[id] = true;
    loaders[id]().catch(() => {
      loaded[id] = false; // try again next time it opens
      $(`#${id} .home-stats`).innerHTML = `<p class="muted small">Couldn't load this right now. Open the app to see the details.</p>`;
    });
  }
}
$(".home-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".fold-tab");
  if (btn) openTab(btn.classList.contains("active") ? null : btn.dataset.fold);
});

const stat = (label, big, sub = "") =>
  `<div class="home-stat"><span>${label}</span><b>${big}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

// ---------------------------------------------------------------- snapshots

async function loadExpenses() {
  const { doc } = await fetchJson("/api/daily");
  const today = localToday();
  const month = today.slice(0, 7);
  const monthName = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const personal = doc.items.filter((i) => i.kind === "personal" && i.date.startsWith(month));
  const shared = doc.items.filter((i) => i.kind === "shared" && i.date.startsWith(month));
  const owed = settleUp(doc);
  $("#expensesStats").innerHTML =
    doc.people.map((p) => {
      const mine = personal.filter((i) => i.owner === p);
      return stat(`${esc(p)} · ${monthName}`, money(sum(mine, "a")), `${money(sum(mine.filter((i) => i.date === today), "a"))} today`);
    }).join("") +
    stat(`Shared · ${monthName}`, money(sum(shared, "a")), `${shared.length} expense${shared.length === 1 ? "" : "s"}`) +
    stat("Settle up", owed.length ? owed.map((x) => `${esc(x.from)} owes ${esc(x.to)} ${money(x.a)}`).join("<br>") : "✅ All square");
}

async function loadFitness() {
  const { doc } = await fetchJson("/api/fitness");
  const today = localToday();
  $("#fitnessStats").innerHTML = doc.people.map((p) => {
    const goal = dayTargets(doc, p, today).kcal;
    const eaten = sum(doc.foods.filter((f) => f.person === p && f.date === today), "kcal");
    const burned = exerciseAddsBack(doc, p) ? sum(doc.exercises.filter((x) => x.person === p && x.date === today), "kcal") : 0;
    const left = goal - eaten + burned;
    const w = latestWeightOf(doc, p);
    const target = doc.profiles[p]?.goalKg;
    return stat(esc(p), `${fmt(Math.abs(left))} kcal ${left < 0 ? "over" : "left"}`,
      `${fmt(eaten)} eaten of ${fmt(goal + burned)}${w ? ` · ${w.kg} kg${target ? ` → ${target} kg` : ""}` : ""}`);
  }).join("");
}

async function loadInsurance() {
  const { doc } = await fetchJson("/api/insurance");
  const live = doc.plans.filter((p) => p.status === "active" || p.status === "pending");
  const perMonth = (p) => (p.frequency === "single" ? 0 : p.monthly ?? (p.annual !== null ? Math.round(p.annual / 12) : 0));
  const perYear = (p) => (p.frequency === "single" ? 0 : p.annual ?? (p.monthly !== null ? p.monthly * 12 : 0));
  const today = localToday();
  const next = live.filter((p) => p.nextDue && p.nextDue >= today).sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0];
  const overdue = live.filter((p) => p.nextDue && p.nextDue < today).length;
  $("#insuranceStats").innerHTML = live.length
    ? doc.people.map((p) => {
        const mine = live.filter((x) => x.person === p);
        const m = mine.reduce((s, x) => s + perMonth(x), 0);
        const y = mine.reduce((s, x) => s + perYear(x), 0);
        return stat(esc(p), `${money(m)} a month`, `${mine.length} plan${mine.length === 1 ? "" : "s"} · ${money(y)} a year`);
      }).join("") +
      stat("Next payment", next ? esc(next.name) : "—", next ? `${next.nextDue}${overdue ? ` · ⚠️ ${overdue} overdue` : ""}` : overdue ? `⚠️ ${overdue} overdue` : "No dates added")
    : `<p class="muted small">No plans yet. Open the app to add them.</p>`;
}

async function loadToilet() {
  const { doc } = await fetchJson("/api/fitness");
  const today = localToday();
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const log = doc.toilet ?? [];
  $("#toiletStats").innerHTML = doc.people.map((p) => {
    const mine = log.filter((x) => x.person === p).sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
    const todayN = mine.filter((x) => x.date === today).length;
    const week = mine.filter((x) => x.date >= weekAgo);
    const last = mine[0];
    return stat(esc(p), `${todayN} today`, last ? `${week.length} in 7 days · last type ${last.type}${last.date === today ? "" : `, ${last.date}`}` : "Nothing logged yet");
  }).join("");
}
