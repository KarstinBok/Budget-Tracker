// Home page (/): quick-add buttons that open an app straight into its dialog (it comes back
// here afterwards), and a tab per app with today's snapshot.

import { $, esc, localToday, toast, fetchJson } from "/common.js";
import { exerciseAddsBack, fitnessTargets, latestWeightOf, settleUp } from "/calc.js";

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
const loaders = { expensesPanel: loadExpenses, fitnessPanel: loadFitness };

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
    const goal = fitnessTargets(doc, p, today).kcal;
    const eaten = sum(doc.foods.filter((f) => f.person === p && f.date === today), "kcal");
    const burned = exerciseAddsBack(doc, p) ? sum(doc.exercises.filter((x) => x.person === p && x.date === today), "kcal") : 0;
    const left = goal - eaten + burned;
    const w = latestWeightOf(doc, p);
    const target = doc.profiles[p]?.goalKg;
    return stat(esc(p), `${fmt(Math.abs(left))} kcal ${left < 0 ? "over" : "left"}`,
      `${fmt(eaten)} eaten of ${fmt(goal + burned)}${w ? ` · ${w.kg} kg${target ? ` → ${target} kg` : ""}` : ""}`);
  }).join("");
}
