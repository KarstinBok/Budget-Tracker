// Japan trip budget tracker – client.
// Talks to /api/trip (netlify/functions/trip.mjs). Every change is sent as a small
// operation; every few seconds the page polls for a newer version of the shared
// document so everyone sees each other's changes live.

import {
  $, esc, store, localToday, toMs, toIso, fmtDay, timeAgo, toast,
  downloadFile, setupIdentity, createSync, fetchJson, postJson, myName, inAndroidApp,
} from "./common.js";

const DAY_MS = 86400000;

const yen = new Intl.NumberFormat("en-US", { style: "currency", currency: "JPY" });
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

let doc = null;
let gridSignature = "";
let openCell = null; // { date, cat } whose breakdown is dropped down in the table; cat null = whole day

const sync = createSync({
  path: "/api/trip",
  schema: 3, // matches SCHEMA in netlify/functions/trip.mjs
  onDoc(next, prevDoc) {
    doc = next;
    render(prevDoc);
  },
});
const runOp = (op, okMsg) => sync.runOp(op, okMsg);

// ---------------------------------------------------------------- helpers

const sgdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ¥ per S$1: the live rate when enabled and available, otherwise the trip's manual rate.
function yenPerSgd() {
  return doc.trip.autoRate && liveRate ? liveRate.rate : doc.trip.rate;
}

function fmtSgd(amountYen) {
  return `S$${sgdFmt.format(amountYen / yenPerSgd())}`;
}

// ---------------------------------------------------------------- payments and cards

const LIMIT_WARN = 0.8; // warn once a card has used this share of its limit
const fmtS = (sgd) => `S$${sgdFmt.format(sgd)}`;
const cardById = (id) => doc.cards?.find((c) => c.id === id);
const cardLabel = (c) => `${c.owner}'s ${c.name}`;

// S$ spent on a card so far, at the current rate (optionally leaving one expense out).
function cardSpentSgd(cardId, exceptItemId = null) {
  return doc.items.filter((i) => i.card === cardId && i.id !== exceptItemId).reduce((sum, i) => sum + i.a, 0) / yenPerSgd();
}

function cardLevel(usedSgd, limitSgd) {
  return usedSgd >= limitSgd ? "over" : usedSgd >= limitSgd * LIMIT_WARN ? "near" : "";
}

function cardWarning(card, usedSgd) {
  const pct = Math.round((usedSgd / card.limitSgd) * 100);
  return usedSgd >= card.limitSgd
    ? `⛔ ${cardLabel(card)} is over its ${fmtS(card.limitSgd)} limit by ${fmtS(usedSgd - card.limitSgd)}.`
    : `⚠️ ${cardLabel(card)} has used ${pct}% of its ${fmtS(card.limitSgd)} limit (${fmtS(card.limitSgd - usedSgd)} left).`;
}

function payLabel(i) {
  if (i.pay === "cash") return `💵 ${esc(i.payer)}'s cash`;
  const card = i.pay === "card" && cardById(i.card);
  return card ? `💳 ${esc(cardLabel(card))}` : "";
}

// Everyone who has added, paid for or owns a card on this trip, for name suggestions.
function people() {
  const names = new Set([myName(), ...doc.items.flatMap((i) => [i.by, i.payer]), ...(doc.cards ?? []).map((c) => c.owner)]);
  names.delete(undefined);
  names.delete("");
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Live market JPY/SGD rate from /api/rate (netlify/functions/rate.mjs), which everyone
// on the trip shares. The last rate seen is remembered on this device for a quick start.
const RATE_POLL_MS = 5 * 60 * 1000;
let liveRate = null;
try { liveRate = JSON.parse(store.get("trip.liveRate")); } catch { /* none cached */ }

async function refreshLiveRate() {
  try {
    const res = await fetch("/api/rate", { cache: "no-store" });
    const r = await res.json();
    if (!res.ok || !(r.rate > 0)) return;
    liveRate = r;
    store.set("trip.liveRate", JSON.stringify(liveRate));
    if (doc) render();
  } catch { /* keep the last rate we had */ }
}

function rateLabel() {
  const r = yenPerSgd().toFixed(2);
  if (!(doc.trip.autoRate && liveRate)) {
    return `S$1 = ¥${r} · manual rate${doc.trip.autoRate ? " (live rate unavailable)" : ""}`;
  }
  const when = liveRate.asOf
    ? fmtDay(liveRate.asOf, { month: "short", day: "numeric" })
    : `updated ${timeAgo(liveRate.fetched)}`;
  const kind = liveRate.asOf ? "daily reference rate" : "live market rate";
  return `S$1 = ¥${r} · ${kind} (${liveRate.source ?? "online"}, ${when})`;
}

// ---------------------------------------------------------------- data access

function tripDays() {
  const { start, end } = doc.trip;
  const set = new Set();
  for (let t = toMs(start); t <= toMs(end); t += DAY_MS) set.add(toIso(t));
  // Keep any days that already have spending, even if trip dates were changed later.
  for (const i of doc.items) set.add(i.date);
  return [...set].sort();
}

// sums[date][cat] = { sum, count } for a list of expense items.
function cellSums(items) {
  const sums = {};
  for (const i of items) {
    const c = ((sums[i.date] ??= {})[i.cat] ??= { sum: 0, count: 0 });
    c.sum += i.a;
    c.count++;
  }
  return sums;
}

function computeStats() {
  const days = tripDays();
  const cats = doc.categories;
  const sums = cellSums(doc.items);
  const byDay = {};
  const byCat = Object.fromEntries(cats.map((c) => [c.id, 0]));
  let total = 0;
  for (const d of days) {
    let dayTotal = 0;
    for (const c of cats) {
      const v = sums[d]?.[c.id]?.sum ?? 0;
      dayTotal += v;
      byCat[c.id] += v;
    }
    byDay[d] = dayTotal;
    total += dayTotal;
  }
  const loggedDays = days.filter((d) => byDay[d] > 0).length;
  return { days, sums, byDay, byCat, total, loggedDays };
}

// ---------------------------------------------------------------- rendering

const gridSig = () => JSON.stringify([tripDays(), doc.categories, doc.trip.start, doc.trip.end]);

function render(prevDoc = null) {
  if (!doc) return;
  const stats = computeStats();
  document.title = `${doc.trip.name} · Budget`;
  $("#tripName").textContent = doc.trip.name;
  const nights = Math.round((toMs(doc.trip.end) - toMs(doc.trip.start)) / DAY_MS) + 1;
  $("#tripDates").textContent =
    `${fmtDay(doc.trip.start, { month: "short", day: "numeric" })} – ${fmtDay(doc.trip.end, { month: "short", day: "numeric", year: "numeric" })} · ${nights} days · ${rateLabel()}`;

  renderCards(stats);
  renderPayments();
  renderGrid(stats, prevDoc);
  renderBreakdown(stats);
  renderLog();
  if ($("#settingsDlg").open) {
    renderCatList();
    renderCardList();
  }
}

function renderPayments() {
  const cards = doc.cards ?? [];
  $("#paymentsPanel").hidden = !cards.length && !doc.items.some((i) => i.pay);

  const warnings = [];
  $("#cardMeters").innerHTML = cards.length ? cards.map((c) => {
    const used = cardSpentSgd(c.id);
    const level = cardLevel(used, c.limitSgd);
    if (level) warnings.push(cardWarning(c, used));
    const pct = (used / c.limitSgd) * 100;
    return `<li class="${level}">
      <div class="cm-head"><b>${esc(cardLabel(c))}</b><span>${fmtS(used)} of ${fmtS(c.limitSgd)}</span></div>
      <div class="meter ${level}"><span style="width:${Math.min(100, pct)}%"></span></div>
      <p class="muted small">${used >= c.limitSgd ? `Over the limit by ${fmtS(used - c.limitSgd)}` : `${fmtS(c.limitSgd - used)} left · ${Math.round(pct)}% used`}</p>
    </li>`;
  }).join("") : `<li class="muted small">No cards yet. Add one when you record a card payment, or in ⚙️ Settings.</li>`;

  const banner = $("#limitBanner");
  banner.hidden = !warnings.length;
  banner.innerHTML = warnings.map((w) => `<p>${esc(w)}</p>`).join("");

  // Cash and card spending per person, in S$.
  const rows = new Map();
  for (const i of doc.items) {
    if (!i.pay) continue;
    const r = rows.get(i.payer) ?? { cash: 0, card: 0 };
    r[i.pay] += i.a;
    rows.set(i.payer, r);
  }
  const unrecorded = doc.items.filter((i) => !i.pay).reduce((sum, i) => sum + i.a, 0);
  $("#payers").innerHTML = `
    <thead><tr><th>Person</th><th class="num">💵 Cash</th><th class="num">💳 Card</th><th class="num">Total</th></tr></thead>
    <tbody>${[...rows].sort((a, b) => a[0].localeCompare(b[0])).map(([who, r]) => `<tr>
      <td>${esc(who)}</td><td class="num">${fmtSgd(r.cash)}</td><td class="num">${fmtSgd(r.card)}</td><td class="num"><b>${fmtSgd(r.cash + r.card)}</b></td>
    </tr>`).join("")}
    ${unrecorded ? `<tr><td class="muted">Not recorded</td><td></td><td></td><td class="num muted">${fmtSgd(unrecorded)}</td></tr>` : ""}</tbody>`;
}

function renderCards({ total, loggedDays, byDay, days }) {
  $("#sumTotal").textContent = yen.format(total);
  $("#sumTotalSgd").textContent = fmtSgd(total);
  $("#sumRate").textContent = rateLabel();

  const avg = loggedDays ? total / loggedDays : 0;
  $("#sumAvg").textContent = yen.format(Math.round(avg));
  $("#sumAvgSgd").textContent = fmtSgd(avg);
  $("#sumAvgNote").textContent = loggedDays
    ? `over ${loggedDays} day${loggedDays === 1 ? "" : "s"} with spending`
    : "No spending logged yet";

  // The budget is set in SGD; spending is in yen, so convert the budget at the current rate.
  const { budgetSgd, end, start } = doc.trip;
  const meter = $("#budgetMeter");
  if (budgetSgd > 0) {
    const budget = budgetSgd * yenPerSgd();
    const left = budget - total;
    const pct = Math.min(100, (total / budget) * 100);
    const word = left >= 0 ? "left" : "over";
    $("#sumBudget").textContent = `${fmtSgd(Math.abs(left))} ${word}`;
    $("#sumBudgetYen").textContent = `${yen.format(Math.round(Math.abs(left)))} ${word}`;
    meter.hidden = false;
    meter.className = `meter ${pct >= 100 ? "over" : pct >= 85 ? "near" : ""}`;
    meter.firstElementChild.style.width = `${pct}%`;
    const today = localToday();
    const from = today > start ? today : start;
    const remainingDays = from <= end ? Math.round((toMs(end) - toMs(from)) / DAY_MS) + 1 : 0;
    const ofBudget = `${Math.round(pct)}% of ${fmtSgd(budget)} used`;
    const perDay = Math.floor(left / remainingDays);
    $("#sumBudgetNote").textContent = remainingDays && left > 0
      ? `${ofBudget} · ${fmtSgd(perDay)} (${yen.format(perDay)})/day for ${remainingDays} day${remainingDays === 1 ? "" : "s"} left`
      : ofBudget;
  } else {
    $("#sumBudget").textContent = "—";
    $("#sumBudgetYen").textContent = "";
    meter.hidden = true;
    $("#sumBudgetNote").textContent = "Set a budget in Settings";
  }

  const maxDay = days.reduce((best, d) => (byDay[d] > (byDay[best] ?? 0) ? d : best), null);
  $("#sumMaxDay").textContent = maxDay ? yen.format(byDay[maxDay]) : "—";
  $("#sumMaxDaySgd").textContent = maxDay ? fmtSgd(byDay[maxDay]) : "";
  $("#sumMaxDayNote").textContent = maxDay ? fmtDay(maxDay, { weekday: "long", month: "short", day: "numeric" }) : "";
}

// A whole-yen amount for the table. From `shortFrom` up it also carries a short form
// ("12.6k") that the phone layout shows instead, so every column fits on screen.
function num(v, { shortFrom = 10000, sign = "" } = {}) {
  const full = `${sign}${plain.format(v)}`;
  if (v < shortFrom) return full;
  const short = v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1000).toFixed(v < 100000 ? 1 : 0)}k`;
  return `<span class="n-full">${full}</span><span class="n-short">${short}</span>`;
}

// S$ to the whole dollar, for the narrow phone layout.
const sgdWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtSgdShort = (amountYen) => `S$${sgdWhole.format(amountYen / yenPerSgd())}`;

// Both labels are rendered; the stylesheet shows the short one on phones.
const both = (full, short) => `<span class="n-full">${full}</span><span class="n-short">${short}</span>`;

function renderGrid({ days, sums, byDay, byCat, total, loggedDays }, prevDoc) {
  const cats = doc.categories;
  const table = $("#grid");
  const signature = gridSig();
  const today = localToday();

  if (signature !== gridSignature) {
    gridSignature = signature;
    const startMs = toMs(doc.trip.start);
    const head = `<thead><tr><th scope="col">Day</th>${cats.map((c) =>
      `<th scope="col" title="${esc(c.name)}"><span class="emoji">${esc(c.emoji)}</span><span class="cat-name">${esc(c.name)}</span></th>`).join("")}` +
      `<th scope="col">${both("Total ¥", "Total")}</th><th scope="col" class="sgd-col">Total S$</th></tr></thead>`;
    const body = days.map((d) => {
      const n = Math.round((toMs(d) - startMs) / DAY_MS) + 1;
      const inside = d >= doc.trip.start && d <= doc.trip.end;
      return `<tr class="${d === today ? "today" : ""} ${inside ? "" : "outside"}" data-date="${d}">
        <th scope="row"><span class="day-label">${fmtDay(d)}</span><span class="day-sub">${inside ? `Day ${n}` : ""}${d === today ? " · today" : ""}</span>
          <span class="day-short"><span>${fmtDay(d, { weekday: "short" })}</span><b>${Number(d.slice(8))}</b></span></th>
        ${cats.map((c) => `<td><button type="button" class="cell" data-date="${d}" data-cat="${esc(c.id)}"></button></td>`).join("")}
        <td class="total"><button type="button" class="cell day-total" data-date="${d}"></button></td>
        <td class="total sgd-col" data-total-sgd="${d}"></td>
      </tr>`;
    }).join("");
    const foot = `<tfoot>
      <tr><th scope="row">Total</th>${cats.map((c) => `<td data-cat-total="${esc(c.id)}"></td>`).join("")}<td data-grand></td><td class="sgd-col" data-grand-sgd></td></tr>
      <tr class="avg"><th scope="row">${both("Avg / day", "Avg")}</th>${cats.map((c) => `<td data-cat-avg="${esc(c.id)}"></td>`).join("")}<td data-grand-avg></td><td class="sgd-col" data-grand-avg-sgd></td></tr>
    </tfoot>`;
    table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }

  const prevSums = prevDoc ? cellSums(prevDoc.items ?? []) : null;
  for (const btn of table.querySelectorAll("button.cell:not(.day-total)")) {
    const { date, cat } = btn.dataset;
    const cell = sums[date]?.[cat];
    const catName = doc.categories.find((c) => c.id === cat)?.name;
    btn.innerHTML = cell ? num(cell.sum) : "–";
    btn.classList.toggle("empty", !cell);
    btn.setAttribute("aria-label", cell
      ? `${catName} on ${fmtDay(date)}: ${yen.format(cell.sum)}, ${cell.count} expense${cell.count === 1 ? "" : "s"}. Show breakdown`
      : `${catName} on ${fmtDay(date)}: nothing yet. Add an expense`);
    btn.title = cell ? `${cell.count} expense${cell.count === 1 ? "" : "s"} · ${fmtSgd(cell.sum)} · click for breakdown` : "Add an expense";
    if (prevSums && (prevSums[date]?.[cat]?.sum ?? 0) !== (cell?.sum ?? 0)) {
      btn.classList.remove("flash");
      void btn.offsetWidth; // restart the animation
      btn.classList.add("flash");
    }
  }
  for (const btn of table.querySelectorAll("button.day-total")) {
    const v = byDay[btn.dataset.date];
    // On phones the S$ column is hidden and the S$ amount shows under the ¥ total instead.
    btn.innerHTML = v ? `${num(v)}<span class="sgd-inline">${fmtSgdShort(v)}</span>` : "";
    btn.disabled = !v;
    btn.title = v ? "Click for the day's breakdown" : "";
  }
  for (const td of table.querySelectorAll("[data-total-sgd]")) {
    const v = byDay[td.dataset.totalSgd];
    td.textContent = v ? fmtSgd(v) : "";
  }
  for (const c of cats) {
    table.querySelector(`[data-cat-total="${CSS.escape(c.id)}"]`).innerHTML = num(byCat[c.id], { shortFrom: 1000, sign: "¥" });
    table.querySelector(`[data-cat-avg="${CSS.escape(c.id)}"]`).innerHTML =
      num(loggedDays ? Math.round(byCat[c.id] / loggedDays) : 0, { shortFrom: 1000, sign: "¥" });
  }
  const avg = loggedDays ? Math.round(total / loggedDays) : 0;
  table.querySelector("[data-grand]").innerHTML =
    `${num(total, { shortFrom: 1000, sign: "¥" })}<span class="sgd-inline">${fmtSgdShort(total)}</span>`;
  table.querySelector("[data-grand-avg]").innerHTML =
    `${num(avg, { shortFrom: 1000, sign: "¥" })}<span class="sgd-inline">${fmtSgdShort(avg)}</span>`;
  table.querySelector("[data-grand-sgd]").textContent = fmtSgd(total);
  table.querySelector("[data-grand-avg-sgd]").textContent = fmtSgd(loggedDays ? total / loggedDays : 0);
  renderDetail();
}

function renderBreakdown({ byCat, total, loggedDays }) {
  const rows = [...doc.categories].sort((a, b) => byCat[b.id] - byCat[a.id]);
  const max = Math.max(1, ...rows.map((c) => byCat[c.id]));
  $("#breakdown").innerHTML = `
    <thead><tr><th>Category</th><th class="num">Total</th><th class="num">Avg/day</th><th class="num">Share</th></tr></thead>
    <tbody>${rows.map((c) => {
      const v = byCat[c.id];
      return `<tr>
        <td>${esc(c.emoji)} ${esc(c.name)}<div class="bar"><span style="width:${(v / max) * 100}%"></span></div></td>
        <td class="num">${yen.format(v)}<div class="muted small">${fmtSgd(v)}</div></td>
        <td class="num">${yen.format(loggedDays ? Math.round(v / loggedDays) : 0)}</td>
        <td class="num">${total ? Math.round((v / total) * 100) : 0}%</td>
      </tr>`;
    }).join("")}</tbody>`;
}

function renderLog() {
  const items = doc.log.slice(0, 40);
  $("#log").innerHTML = items.length
    ? items.map((e) => `<li><b>${esc(e.by)}</b> ${esc(e.msg)}<time datetime="${new Date(e.t).toISOString()}">${timeAgo(e.t)}</time></li>`).join("")
    : `<li class="empty">No changes yet. Start with ＋ Add expense.</li>`;
}

// ---------------------------------------------------------------- breakdown dropdown

function itemRow(i, showCat) {
  const cat = doc.categories.find((c) => c.id === i.cat);
  return `<li>
    <div class="item-main">
      <span class="item-note"><b class="item-who">${esc(i.by)}</b>${showCat ? ` ${esc(cat.emoji)}` : ""}${i.note ? ` · ${esc(i.note)}` : ""}</span>
      <span class="item-meta">${[timeAgo(i.t), payLabel(i), i.editedAt ? `edited by ${esc(i.editedBy)}` : ""].filter(Boolean).join(" · ")}</span>
    </div>
    <div class="item-amt">${yen.format(i.a)}<span>${fmtSgd(i.a)}</span></div>
    <button type="button" class="icon-btn" data-edit-item="${esc(i.id)}" title="Edit this expense" aria-label="Edit ${yen.format(i.a)}${i.note ? ` ${esc(i.note)}` : ""}">✏️</button>
    <button type="button" class="icon-btn" data-del="${esc(i.id)}" title="Delete this expense" aria-label="Delete ${yen.format(i.a)}${i.note ? ` ${esc(i.note)}` : ""}">🗑</button>
  </li>`;
}

// Shows the open cell's expenses in a row that drops down under that day in the table.
function renderDetail() {
  const table = $("#grid");
  table.querySelector("tr.detail-row")?.remove();
  for (const b of table.querySelectorAll("button.cell.open")) {
    b.classList.remove("open");
    b.setAttribute("aria-expanded", "false");
  }
  if (!openCell) return;
  const { date, cat } = openCell;
  const category = cat && doc.categories.find((c) => c.id === cat);
  const dayRow = table.querySelector(`tbody tr[data-date="${date}"]`);
  if ((cat && !category) || !dayRow) { openCell = null; return; } // category or day went away

  const btn = cat
    ? dayRow.querySelector(`button.cell[data-cat="${CSS.escape(cat)}"]`)
    : dayRow.querySelector("button.day-total");
  btn.classList.add("open");
  btn.setAttribute("aria-expanded", "true");

  const items = doc.items
    .filter((i) => i.date === date && (cat ? i.cat === cat : doc.categories.some((c) => c.id === i.cat)))
    .sort((a, b) => a.t - b.t);
  const total = items.reduce((sum, i) => sum + i.a, 0);
  const count = (n) => `${n} expense${n === 1 ? "" : "s"}`;

  // How much each person put in, when more than one person contributed.
  const perPerson = new Map();
  for (const i of items) perPerson.set(i.by, (perPerson.get(i.by) ?? 0) + i.a);
  const byPerson = perPerson.size > 1
    ? `<ul class="by-person" aria-label="By person">${[...perPerson].map(([who, amt]) =>
        `<li><b>${esc(who)}</b> ${yen.format(amt)} <span>${fmtSgd(amt)}</span></li>`).join("")}</ul>`
    : "";

  let body;
  if (!items.length) {
    body = `<p class="muted">No expenses here yet.</p>`;
  } else if (category) {
    body = `<ul class="items-list">${items.map((i) => itemRow(i, false)).join("")}</ul>`;
  } else {
    // Whole day: one group per category, in column order, each with its subtotal.
    body = doc.categories.map((c) => {
      const group = items.filter((i) => i.cat === c.id);
      if (!group.length) return "";
      const sub = group.reduce((sum, i) => sum + i.a, 0);
      return `<section class="items-group">
        <h4><span>${esc(c.emoji)} ${esc(c.name)} <span class="muted">· ${count(group.length)}</span></span>
          <span class="item-amt">${yen.format(sub)}<span>${fmtSgd(sub)}</span></span></h4>
        <ul class="items-list">${group.map((i) => itemRow(i, false)).join("")}</ul>
      </section>`;
    }).join("");
  }

  const row = document.createElement("tr");
  row.className = "detail-row";
  // Span only the visible columns: on phones the S$ column is hidden, and spanning it
  // would add an empty column to the table.
  const columns = [...table.querySelectorAll("thead th")].filter((th) => th.offsetParent !== null).length;
  row.innerHTML = `<td colspan="${columns || doc.categories.length + 3}"><div class="detail" id="detail" role="region" aria-label="Breakdown">
    <div class="detail-head">
      <div>
        <h3>${category ? `${esc(category.emoji)} ${esc(category.name)}` : "Everything this day"}</h3>
        <p class="muted small">${fmtDay(date, { weekday: "long", month: "short", day: "numeric", year: "numeric" })} · ${count(items.length)}</p>
      </div>
      <div class="detail-sum">${yen.format(total)}<span>${fmtSgd(total)}</span></div>
    </div>
    ${byPerson}
    ${body}
    <div class="detail-actions">
      <button type="button" class="btn ghost" data-detail-close>▲ Close</button>
      <button type="button" class="btn" data-detail-add>＋ Add expense</button>
    </div>
  </div></td>`;
  dayRow.after(row);
}

function toggleDetail(date, cat) {
  const same = openCell && openCell.date === date && openCell.cat === cat;
  openCell = same ? null : { date, cat };
  renderDetail();
  if (openCell) $("#detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

$("#grid").addEventListener("click", async (e) => {
  const edit = e.target.closest("button[data-edit-item]");
  if (edit) return openAdd({}, doc.items.find((i) => i.id === edit.dataset.editItem));
  const del = e.target.closest("button[data-del]");
  if (del) {
    const item = doc.items.find((i) => i.id === del.dataset.del);
    if (!item) return;
    del.disabled = true;
    const ok = await runOp({ op: "deleteItem", id: item.id }, `Deleted ${yen.format(item.a)}${item.note ? ` (${item.note})` : ""}`);
    if (!ok) del.disabled = false;
    return;
  }
  if (e.target.closest("[data-detail-close]")) {
    openCell = null;
    return renderDetail();
  }
  if (e.target.closest("[data-detail-add]")) return openAdd({ date: openCell.date, cat: openCell.cat });

  const btn = e.target.closest("button.cell");
  if (!btn) return;
  const { date, cat } = btn.dataset;
  if (btn.classList.contains("day-total")) return toggleDetail(date, null);
  if (btn.classList.contains("empty")) return openAdd({ date, cat });
  toggleDetail(date, cat);
});

// Keep the dropdown as wide as the visible part of the table, even when the table scrolls sideways.
const sizeDetail = () => $(".grid-wrap").style.setProperty("--wrap-w", `${$(".grid-wrap").clientWidth}px`);
window.addEventListener("resize", () => {
  sizeDetail();
  if (openCell) renderDetail(); // the visible columns change between phone and desktop layouts
});
sizeDetail();

// ---------------------------------------------------------------- settings

function renderCatList() {
  const list = $("#catList");
  if (list.contains(document.activeElement)) return;
  list.innerHTML = doc.categories.map((c, i) => `
    <li data-id="${esc(c.id)}">
      <input class="emoji-in" name="emoji" value="${esc(c.emoji)}" maxlength="8" aria-label="Emoji" />
      <input name="name" value="${esc(c.name)}" maxlength="40" aria-label="Category name" />
      <span class="acts">
        <button type="button" class="icon-btn" data-act="up" title="Move left" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="icon-btn" data-act="down" title="Move right" ${i === doc.categories.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="icon-btn" data-act="del" title="Remove">🗑</button>
      </span>
    </li>`).join("");
}

$("#settingsBtn").addEventListener("click", () => {
  if (!doc) return;
  const f = $("#tripForm");
  for (const k of ["name", "start", "end", "budgetSgd", "rate"]) f.elements[k].value = doc.trip[k] || "";
  f.elements.autoRate.checked = !!doc.trip.autoRate;
  renderCatList();
  renderCardList();
  $("#people").innerHTML = people().map((p) => `<option value="${esc(p)}"></option>`).join("");
  renderBackups();
  $("#settingsDlg").showModal();
});

$("#closeSettings").addEventListener("click", () => $("#settingsDlg").close());

$("#tripForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const trip = { ...Object.fromEntries(new FormData(e.target)), autoRate: e.target.elements.autoRate.checked };
  if (await runOp({ op: "updateTrip", trip }, "Trip settings saved")) $("#settingsDlg").close();
});

$("#catForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { name, emoji } = Object.fromEntries(new FormData(e.target));
  if (await runOp({ op: "addCategory", name, emoji }, `Added ${name}`)) {
    e.target.reset();
    renderCatList();
  }
});

$("#catList").addEventListener("change", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  runOp({
    op: "editCategory",
    id: li.dataset.id,
    name: li.querySelector('[name="name"]').value,
    emoji: li.querySelector('[name="emoji"]').value,
  });
});

$("#catList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest("li").dataset.id;
  const cat = doc.categories.find((c) => c.id === id);
  if (btn.dataset.act === "del") {
    const used = doc.items.filter((i) => i.cat === id).length;
    const warn = used ? `\n\nThis also deletes its ${used} expense${used === 1 ? "" : "s"} for everyone.` : "";
    if (!confirm(`Remove "${cat.name}"?${warn}`)) return;
    await runOp({ op: "removeCategory", id }, `Removed ${cat.name}`);
  } else {
    await runOp({ op: "moveCategory", id, dir: btn.dataset.act === "up" ? -1 : 1 });
  }
  renderCatList();
});

// ---------------------------------------------------------------- add expense

const addForm = $("#addForm");

// Returns the entered price converted to whole yen, or NaN if it can't be read.
function addAmountYen() {
  const text = addForm.elements.amount.value.replace(/[¥￥円$,\s]|S\$/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return NaN;
  const n = Number(text);
  return Math.round(addForm.elements.cur.value === "SGD" ? n * yenPerSgd() : n);
}

function updateConvert() {
  const yenValue = addAmountYen();
  const out = $("#addConvert");
  if (Number.isNaN(yenValue)) {
    out.textContent = addForm.elements.cur.value === "SGD" ? "= ¥0" : "= S$0.00";
  } else {
    out.textContent = addForm.elements.cur.value === "SGD"
      ? `= ${yen.format(yenValue)}  ·  ${rateLabel()}`
      : `= ${fmtSgd(yenValue)}  ·  ${rateLabel()}`;
  }
}

// The category buttons are radio inputs; these read and set the chosen one.
const selectedCat = () => addForm.querySelector('input[name="cat"]:checked')?.value;
function selectCat(id) {
  const input = [...addForm.querySelectorAll('input[name="cat"]')].find((i) => i.value === id);
  if (input) input.checked = true;
}

let editingItem = null; // expense being edited, or null when adding
let overLimitOk = false; // second click on Save confirms going over a card's limit
const NEW_CARD = "__new";

function payMethod() {
  return addForm.elements.pay.value;
}

// Shows the fields for the chosen payment method and how the card's limit stands.
function updatePayUI() {
  const f = addForm.elements;
  const method = payMethod();
  const newCard = method === "card" && f.card.value === NEW_CARD;
  for (const el of addForm.querySelectorAll("[data-pay]")) {
    el.hidden = el.dataset.pay === "newcard" ? !newCard : el.dataset.pay !== method;
  }
  const status = $("#limitStatus");
  const submit = $("#addSubmit");
  const label = editingItem ? "Save changes" : "Add";
  const amount = addAmountYen();
  const card = method === "card" && !newCard && cardById(f.card.value);
  const limit = card ? card.limitSgd : newCard ? Number(f.cardLimit.value) : 0;
  if (method !== "card" || !(limit > 0)) {
    status.hidden = true;
    submit.textContent = label;
    return null;
  }
  const used = card ? cardSpentSgd(card.id, editingItem?.id) : 0;
  const after = used + (amount > 0 ? amount / yenPerSgd() : 0);
  const level = cardLevel(after, limit);
  const name = card ? cardLabel(card) : "New card";
  status.hidden = false;
  status.className = `limit-status ${level}`;
  status.textContent = `${name}: ${fmtS(used)} of ${fmtS(limit)} used → ${fmtS(after)} after this (${Math.round((after / limit) * 100)}%)` +
    (level === "over" ? ". This goes over the limit." : level === "near" ? ". Getting close to the limit." : "");
  submit.textContent = level === "over" && overLimitOk ? "Over limit: save anyway?" : label;
  return { level, after, limit, card };
}

// prefill: optional { date, cat } (cat may be null) when opened from the table.
// item: an existing expense to edit instead of adding a new one.
function openAdd(prefill = {}, item = null) {
  if (!doc) return;
  editingItem = item;
  overLimitOk = false;
  const f = addForm.elements;
  const days = tripDays();
  const today = localToday();
  const prevDate = f.date.value;
  const prevCat = selectedCat();
  f.date.innerHTML = days.map((d) =>
    `<option value="${d}">${fmtDay(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}${d === today ? " (today)" : ""}</option>`).join("");
  $("#catChoices").innerHTML = doc.categories.map((c, n) =>
    `<label class="cat-choice"><input type="radio" name="cat" value="${esc(c.id)}"${n === 0 ? " checked" : ""} required />` +
    `<span><span class="emoji">${esc(c.emoji)}</span>${esc(c.name)}</span></label>`).join("");
  f.card.innerHTML = (doc.cards ?? []).map((c) => `<option value="${esc(c.id)}">${esc(cardLabel(c))}</option>`).join("") +
    `<option value="${NEW_CARD}">＋ Add a new card…</option>`;
  $("#people").innerHTML = people().map((p) => `<option value="${esc(p)}"></option>`).join("");

  // Payment: the expense's own, else whatever this device used last, else your cash.
  let last = null;
  try { last = JSON.parse(store.get("trip.lastPay")); } catch { /* none */ }
  const pay = item ? { pay: item.pay ?? "cash", payer: item.payer, card: item.card } : last ?? { pay: "cash" };
  addForm.querySelector(`input[name="pay"][value="${pay.pay === "card" ? "card" : "cash"}"]`).checked = true;
  f.payer.value = (pay.pay === "cash" && pay.payer) || myName();
  f.card.value = cardById(pay.card) ? pay.card : (doc.cards?.[0]?.id ?? NEW_CARD);
  f.cardName.value = "";
  f.cardOwner.value = myName();
  f.cardLimit.value = "1000";

  if (item) {
    f.date.value = item.date;
    selectCat(item.cat);
    addForm.querySelector('input[name="cur"][value="JPY"]').checked = true;
    f.amount.value = String(item.a);
    f.note.value = item.note ?? "";
  } else {
    f.date.value = prefill.date ?? (days.includes(today) ? today : days.includes(prevDate) ? prevDate : days[0]);
    const cat = prefill.cat ?? prevCat;
    selectCat(cat);
    f.amount.value = "";
    f.note.value = "";
  }
  $("#addTitle").textContent = item ? "Edit expense" : "Add expense";
  updateConvert();
  updatePayUI();
  $("#addDlg").showModal();
  f.amount.focus();
}

for (const btn of document.querySelectorAll("[data-add]")) btn.addEventListener("click", () => openAdd());
$("#addCancel").addEventListener("click", () => $("#addDlg").close());
addForm.addEventListener("input", () => {
  overLimitOk = false;
  updateConvert();
  updatePayUI();
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = addAmountYen();
  if (!(amount > 0)) {
    toast("Enter a price, e.g. 1200 (or 10.50 in SGD)");
    addForm.elements.amount.focus();
    return;
  }
  const f = addForm.elements;
  const { date, cat, note } = Object.fromEntries(new FormData(addForm));
  const category = doc.categories.find((c) => c.id === cat);

  const payment = { pay: payMethod() };
  if (payment.pay === "cash") {
    payment.payer = f.payer.value.trim() || myName();
  } else if (f.card.value === NEW_CARD) {
    if (!f.cardName.value.trim() || !f.cardOwner.value.trim()) {
      toast("Give the new card a name and say whose it is");
      return (f.cardName.value.trim() ? f.cardOwner : f.cardName).focus();
    }
    payment.newCard = { name: f.cardName.value, owner: f.cardOwner.value, limitSgd: f.cardLimit.value };
  } else {
    payment.card = f.card.value;
  }

  // Going over a card's limit needs a second click on Save.
  const limit = updatePayUI();
  if (limit?.level === "over" && !overLimitOk) {
    overLimitOk = true;
    updatePayUI();
    toast(`This takes the card over its ${fmtS(limit.limit)} limit. Click again to save anyway.`);
    return;
  }

  const submit = $("#addSubmit");
  submit.disabled = true;
  const op = editingItem
    ? { op: "updateItem", id: editingItem.id, date, cat, amount, note, ...payment }
    : { op: "addItem", date, cat, amount, note, ...payment };
  const ok = await runOp(op, editingItem
    ? `Saved ${yen.format(amount)} (${fmtSgd(amount)})`
    : `Added ${yen.format(amount)} (${fmtSgd(amount)}) to ${category.name} on ${fmtDay(date)}`);
  submit.disabled = false;
  if (!ok) return;

  // Remember how this device usually pays, and warn if the card is near its limit.
  const card = payment.newCard
    ? doc.cards.findLast((c) => c.name === payment.newCard.name.trim() && c.owner === payment.newCard.owner.trim())
    : cardById(payment.card);
  store.set("trip.lastPay", JSON.stringify({ pay: payment.pay, payer: payment.payer, card: card?.id }));
  if (card) {
    const used = cardSpentSgd(card.id);
    if (cardLevel(used, card.limitSgd)) toast(cardWarning(card, used));
  }
  $("#addDlg").close();
});

// ---------------------------------------------------------------- cards and backups (settings)

function renderCardList() {
  const list = $("#cardList");
  if (list.contains(document.activeElement)) return;
  const cards = doc.cards ?? [];
  list.innerHTML = cards.length ? cards.map((c) => {
    const used = doc.items.filter((i) => i.card === c.id).length;
    return `<li data-id="${esc(c.id)}">
      <input name="name" value="${esc(c.name)}" maxlength="40" aria-label="Card name" />
      <input name="owner" value="${esc(c.owner)}" maxlength="30" list="people" aria-label="Whose card" />
      <input name="limitSgd" type="number" min="1" step="any" value="${c.limitSgd}" aria-label="Limit in S$" />
      <button type="button" class="icon-btn" data-remove-card ${used ? `disabled title="Used by ${used} expense${used === 1 ? "" : "s"}"` : 'title="Remove card"'}>🗑</button>
    </li>`;
  }).join("") : `<li class="muted small">No cards yet.</li>`;
}

$("#cardList").addEventListener("change", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const card = Object.fromEntries([...li.querySelectorAll("input")].map((i) => [i.name, i.value]));
  runOp({ op: "editCard", id: li.dataset.id, card }, "Card updated");
});

$("#cardList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove-card]");
  if (btn) await runOp({ op: "removeCard", id: btn.closest("li").dataset.id }, "Card removed");
});

$("#cardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const card = Object.fromEntries(new FormData(e.target));
  if (await runOp({ op: "addCard", card }, `Added ${card.owner}'s ${card.name}`)) {
    e.target.reset();
    renderCardList();
  }
});

let backupDoc = "trip";

async function renderBackups() {
  const list = $("#backupList");
  list.innerHTML = `<li class="muted small">Loading backups…</li>`;
  try {
    const { backups, total } = await fetchJson(`/api/backups?doc=${backupDoc}`);
    const noun = backupDoc === "trip" ? "expense" : "journal entr";
    list.innerHTML = backups.length ? backups.map((b) => `<li data-key="${esc(b.key)}">
        <span><b>${new Date(b.t).toLocaleString("en-SG", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</b>
          <span class="muted small">· ${b.count} ${noun}${b.count === 1 ? (backupDoc === "trip" ? "" : "y") : (backupDoc === "trip" ? "s" : "ies")} · version ${b.version}</span></span>
        <span class="acts">
          <button type="button" class="icon-btn" data-download-backup title="Download this backup">⬇️</button>
          <button type="button" class="btn ghost" data-restore>Restore</button>
        </span>
      </li>`).join("") + (total > backups.length ? `<li class="muted small">…and ${total - backups.length} older backups</li>` : "")
      : `<li class="muted small">No backups yet. They start with the next change, or use 💾 Back up now.</li>`;
  } catch (err) {
    list.innerHTML = `<li class="muted small">Couldn't load backups: ${esc(err.message)}</li>`;
  }
}

$(".backup-doc").addEventListener("change", (e) => {
  backupDoc = e.target.value;
  renderBackups();
});

$("#backupNow").addEventListener("click", async () => {
  try {
    const { saved } = await postJson("/api/backups", { op: "snapshot" });
    toast(`Backed up ${saved} document${saved === 1 ? "" : "s"}`);
    renderBackups();
  } catch (err) {
    toast(`Backup failed: ${err.message}`);
  }
});

$("#downloadAll").addEventListener("click", async () => {
  try {
    const [{ doc: trip }, { doc: journal }] = await Promise.all([fetchJson("/api/trip"), fetchJson("/api/journal")]);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadFile(`${doc.trip.name.replace(/[^\w-]+/g, "_")}_all-data_${stamp}.json`,
      JSON.stringify({ exportedAt: new Date().toISOString(), trip, journal }, null, 2), "application/json");
  } catch (err) {
    toast(`Download failed: ${err.message}`);
  }
});

$("#backupList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-key]");
  if (!li) return;
  const key = li.dataset.key;
  if (e.target.closest("[data-download-backup]")) {
    try {
      downloadFile(`${key.replace(/[^\w-]+/g, "_")}.json`, JSON.stringify(await fetchJson(`/api/backups?key=${encodeURIComponent(key)}`), null, 2), "application/json");
    } catch (err) {
      toast(`Download failed: ${err.message}`);
    }
    return;
  }
  const btn = e.target.closest("[data-restore]");
  if (!btn) return;
  // Restoring replaces everyone's current data, so it takes a second click.
  if (!btn.classList.contains("armed")) {
    btn.classList.add("armed");
    btn.textContent = "Replace current data?";
    setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "Restore"; }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await postJson("/api/backups", { op: "restore", key });
    toast(backupDoc === "trip" ? "Expenses restored from the backup" : "Journal restored from the backup");
    sync.poll();
    renderBackups();
  } catch (err) {
    toast(`Restore failed: ${err.message}`);
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- export

$("#csvBtn").addEventListener("click", () => {
  if (!doc) return;
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const catName = (id) => doc.categories.find((c) => c.id === id)?.name ?? id;
  const items = [...doc.items].sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
  const lines = [
    ["Date", "Category", "Note", "Amount (JPY)", "Amount (SGD)", "Added by", "Paid with", "Whose", "Card"].map(q).join(","),
    ...items.map((i) => [i.date, q(catName(i.cat)), q(i.note ?? ""), i.a, (i.a / yenPerSgd()).toFixed(2), q(i.by),
      q(i.pay ?? ""), q(i.payer ?? ""), q(cardById(i.card)?.name ?? "")].join(",")),
  ];
  downloadFile(`${doc.trip.name.replace(/[^\w-]+/g, "_")}_expenses.csv`, lines.join("\n"), "text/csv");
});

// ---------------------------------------------------------------- boot

setInterval(() => { if (doc) renderLog(); }, 30000);

// ---------------------------------------------------------------- install on your phone

let installPrompt = null; // Chrome's "install this site as an app" prompt, when it offers one

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#installBtn").hidden = false;
});

$("#installBtn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#installBtn").hidden = true;
});

function installHelp() {
  const ua = navigator.userAgent;
  const iPhone = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  $("#apkLink").hidden = iPhone;
  if (matchMedia("(display-mode: standalone)").matches) return "You're using the installed app.";
  if (iPhone) return "On iPhone: open this page in Safari, tap Share, then Add to Home Screen.";
  if (/Android/.test(ua)) {
    return installPrompt
      ? "Install app adds it to your home screen without an APK. Or download the Android app."
      : "In Chrome, tap ⋮ then Add to Home screen (or Install app). Or download the Android app.";
  }
  return "Open this page on your phone to install it.";
}

$("#settingsBtn").addEventListener("click", () => { $("#installHelp").textContent = installHelp(); });
$("#appSection").hidden = inAndroidApp(); // no need to offer the app inside the app
setupIdentity();
sync.start();
refreshLiveRate();
setInterval(refreshLiveRate, RATE_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLiveRate(); });
