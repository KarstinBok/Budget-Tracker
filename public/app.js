// Japan trip budget tracker – client.
// Talks to /api/trip (netlify/functions/trip.mjs). Every change is sent as a small
// operation; every few seconds the page polls for a newer version of the shared
// document so everyone sees each other's changes live.

const API = "/api/trip";
const POLL_MS = 3000;
const POLL_HIDDEN_MS = 20000;
const DAY_MS = 86400000;
const CLIENT_SCHEMA = 2; // matches SCHEMA in the function; a newer doc means this page is outdated

const $ = (sel) => document.querySelector(sel);
const yen = new Intl.NumberFormat("en-US", { style: "currency", currency: "JPY" });
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let doc = null;
let me = store.get("trip.name") || "";
let passcode = store.get("trip.code") || "";
let pollTimer = null;
let inflight = 0;
let gridSignature = "";
let openCell = null; // { date, cat } whose breakdown is dropped down in the table; cat null = whole day

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const toMs = (iso) => Date.parse(iso + "T00:00:00Z");
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

function fmtDay(iso, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(toMs(iso)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

const sgdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ¥ per S$1: the live rate when enabled and available, otherwise the trip's manual rate.
function yenPerSgd() {
  return doc.trip.autoRate && liveRate ? liveRate.rate : doc.trip.rate;
}

function fmtSgd(amountYen) {
  return `S$${sgdFmt.format(amountYen / yenPerSgd())}`;
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

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 3200);
}

function setSync(state, label) {
  const el = $("#sync");
  el.className = `sync ${state}`;
  el.querySelector("span").textContent = label;
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

// ---------------------------------------------------------------- network

async function api(method, body) {
  const url = method === "GET" && doc ? `${API}?v=${doc.version}` : API;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(passcode ? { "x-trip-code": passcode } : {}) },
    body: body ? JSON.stringify({ ...body, by: me }) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    askPasscode();
    throw new Error("Passcode required");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function send(op) {
  inflight++;
  setSync("saving", "Saving…");
  try {
    const data = await api("POST", op);
    return data;
  } finally {
    inflight--;
  }
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await api("GET");
    if (data.changed) applyDoc(data.doc, true);
    if (!inflight) setSync("live", "Live");
  } catch (err) {
    setSync("offline", navigator.onLine ? "Reconnecting…" : "Offline");
    if (err.message !== "Passcode required") console.warn(err);
  }
  pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
}

function applyDoc(next, fromRemote) {
  if ((next.schema ?? 1) > CLIENT_SCHEMA) return location.reload(); // the app was updated
  if (doc && next.version < doc.version) return; // stale response
  const prev = doc;
  doc = next;
  render(fromRemote && prev ? prev : null);
  if (!inflight) setSync("live", "Live");
}

async function runOp(op, okMsg) {
  try {
    const data = await send(op);
    applyDoc(data.doc, false);
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    toast(err.message);
    setSync("offline", "Not saved");
    return false;
  }
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
  $("#whoName").textContent = me || "Set name";

  renderCards(stats);
  renderGrid(stats, prevDoc);
  renderBreakdown(stats);
  renderLog();
  if ($("#settingsDlg").open) renderCatList();
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

function renderGrid({ days, sums, byDay, byCat, total, loggedDays }, prevDoc) {
  const cats = doc.categories;
  const table = $("#grid");
  const signature = gridSig();
  const today = localToday();

  if (signature !== gridSignature) {
    gridSignature = signature;
    const startMs = toMs(doc.trip.start);
    const head = `<thead><tr><th scope="col">Day</th>${cats.map((c) =>
      `<th scope="col"><span class="emoji">${esc(c.emoji)}</span>${esc(c.name)}</th>`).join("")}<th scope="col">Total ¥</th><th scope="col">Total S$</th></tr></thead>`;
    const body = days.map((d) => {
      const n = Math.round((toMs(d) - startMs) / DAY_MS) + 1;
      const inside = d >= doc.trip.start && d <= doc.trip.end;
      return `<tr class="${d === today ? "today" : ""} ${inside ? "" : "outside"}" data-date="${d}">
        <th scope="row"><span class="day-label">${fmtDay(d)}</span><span class="day-sub">${inside ? `Day ${n}` : ""}${d === today ? " · today" : ""}</span></th>
        ${cats.map((c) => `<td><button type="button" class="cell" data-date="${d}" data-cat="${esc(c.id)}"></button></td>`).join("")}
        <td class="total"><button type="button" class="cell day-total" data-date="${d}"></button></td>
        <td class="total sgd-col" data-total-sgd="${d}"></td>
      </tr>`;
    }).join("");
    const foot = `<tfoot>
      <tr><th scope="row">Total</th>${cats.map((c) => `<td data-cat-total="${esc(c.id)}"></td>`).join("")}<td data-grand></td><td class="sgd-col" data-grand-sgd></td></tr>
      <tr class="avg"><th scope="row">Avg / day</th>${cats.map((c) => `<td data-cat-avg="${esc(c.id)}"></td>`).join("")}<td data-grand-avg></td><td class="sgd-col" data-grand-avg-sgd></td></tr>
    </tfoot>`;
    table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }

  const prevSums = prevDoc ? cellSums(prevDoc.items ?? []) : null;
  for (const btn of table.querySelectorAll("button.cell:not(.day-total)")) {
    const { date, cat } = btn.dataset;
    const cell = sums[date]?.[cat];
    const catName = doc.categories.find((c) => c.id === cat)?.name;
    btn.textContent = cell ? plain.format(cell.sum) : "–";
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
    btn.textContent = v ? plain.format(v) : "";
    btn.disabled = !v;
    btn.title = v ? "Click for the day's breakdown" : "";
  }
  for (const td of table.querySelectorAll("[data-total-sgd]")) {
    const v = byDay[td.dataset.totalSgd];
    td.textContent = v ? fmtSgd(v) : "";
  }
  for (const c of cats) {
    table.querySelector(`[data-cat-total="${CSS.escape(c.id)}"]`).textContent = yen.format(byCat[c.id]);
    table.querySelector(`[data-cat-avg="${CSS.escape(c.id)}"]`).textContent =
      yen.format(loggedDays ? Math.round(byCat[c.id] / loggedDays) : 0);
  }
  table.querySelector("[data-grand]").textContent = yen.format(total);
  table.querySelector("[data-grand-avg]").textContent = yen.format(loggedDays ? Math.round(total / loggedDays) : 0);
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
      <span class="item-note">${showCat ? `${esc(cat.emoji)} ` : ""}${i.note ? esc(i.note) : '<span class="muted">No note</span>'}</span>
      <span class="item-meta">Added by ${esc(i.by)} · ${timeAgo(i.t)}</span>
    </div>
    <div class="item-amt">${yen.format(i.a)}<span>${fmtSgd(i.a)}</span></div>
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
  row.innerHTML = `<td colspan="${doc.categories.length + 3}"><div class="detail" id="detail" role="region" aria-label="Breakdown">
    <div class="detail-head">
      <div>
        <h3>${category ? `${esc(category.emoji)} ${esc(category.name)}` : "Everything this day"}</h3>
        <p class="muted small">${fmtDay(date, { weekday: "long", month: "short", day: "numeric", year: "numeric" })} · ${count(items.length)}</p>
      </div>
      <div class="detail-sum">${yen.format(total)}<span>${fmtSgd(total)}</span></div>
    </div>
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
  const del = e.target.closest("button[data-del]");
  if (del) {
    const item = doc.items.find((i) => i.id === del.dataset.del);
    if (!item) return;
    if (!confirm(`Delete ${yen.format(item.a)}${item.note ? ` (${item.note})` : ""}? This removes it for everyone.`)) return;
    await runOp({ op: "deleteItem", id: item.id }, `Deleted ${yen.format(item.a)}`);
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
window.addEventListener("resize", sizeDetail);
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

// prefill: optional { date, cat } (cat may be null) when opened from the table.
function openAdd(prefill = {}) {
  if (!doc) return;
  const days = tripDays();
  const today = localToday();
  const prevDate = addForm.elements.date.value;
  const prevCat = addForm.elements.cat.value;
  addForm.elements.date.innerHTML = days.map((d) =>
    `<option value="${d}">${fmtDay(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}${d === today ? " (today)" : ""}</option>`).join("");
  addForm.elements.cat.innerHTML = doc.categories.map((c) =>
    `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join("");
  addForm.elements.date.value = prefill.date ?? (days.includes(today) ? today : days.includes(prevDate) ? prevDate : days[0]);
  const cat = prefill.cat ?? prevCat;
  if (doc.categories.some((c) => c.id === cat)) addForm.elements.cat.value = cat;
  addForm.elements.amount.value = "";
  addForm.elements.note.value = "";
  updateConvert();
  $("#addDlg").showModal();
  addForm.elements.amount.focus();
}

for (const btn of document.querySelectorAll("[data-add]")) btn.addEventListener("click", () => openAdd());
$("#addCancel").addEventListener("click", () => $("#addDlg").close());
addForm.addEventListener("input", updateConvert);

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = addAmountYen();
  if (!(amount > 0)) {
    toast("Enter a price, e.g. 1200 (or 10.50 in SGD)");
    addForm.elements.amount.focus();
    return;
  }
  const { date, cat, note } = Object.fromEntries(new FormData(addForm));
  const category = doc.categories.find((c) => c.id === cat);
  const submit = addForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  const ok = await runOp(
    { op: "addItem", date, cat, amount, note },
    `Added ${yen.format(amount)} (${fmtSgd(amount)}) to ${category.name} on ${fmtDay(date)}`,
  );
  submit.disabled = false;
  if (ok) $("#addDlg").close();
});

// ---------------------------------------------------------------- name / passcode

function askName() {
  $("#nameInput").value = me;
  $("#nameDlg").showModal();
}

$("#nameForm").addEventListener("submit", () => {
  me = $("#nameInput").value.trim().slice(0, 30);
  store.set("trip.name", me);
  $("#whoName").textContent = me || "Set name";
});

$("#whoBtn").addEventListener("click", askName);

function askPasscode() {
  if ($("#codeDlg").open) return;
  $("#codeInput").value = "";
  $("#codeDlg").showModal();
}

$("#codeForm").addEventListener("submit", () => {
  passcode = $("#codeInput").value;
  store.set("trip.code", passcode);
  poll();
});

// ---------------------------------------------------------------- export

$("#csvBtn").addEventListener("click", () => {
  if (!doc) return;
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const catName = (id) => doc.categories.find((c) => c.id === id)?.name ?? id;
  const items = [...doc.items].sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
  const lines = [
    ["Date", "Category", "Note", "Amount (JPY)", "Amount (SGD)", "Added by"].map(q).join(","),
    ...items.map((i) => [i.date, q(catName(i.cat)), q(i.note ?? ""), i.a, (i.a / yenPerSgd()).toFixed(2), q(i.by)].join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `${doc.trip.name.replace(/[^\w-]+/g, "_")}_expenses.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- boot

document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
window.addEventListener("online", poll);
setInterval(() => { if (doc) renderLog(); }, 30000);

if (!me) askName();
poll();
refreshLiveRate();
setInterval(refreshLiveRate, RATE_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLiveRate(); });
