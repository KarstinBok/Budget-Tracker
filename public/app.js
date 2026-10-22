// Japan trip budget tracker – client.
// Talks to /api/trip (netlify/functions/trip.mjs). Every edit is sent as a small
// operation; every few seconds the page polls for a newer version of the shared
// document so everyone sees each other's changes live.

const API = "/api/trip";
const POLL_MS = 3000;
const POLL_HIDDEN_MS = 20000;
const DAY_MS = 86400000;

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
const pending = new Map(); // "date|cat" -> amount not yet confirmed by the server

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

function fmtHome(amountYen) {
  const { currency, rate } = doc.trip;
  const v = amountYen / rate;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
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

// Accepts "3200", "3,200", "¥3200", "1200+850+300". Empty means 0. Returns NaN if unreadable.
function parseAmount(text) {
  const cleaned = String(text).replace(/[¥￥円,\s]/g, "");
  if (cleaned === "") return 0;
  if (!/^\d+(\.\d+)?(\+\d+(\.\d+)?)*$/.test(cleaned)) return NaN;
  return Math.round(cleaned.split("+").reduce((sum, n) => sum + Number(n), 0));
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
  for (const d of Object.keys(doc.cells)) set.add(d);
  return [...set].sort();
}

function cellValue(date, cat) {
  const key = `${date}|${cat}`;
  if (pending.has(key)) return pending.get(key);
  return doc.cells[date]?.[cat]?.a ?? 0;
}

function computeStats() {
  const days = tripDays();
  const cats = doc.categories;
  const byDay = {};
  const byCat = Object.fromEntries(cats.map((c) => [c.id, 0]));
  let total = 0;
  for (const d of days) {
    let dayTotal = 0;
    for (const c of cats) {
      const v = cellValue(d, c.id);
      dayTotal += v;
      byCat[c.id] += v;
    }
    byDay[d] = dayTotal;
    total += dayTotal;
  }
  const loggedDays = days.filter((d) => byDay[d] > 0).length;
  return { days, byDay, byCat, total, loggedDays };
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
  if (doc && next.version < doc.version) return; // stale response
  const prev = doc;
  doc = next;
  render(fromRemote && prev ? prev : null);
  if (!inflight) setSync("live", "Live");
}

async function setCell(date, cat, amount) {
  const key = `${date}|${cat}`;
  pending.set(key, amount);
  render();
  try {
    const data = await send({ op: "setCell", date, cat, amount });
    if (pending.get(key) === amount) pending.delete(key);
    applyDoc(data.doc, false);
  } catch (err) {
    if (pending.get(key) === amount) pending.delete(key);
    render();
    toast(`Couldn't save: ${err.message}`);
    setSync("offline", "Not saved");
  }
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
  // If the table layout is about to change (someone added a category or changed the
  // dates) while you're typing in a cell, save that cell first and refocus it afterwards.
  const active = document.activeElement;
  let refocus = null;
  if (active?.matches?.("input.cell") && gridSig() !== gridSignature) {
    refocus = { ...active.dataset };
    active.blur();
  }
  const stats = computeStats();
  document.title = `${doc.trip.name} · Budget`;
  $("#tripName").textContent = doc.trip.name;
  const nights = Math.round((toMs(doc.trip.end) - toMs(doc.trip.start)) / DAY_MS) + 1;
  $("#tripDates").textContent =
    `${fmtDay(doc.trip.start, { month: "short", day: "numeric" })} – ${fmtDay(doc.trip.end, { month: "short", day: "numeric", year: "numeric" })} · ${nights} days · ¥${plain.format(doc.trip.rate)} = 1 ${doc.trip.currency}`;
  $("#whoName").textContent = me || "Set name";

  renderCards(stats);
  renderGrid(stats, prevDoc);
  renderBreakdown(stats);
  renderLog();
  if ($("#settingsDlg").open) renderCatList();
  if (refocus) {
    $("#grid").querySelector(`input.cell[data-date="${refocus.date}"][data-cat="${CSS.escape(refocus.cat)}"]`)?.focus();
  }
}

function renderCards({ total, loggedDays, byDay, days }) {
  $("#sumTotal").textContent = yen.format(total);
  $("#sumTotalHome").textContent = `≈ ${fmtHome(total)}`;

  const avg = loggedDays ? total / loggedDays : 0;
  $("#sumAvg").textContent = yen.format(Math.round(avg));
  $("#sumAvgNote").textContent = loggedDays
    ? `≈ ${fmtHome(avg)} · over ${loggedDays} day${loggedDays === 1 ? "" : "s"} with spending`
    : "No spending logged yet";

  const { budget, end, start } = doc.trip;
  const meter = $("#budgetMeter");
  if (budget > 0) {
    const left = budget - total;
    const pct = Math.min(100, (total / budget) * 100);
    $("#sumBudget").textContent = left >= 0 ? `${yen.format(left)} left` : `${yen.format(-left)} over`;
    meter.hidden = false;
    meter.className = `meter ${pct >= 100 ? "over" : pct >= 85 ? "near" : ""}`;
    meter.firstElementChild.style.width = `${pct}%`;
    const today = localToday();
    const from = today > start ? today : start;
    const remainingDays = from <= end ? Math.round((toMs(end) - toMs(from)) / DAY_MS) + 1 : 0;
    $("#sumBudgetNote").textContent = remainingDays && left > 0
      ? `${Math.round(pct)}% of ${yen.format(budget)} · ${yen.format(Math.floor(left / remainingDays))}/day for ${remainingDays} day${remainingDays === 1 ? "" : "s"} left`
      : `${Math.round(pct)}% of ${yen.format(budget)} used`;
  } else {
    $("#sumBudget").textContent = "—";
    meter.hidden = true;
    $("#sumBudgetNote").textContent = "Set a budget in Settings";
  }

  const maxDay = days.reduce((best, d) => (byDay[d] > (byDay[best] ?? 0) ? d : best), null);
  $("#sumMaxDay").textContent = maxDay ? yen.format(byDay[maxDay]) : "—";
  $("#sumMaxDayNote").textContent = maxDay ? fmtDay(maxDay, { weekday: "long", month: "short", day: "numeric" }) : "";
}

function renderGrid({ days, byDay, byCat, total, loggedDays }, prevDoc) {
  const cats = doc.categories;
  const table = $("#grid");
  const signature = gridSig();
  const today = localToday();

  if (signature !== gridSignature) {
    gridSignature = signature;
    const startMs = toMs(doc.trip.start);
    const head = `<thead><tr><th scope="col">Day</th>${cats.map((c) =>
      `<th scope="col"><span class="emoji">${esc(c.emoji)}</span>${esc(c.name)}</th>`).join("")}<th scope="col">Total</th></tr></thead>`;
    const body = days.map((d) => {
      const n = Math.round((toMs(d) - startMs) / DAY_MS) + 1;
      const inside = d >= doc.trip.start && d <= doc.trip.end;
      return `<tr class="${d === today ? "today" : ""} ${inside ? "" : "outside"}" data-date="${d}">
        <th scope="row"><span class="day-label">${fmtDay(d)}</span><span class="day-sub">${inside ? `Day ${n}` : ""}${d === today ? " · today" : ""}</span></th>
        ${cats.map((c) => `<td><input class="cell" data-date="${d}" data-cat="${esc(c.id)}" inputmode="decimal" autocomplete="off" placeholder="–" aria-label="${esc(c.name)} on ${fmtDay(d)}" /></td>`).join("")}
        <td class="total" data-total="${d}"></td>
      </tr>`;
    }).join("");
    const foot = `<tfoot>
      <tr><th scope="row">Total</th>${cats.map((c) => `<td data-cat-total="${esc(c.id)}"></td>`).join("")}<td data-grand></td></tr>
      <tr class="avg"><th scope="row">Avg / day</th>${cats.map((c) => `<td data-cat-avg="${esc(c.id)}"></td>`).join("")}<td data-grand-avg></td></tr>
    </tfoot>`;
    table.innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }

  for (const input of table.querySelectorAll("input.cell")) {
    const { date, cat } = input.dataset;
    const v = cellValue(date, cat);
    if (document.activeElement !== input) input.value = v ? plain.format(v) : "";
    const entry = doc.cells[date]?.[cat];
    input.title = entry ? `${yen.format(entry.a)} · last set by ${entry.by} ${timeAgo(entry.t)}` : "";
    if (prevDoc) {
      const before = prevDoc.cells[date]?.[cat]?.a ?? 0;
      if (before !== (entry?.a ?? 0)) {
        input.classList.remove("flash");
        void input.offsetWidth; // restart the animation
        input.classList.add("flash");
      }
    }
  }
  for (const td of table.querySelectorAll("[data-total]")) {
    const v = byDay[td.dataset.total];
    td.textContent = v ? plain.format(v) : "";
  }
  for (const c of cats) {
    table.querySelector(`[data-cat-total="${CSS.escape(c.id)}"]`).textContent = yen.format(byCat[c.id]);
    table.querySelector(`[data-cat-avg="${CSS.escape(c.id)}"]`).textContent =
      yen.format(loggedDays ? Math.round(byCat[c.id] / loggedDays) : 0);
  }
  table.querySelector("[data-grand]").textContent = yen.format(total);
  table.querySelector("[data-grand-avg]").textContent = yen.format(loggedDays ? Math.round(total / loggedDays) : 0);
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
        <td class="num">${yen.format(v)}<div class="muted small">≈ ${fmtHome(v)}</div></td>
        <td class="num">${yen.format(loggedDays ? Math.round(v / loggedDays) : 0)}</td>
        <td class="num">${total ? Math.round((v / total) * 100) : 0}%</td>
      </tr>`;
    }).join("")}</tbody>`;
}

function renderLog() {
  const items = doc.log.slice(0, 40);
  $("#log").innerHTML = items.length
    ? items.map((e) => `<li><b>${esc(e.by)}</b> ${esc(e.msg)}<time datetime="${new Date(e.t).toISOString()}">${timeAgo(e.t)}</time></li>`).join("")
    : `<li class="empty">No changes yet. Start by entering an amount in the table above.</li>`;
}

// ---------------------------------------------------------------- grid editing

function commitCell(input) {
  const { date, cat } = input.dataset;
  const current = cellValue(date, cat);
  const amount = parseAmount(input.value);
  if (Number.isNaN(amount)) {
    input.classList.add("err");
    toast("Couldn't read that amount – use numbers like 1200 or 800+450");
    input.value = current ? plain.format(current) : "";
    setTimeout(() => input.classList.remove("err"), 1500);
    return;
  }
  input.value = amount ? plain.format(amount) : "";
  if (amount !== current) setCell(date, cat, amount);
}

function moveFocus(input, rowDelta, colDelta) {
  const cells = [...$("#grid").querySelectorAll("input.cell")];
  const cols = doc.categories.length;
  const i = cells.indexOf(input);
  const target = cells[i + rowDelta * cols + colDelta];
  if (target) target.focus();
}

$("#grid").addEventListener("focusin", (e) => {
  const input = e.target.closest("input.cell");
  if (!input) return;
  const v = cellValue(input.dataset.date, input.dataset.cat);
  input.value = v ? String(v) : "";
  input.dataset.orig = input.value;
  requestAnimationFrame(() => input.select());
});

$("#grid").addEventListener("focusout", (e) => {
  const input = e.target.closest("input.cell");
  if (input) commitCell(input);
});

$("#grid").addEventListener("keydown", (e) => {
  const input = e.target.closest("input.cell");
  if (!input) return;
  if (e.key === "Enter") {
    e.preventDefault();
    moveFocus(input, e.shiftKey ? -1 : 1, 0);
    if (document.activeElement === input) input.blur();
  } else if (e.key === "Escape") {
    input.value = input.dataset.orig ?? "";
    input.blur();
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey) {
    e.preventDefault();
    moveFocus(input, e.key === "ArrowDown" ? 1 : -1, 0);
  }
});

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
  for (const k of ["name", "start", "end", "budget", "currency", "rate"]) f.elements[k].value = doc.trip[k] || "";
  renderCatList();
  $("#settingsDlg").showModal();
});

$("#closeSettings").addEventListener("click", () => $("#settingsDlg").close());

$("#tripForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const trip = Object.fromEntries(new FormData(e.target));
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
    const used = Object.values(doc.cells).filter((day) => day[id]).length;
    const warn = used ? `\n\nThis also deletes its amounts on ${used} day${used === 1 ? "" : "s"} for everyone.` : "";
    if (!confirm(`Remove "${cat.name}"?${warn}`)) return;
    await runOp({ op: "removeCategory", id }, `Removed ${cat.name}`);
  } else {
    await runOp({ op: "moveCategory", id, dir: btn.dataset.act === "up" ? -1 : 1 });
  }
  renderCatList();
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
  const { days, byDay, byCat, total } = computeStats();
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [
    ["Date", ...doc.categories.map((c) => c.name), "Total"].map(q).join(","),
    ...days.map((d) => [d, ...doc.categories.map((c) => cellValue(d, c.id)), byDay[d]].join(",")),
    ["Total", ...doc.categories.map((c) => byCat[c.id]), total].map((v, i) => (i === 0 ? q(v) : v)).join(","),
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
