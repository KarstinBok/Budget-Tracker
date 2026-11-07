// Everyday expenses – client for /daily/ (netlify/functions/daily.mjs, /api/daily).
// Two screens on one page: 👤 Personal (each person's own spending, visible to both) and
// 🤝 Shared (spending that is split, with who owes whom). Changes sync live like the
// Japan trip tracker; amounts are whole cents in SGD. Expenses can say which card paid:
// using the other person's card on your own expense means paying them back.

import {
  $, esc, store, localToday, fmtDay, timeAgo, toast, downloadFile,
  myName, setupIdentity, createSync, launchAction, returnHomeAfter,
} from "/common.js";
import { borrowedOf, settleUp } from "/calc.js";

let doc = null;
let screen = "personal";
let month = localToday().slice(0, 7); // "YYYY-MM"
let filter = store.get("daily.filter") || ""; // personal screen: a person, or "all"
let openCell = null; // { date, cat } dropped down in the table; cat null = whole day
let editing = null; // expense being edited in the dialog
let view = "home";
let chartEnd = null; // last month in the 6-month chart, when paged back with ‹ › // 🏠 home (spending by day) or 📊 overview (cards, summary, table)
let gridFrom = null; // earliest day the table shows, when a date further back was picked
let gridToTop = true; // next table render scrolls back to today
let cardTouched = false; // the card was picked by hand in the open dialog, so don't suggest one

const sync = createSync({
  path: "/api/daily",
  schema: 1,
  onDoc(next) {
    doc = next;
    render();
    quickAction();
  },
});

// From the home page: /daily/?add=personal|shared|payment opens that dialog straight away.
function quickAction() {
  const action = launchAction();
  if (action === "personal" || action === "shared") {
    history.replaceState(null, "", `${location.pathname}#${action}`);
    screen = action;
    render();
    openAdd();
    returnHomeAfter($("#addDlg"));
  } else if (action === "payment") {
    history.replaceState(null, "", `${location.pathname}#shared`);
    screen = "shared";
    render();
    $("#settleBtn").click();
    returnHomeAfter($("#settleDlg"));
  }
}

// ---------------------------------------------------------------- formatting

const twoDp = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = (c) => `S$${twoDp.format(c / 100)}`;
// Table cells: the exact amount, plus a whole-dollar form the phone layout shows instead.
const cell = (c) => `<span class="n-full">${twoDp.format(c / 100)}</span><span class="n-short">${whole.format(c / 100)}</span>`;

// "12.50", "$12.5", "S$ 12" -> 1250 cents, or NaN.
function parseCents(text) {
  const t = String(text).replace(/S?\$|,|\s/gi, "");
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN;
}

const monthName = (ym, opts = { month: "long", year: "numeric" }) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

function shiftMonth(ym, by) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function daysOf(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = localToday();
  const days = [];
  for (let d = 1; d <= last; d++) {
    const iso = `${ym}-${String(d).padStart(2, "0")}`;
    if (iso <= today) days.push(iso);
  }
  return days.reverse(); // newest first
}

// ---------------------------------------------------------------- people

const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, "");
// The listed person this device's name belongs to ("Karstin Bok" -> Karstin).
function me() {
  const n = norm(myName());
  return doc.people.find((p) => n && (norm(p) === n || n.startsWith(norm(p)) || norm(p).startsWith(n))) ?? null;
}

const cardOf = (id) => (id && doc.cards.find((c) => c.id === id)) || null;
const cardLabel = (c) => `${c.emoji} ${c.owner}'s ${c.name}`;
// A personal expense paid with someone else's card: who owes whom.
const borrowed = (i) => borrowedOf(doc, i);

const catOf = (id) => doc.categories.find((c) => c.id === id) ?? { id, name: "Other", emoji: "📦" };

// ---------------------------------------------------------------- data

// The expenses this screen shows for a month.
function itemsFor(ym, who = filter) {
  return doc.items.filter((i) => i.kind === screen && i.date.startsWith(ym) &&
    (screen === "shared" || who === "all" || i.owner === who));
}

const sum = (items) => items.reduce((s, i) => s + i.a, 0);

// Who owes whom over all time (shared expenses, borrowed cards and payments).
const balances = () => settleUp(doc);

// ---------------------------------------------------------------- rendering

function render() {
  if (!doc) return;
  if (filter !== "all" && !doc.people.includes(filter)) filter = me() ?? "all";
  for (const el of document.querySelectorAll("[data-only]")) el.hidden = el.dataset.only !== screen;
  for (const a of document.querySelectorAll(".screen-tabs a")) {
    a.classList.toggle("active", a.dataset.screen === screen);
    if (a.dataset.screen === screen) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if ($(".fold-tab.active")?.hidden) openFold(null);
  document.body.dataset.view = view;
  const navOn = view === "home" ? "home" : $(".fold-tab.active")?.dataset.fold === "cardsPanel" ? "cards" : "overview";
  for (const b of document.querySelectorAll("[data-view-btn]")) b.classList.toggle("active", b.dataset.viewBtn === navOn);

  $("#subtitle").textContent = screen === "personal" ? "What each of us spends" : `Split between ${doc.people.join(" and ")}`;
  $("#monthTitle").textContent = monthName(month);
  $("#nextMonth").disabled = month >= localToday().slice(0, 7);
  $("#tableTitle").textContent = screen === "personal" ? "Daily spending" : "Shared spending";

  $("#personFilter").innerHTML = [...doc.people, "all"].map((p) => `<label><input type="radio" name="who" value="${esc(p)}"
    ${p === filter ? "checked" : ""} /><span>${p === "all" ? "Both" : esc(p)}</span></label>`).join("");

  const items = itemsFor(month);
  renderCards(items);
  renderFlow(items);
  renderSettle();
  renderCardGuide();
  renderCardList();
  renderGrid();
  renderSummary(items);
  renderLog();
  renderPayments();
  if ($("#settingsDlg").open) renderSettings();
}

// ---------------------------------------------------------------- 🏠 home view

const thisMonth = () => localToday().slice(0, 7);
// Short amounts for the chart's axis: 950, 1.9k.
const axis = (c) => (c >= 100000 ? `${+(c / 100000).toFixed(1)}k` : `${Math.round(c / 100)}`);

// Days counted for a month's average: so far this month, or every day of a past month.
function daysCounted(ym) {
  const now = thisMonth();
  if (ym > now) return 0;
  if (ym === now) return Number(localToday().slice(8));
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Every month with spending on this screen (newest first), always including this month.
function dataMonths() {
  const set = new Set([thisMonth()]);
  for (const i of doc.items) {
    if (i.kind === screen && (screen === "shared" || filter === "all" || i.owner === filter)) set.add(i.date.slice(0, 7));
  }
  return [...set].filter((m) => m <= thisMonth()).sort().reverse();
}

// Averages over the complete months with spending (this month left out until it's over).
function monthlyAverages() {
  const past = dataMonths().filter((m) => m < thisMonth());
  const totals = past.map(monthTotal);
  const days = past.reduce((s, m) => s + daysCounted(m), 0);
  const total = totals.reduce((s, v) => s + v, 0);
  return { months: past.length, perMonth: past.length ? total / past.length : 0, perDay: days ? total / days : 0 };
}

// Total spending a month for the current screen and person filter.
function monthTotal(ym) {
  return sum(doc.items.filter((i) => i.kind === screen && i.date.startsWith(ym) &&
    (screen === "shared" || filter === "all" || i.owner === filter)));
}

function dayHeading(d) {
  const today = localToday();
  if (d === today) return "Today";
  if (d === shiftDay(today, -1)) return "Yesterday";
  return fmtDay(d, d.slice(0, 4) === today.slice(0, 4) ? { weekday: "short", month: "long", day: "numeric" } : { month: "long", day: "numeric", year: "numeric" });
}

// The opening screen: the month's total, the last 6 months, and each day's expenses.
function renderFlow(items) {
  const total = sum(items);
  const now = thisMonth();
  const today = localToday();
  const mine = me() ?? doc.people[0];
  $("#flowTotal").textContent = `${total ? "−" : ""}${money(total)}`;
  $("#flowLabel").textContent = `${screen === "shared" ? "Shared spending" : filter === "all" ? "Spent by both of you" : `${filter}'s spending`} · ${month === now ? "This month" : monthName(month)}`;

  const pills = [];
  if (screen === "personal") {
    if (month === now) pills.push(["Today", sum(items.filter((i) => i.date === today))]);
    const days = daysCounted(month);
    pills.push(["Avg / day", days ? total / days : 0]);
    const avg = monthlyAverages();
    if (avg.months) pills.push([`Avg / month (${avg.months} mo)`, avg.perMonth]);
  } else {
    pills.push([`${mine}'s share`, items.reduce((s, i) => s + i.a * (i.shares?.[mine] ?? 0), 0)]);
    pills.push([`${mine} paid`, sum(items.filter((i) => i.paidBy === mine))]);
  }
  $("#flowPills").innerHTML = pills.map(([k, v]) => `<span class="flow-pill"><span>${esc(k)}</span><b>${money(v)}</b></span>`).join("");

  // Six months ending this month, the chosen month if it's further back, or where ‹ › paged to.
  let end = chartEnd ?? (month < shiftMonth(now, -5) ? month : now);
  if (end > now) end = now;
  const oldest = dataMonths().at(-1) ?? now;
  const months = Array.from({ length: 6 }, (_, n) => shiftMonth(end, n - 5));
  const totals = months.map(monthTotal);
  const max = Math.max(...totals, 1);
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((v) => v >= max);
  $("#flowChart").innerHTML = `
    <div class="flow-pager">
      <button type="button" class="icon-btn" data-chart-page="-6" aria-label="Earlier months" ${shiftMonth(end, -5) <= oldest ? "disabled" : ""}>‹</button>
      <span>${monthName(months[0], { month: "short", year: "numeric" })} – ${monthName(months.at(-1), { month: "short", year: "numeric" })}</span>
      <button type="button" class="icon-btn" data-chart-page="6" aria-label="Later months" ${end >= now ? "disabled" : ""}>›</button>
    </div>
    <div class="flow-axis">${[top, top / 2, 0].map((t) => `<span>${axis(t)}</span>`).join("")}</div>
    <div class="flow-plot">${[top, top / 2, 0].map((t) => `<i class="db-grid" style="bottom:${(t / top) * 100}%"></i>`).join("")}
      ${months.map((m, n) => `<button type="button" class="flow-col${m === month ? " on" : ""}" data-month="${m}" aria-pressed="${m === month}"
        aria-label="${monthName(m)}: ${money(totals[n])}"><span class="flow-bar" style="height:${totals[n] ? Math.max((totals[n] / top) * 100, 2) : 0}%"></span>
        <span class="flow-mlabel">${monthName(m, { month: "short" })}<br>${m.slice(0, 4)}</span></button>`).join("")}
    </div>`;

  // A chip for every month with spending, newest first, scrolling sideways.
  const chips = dataMonths();
  if (!chips.includes(month)) chips.push(month);
  $("#flowChips").innerHTML = chips.map((m) => `<button type="button" class="flow-chip${m === month ? " on" : ""}" data-month="${m}" role="radio" aria-checked="${m === month}">${m === now ? "This month" : monthName(m, { month: "short", year: "numeric" })}</button>`).join("");
  $("#flowChips .flow-chip.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderMonths();

  // Expenses by day, newest first, each day in its own card.
  const byDay = new Map();
  for (const i of [...items].sort((a, b) => b.date.localeCompare(a.date) || b.t - a.t)) {
    if (!byDay.has(i.date)) byDay.set(i.date, []);
    byDay.get(i.date).push(i);
  }
  $("#txList").innerHTML = byDay.size ? [...byDay].map(([d, list]) => `
    <section class="tx-day">
      <h3 class="tx-date"><span>${dayHeading(d)}</span><span>−${money(sum(list))}</span></h3>
      <ul class="tx-card">${list.map(txRow).join("")}</ul>
    </section>`).join("")
    : `<div class="tx-empty"><span aria-hidden="true">🧾</span><p>No ${screen === "shared" ? "shared " : ""}expenses ${month === now ? "this month" : `in ${monthName(month)}`} yet.</p><button type="button" class="btn" data-add>＋ Add expense</button></div>`;
}

function txRow(i) {
  const c = catOf(i.cat);
  const n = Math.max(0, doc.categories.findIndex((x) => x.id === i.cat));
  const card = cardOf(i.card);
  const b = borrowed(i);
  const chips = [];
  if (i.kind === "personal" && filter === "all") chips.push(esc(i.owner));
  if (i.kind === "shared") {
    chips.push(`Paid by ${esc(i.paidBy)}`);
    const parts = Object.entries(i.shares ?? {}).filter(([, f]) => f > 0);
    if (parts.some(([, f]) => Math.abs(f - 1 / doc.people.length) > 0.001)) chips.push(parts.map(([, f]) => Math.round(f * 100)).join("/"));
  }
  if (card) chips.push(`💳 ${esc(card.name)}${card.owner !== (i.owner ?? i.paidBy) ? ` (${esc(card.owner)}'s)` : ""}`);
  if (b) chips.push(`${esc(b.from)} owes ${esc(b.to)}`);
  const mine = me();
  const share = i.kind === "shared" && mine ? i.a * (i.shares?.[mine] ?? 0) : null;
  return `<li><button type="button" class="tx" data-tx="${esc(i.id)}" aria-label="Edit ${esc(c.name)} ${money(i.a)}">
    <span class="tx-icon" style="--c:${catColor(n)}"><span>${esc(c.emoji)}</span></span>
    <span class="tx-main">
      <b>${esc(c.name)}</b>
      ${chips.length ? `<span class="tx-chips">${chips.map((x) => `<span class="tx-chip">${x}</span>`).join("")}</span>` : ""}
      ${i.note ? `<span class="tx-note">${esc(i.note)}</span>` : ""}
    </span>
    <span class="tx-amt"><b>−${money(i.a)}</b>${share !== null ? `<small>${esc(mine)}: ${money(share)}</small>` : ""}</span>
  </button></li>`;
}

for (const id of ["#flowChart", "#flowChips"]) {
  $(id).addEventListener("click", (e) => {
    const page = e.target.closest("[data-chart-page]");
    if (page) {
      const now = thisMonth();
      const cur = chartEnd ?? (month < shiftMonth(now, -5) ? month : now);
      const next = shiftMonth(cur, Number(page.dataset.chartPage));
      chartEnd = next >= now ? null : next;
      return render();
    }
    const b = e.target.closest("[data-month]");
    if (b) {
      month = b.dataset.month;
      openCell = null;
      if (b.closest("#flowChips")) chartEnd = null; // the chart follows the chosen month
      render();
    }
  });
}

// 📅 Months (Overview): each month's total, average per day and count, and the averages.
function renderMonths() {
  const months = dataMonths();
  const avg = monthlyAverages();
  const rows = months.map((m) => {
    const list = doc.items.filter((i) => i.kind === screen && i.date.startsWith(m) && (screen === "shared" || filter === "all" || i.owner === filter));
    const total = sum(list);
    const days = daysCounted(m);
    const diff = avg.perMonth && m < thisMonth() ? Math.round(((total - avg.perMonth) / avg.perMonth) * 100) : null;
    return `<tr data-month="${m}" class="${m === month ? "on" : ""}">
      <th scope="row">${m === thisMonth() ? "This month" : monthName(m, { month: "short", year: "numeric" })}</th>
      <td>${money(total)}${diff !== null ? `<span class="muted small"> ${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}%</span>` : ""}</td>
      <td>${money(days ? total / days : 0)}</td>
      <td>${list.length}</td></tr>`;
  }).join("");
  $("#monthsTable").innerHTML = `
    <thead><tr><th scope="col">Month</th><th scope="col">Spent</th><th scope="col">Avg / day</th><th scope="col">Expenses</th></tr></thead>
    <tbody>${rows}</tbody>
    ${avg.months ? `<tfoot><tr><th scope="row">Average</th><td>${money(avg.perMonth)}<span class="muted small"> / month</span></td><td>${money(avg.perDay)}</td><td></td></tr></tfoot>` : ""}`;
  $("#monthsNote").textContent = avg.months
    ? `Averages over the ${avg.months} complete month${avg.months === 1 ? "" : "s"} with spending${screen === "personal" ? ` (${filter === "all" ? "both of you" : filter})` : " (shared)"}. ▲▼ compare each month with the monthly average. Tap a month to see it.`
    : "Averages appear once a full month has passed.";
}
$("#monthsTable").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-month]");
  if (tr) { month = tr.dataset.month; chartEnd = null; openCell = null; setView("home"); }
});
$("#txList").addEventListener("click", (e) => {
  const tx = e.target.closest("[data-tx]");
  if (tx) openAdd({}, doc.items.find((i) => i.id === tx.dataset.tx));
});

function setView(next, fold) {
  view = next;
  if (fold !== undefined) openFold(fold);
  render();
  if (fold) $(`#${fold}`)?.scrollIntoView({ block: "start" });
  else window.scrollTo(0, 0);
}
$(".bottom-nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view-btn]");
  if (!b) return;
  if (b.dataset.viewBtn === "cards") setView("overview", "cardsPanel");
  else setView(b.dataset.viewBtn);
});
$("#navSettings").addEventListener("click", () => $("#settingsBtn").click());

function setCard(n, label, big, sub) {
  $(`#c${n}Label`).textContent = label;
  $(`#c${n}`).textContent = big;
  $(`#c${n}Sub`).textContent = sub;
}

function topCategory(items) {
  const by = new Map();
  for (const i of items) by.set(i.cat, (by.get(i.cat) ?? 0) + i.a);
  const [id, a] = [...by].sort((x, y) => y[1] - x[1])[0] ?? [];
  return id ? { cat: catOf(id), a } : null;
}

function renderCards(items) {
  const total = sum(items);
  const n = items.length;
  const days = month === localToday().slice(0, 7) ? Number(localToday().slice(8)) : daysOf(month).length;
  const top = topCategory(items);
  const whose = screen === "personal" ? (filter === "all" ? "Both of you" : filter) : "Shared";
  setCard(1, `${whose} · ${monthName(month, { month: "short" })}`, money(total), `${n} expense${n === 1 ? "" : "s"}`);
  setCard(3, "Top category", top ? `${top.cat.emoji} ${top.cat.name}` : "—", top ? `${money(top.a)} · ${Math.round((top.a / total) * 100)}%` : "Nothing yet");

  if (screen === "personal") {
    setCard(2, "Average per day", money(days ? total / days : 0), `over ${days} day${days === 1 ? "" : "s"}`);
    const last = sum(itemsFor(shiftMonth(month, -1)));
    const diff = last ? Math.round(((total - last) / last) * 100) : null;
    setCard(4, monthName(shiftMonth(month, -1), { month: "long" }), money(last),
      diff === null ? "Nothing recorded" : `This month is ${Math.abs(diff)}% ${diff >= 0 ? "higher" : "lower"} so far`);
  } else {
    const mine = me() ?? doc.people[0];
    const shareOf = (p) => items.reduce((s, i) => s + i.a * (i.shares?.[p] ?? 0), 0);
    setCard(2, `${mine}'s share`, money(shareOf(mine)),
      doc.people.filter((p) => p !== mine).map((p) => `${p}: ${money(shareOf(p))}`).join(" · "));
    const paid = (p) => sum(items.filter((i) => i.paidBy === p));
    setCard(4, `${mine} paid`, money(paid(mine)),
      doc.people.filter((p) => p !== mine).map((p) => `${p} paid ${money(paid(p))}`).join(" · "));
  }
}

function renderSettle() {
  const t = balances();
  // Borrowed-card totals this month, by direction, so the balance can be explained.
  const lent = new Map();
  for (const i of doc.items) {
    const b = i.date.startsWith(month) && borrowed(i);
    if (b) lent.set(`${b.from}\u0000${b.to}`, (lent.get(`${b.from}\u0000${b.to}`) ?? 0) + i.a);
  }
  const lines = [...lent].map(([k, a]) => {
    const [from, to] = k.split("\u0000");
    return `${esc(from)} used ${esc(to)}'s card for ${money(a)} in ${monthName(month, { month: "long" })}`;
  });
  $("#settleBox").classList.toggle("square", !t.length);
  $("#settleNow").innerHTML = (t.length
    ? t.map((x) => `<b>${esc(x.from)}</b> owes <b>${esc(x.to)}</b> <b>${money(x.a)}</b>`).join("<br>")
    : "✅ You're all square.") + (lines.length ? `<span class="muted small borrow-line">💳 ${lines.join(" · ")}</span>` : "");
}

// The 💳 Cards fold-out: each card, what it's for, and what went on it this month.
// "Which card for what": the card each person usually uses for each kind of spending.
function renderCardGuide() {
  const rows = doc.cardGuide ?? [];
  const mine = me();
  $("#cardGuide").innerHTML = rows.length
    ? `<thead><tr><th scope="col">For</th>${doc.people.map((p) => `<th scope="col"${p === mine ? ' class="me"' : ""}>${esc(p)}</th>`).join("")}</tr></thead>
       <tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.what)}</th>${doc.people.map((p) => `<td${p === mine ? ' class="me"' : ""}>${esc(r.picks?.[p] || "—")}</td>`).join("")}</tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="muted small">Nothing yet. Add rows in ⚙️ Settings.</td></tr></tbody>`;
}

function guideRow(r = { what: "", picks: {} }) {
  return `<div class="guide-row">
    <input data-k="what" value="${esc(r.what)}" maxlength="60" placeholder="e.g. 🍜 Dining" aria-label="Kind of spending" />
    ${doc.people.map((p) => `<input data-p="${esc(p)}" value="${esc(r.picks?.[p] ?? "")}" maxlength="80" placeholder="${esc(p)}'s card" aria-label="${esc(p)}'s card" />`).join("")}
    <button type="button" class="icon-btn" data-guide-remove title="Remove row" aria-label="Remove row">✕</button>
  </div>`;
}

function renderGuideEdit() {
  if ($("#guideEdit").contains(document.activeElement)) return;
  $("#guideEdit").innerHTML = (doc.cardGuide ?? []).map(guideRow).join("");
}

$("#guideAdd").addEventListener("click", () => {
  $("#guideEdit").insertAdjacentHTML("beforeend", guideRow());
  $("#guideEdit").lastElementChild.querySelector("input").focus();
});
$("#guideEdit").addEventListener("click", (e) => {
  if (e.target.closest("[data-guide-remove]")) e.target.closest(".guide-row").remove();
});
$("#guideSave").addEventListener("click", async () => {
  const rows = [...$("#guideEdit").querySelectorAll(".guide-row")].map((row) => ({
    what: row.querySelector('[data-k="what"]').value,
    picks: Object.fromEntries([...row.querySelectorAll("[data-p]")].map((i) => [i.dataset.p, i.value])),
  }));
  if (await sync.runOp({ op: "updateCardGuide", rows }, "Saved which card for what")) {
    document.activeElement?.blur();
    renderGuideEdit();
  }
});

function renderCardList() {
  if (!doc.cards.length) {
    $("#cardList").innerHTML = `<li class="muted small">No cards yet. Tap ✏️ Manage cards to add yours and Lilin's.</li>`;
    return;
  }
  const items = doc.items.filter((i) => i.date.startsWith(month));
  $("#cardList").innerHTML = doc.cards.map((c) => {
    const on = items.filter((i) => i.card === c.id);
    const byOthers = new Map();
    for (const i of on) { const b = borrowed(i); if (b) byOthers.set(b.from, (byOthers.get(b.from) ?? 0) + i.a); }
    const cats = c.cats.map((id) => catOf(id)).map((k) => `<span class="tag">${esc(k.emoji)} ${esc(k.name)}</span>`).join("");
    return `<li>
      <div class="item-main">
        <span class="item-note"><b>${esc(c.emoji)} ${esc(c.name)}</b> · ${esc(c.owner)}'s</span>
        <span class="card-cats-view">${cats || `<span class="muted small">Any category</span>`}</span>
        ${byOthers.size ? `<span class="item-meta">${[...byOthers].map(([p, a]) => `${esc(p)} used it for ${money(a)}, owes ${esc(c.owner)}`).join(" · ")}</span>` : ""}
      </div>
      <div class="item-amt">${money(sum(on))}<span class="muted small"> this month</span></div>
    </li>`;
  }).join("");
}

// The table's expenses: this screen's kind and person filter, any date.
function gridItems() {
  return doc.items.filter((i) => i.kind === screen && (screen === "shared" || filter === "all" || i.owner === filter));
}

const shiftDay = (iso, by) => new Date(Date.parse(iso + "T00:00:00Z") + by * 86400000).toISOString().slice(0, 10);

// Every calendar day from today back to the first expense (at least four weeks, or further
// if a date was picked), newest first.
function gridDays(items) {
  const today = localToday();
  let from = shiftDay(today, -27);
  for (const i of items) if (i.date < from) from = i.date;
  if (gridFrom && gridFrom < from) from = gridFrom;
  const days = [];
  for (let d = today; d >= from; d = shiftDay(d, -1)) days.push(d);
  return days;
}

// Daily spending: one row per calendar day with today at the top. The table shows a week
// at a time and scrolls for earlier days; its footer totals the last 7 days.
function renderGrid() {
  const table = $("#grid");
  const wrap = table.parentElement;
  const scroll = wrap.scrollTop;
  const items = gridItems();
  const days = gridDays(items);
  const today = localToday();
  const week = days.slice(0, 7);
  // Columns: the categories used in these days (all of them if none yet), in category order.
  const shown = items.filter((i) => i.date >= days.at(-1) && i.date <= today);
  const used = new Set(shown.map((i) => i.cat));
  const cats = doc.categories.filter((c) => used.has(c.id));
  const cols = cats.length ? cats : doc.categories;
  const sums = {};
  for (const i of shown) (sums[i.date] ??= {})[i.cat] = (sums[i.date][i.cat] ?? 0) + i.a;
  const dayTotal = (d) => Object.values(sums[d] ?? {}).reduce((s, v) => s + v, 0);
  const weekCat = (c) => week.reduce((s, d) => s + (sums[d]?.[c] ?? 0), 0);
  const weekTotal = week.reduce((s, d) => s + dayTotal(d), 0);
  let lastMonth = null;

  table.innerHTML = `
    <thead><tr><th scope="col">Day</th>${cols.map((c) => `<th scope="col" title="${esc(c.name)}"><span class="emoji">${esc(c.emoji)}</span><span class="cat-name">${esc(c.name)}</span></th>`).join("")}<th scope="col">Total</th></tr></thead>
    <tbody>${days.map((d) => {
      // A month's first row (as you scroll back) is labelled with the month.
      const m = d.slice(0, 7);
      const newMonth = m !== lastMonth && lastMonth !== null;
      lastMonth = m;
      return `${newMonth ? `<tr class="month-row"><th scope="rowgroup" colspan="${cols.length + 2}">${monthName(m)}</th></tr>` : ""}
      <tr data-date="${d}" class="${d === today ? "today" : ""}">
      <th scope="row"><span class="day-label">${d === today ? "Today" : fmtDay(d)}${d === today ? ` <span class="muted small">${fmtDay(d, { month: "short", day: "numeric" })}</span>` : ""}</span><span class="day-short"><span>${d === today ? "Today" : fmtDay(d, { weekday: "short" })}</span><b>${Number(d.slice(8))}</b></span></th>
      ${cols.map((c) => {
        const v = sums[d]?.[c.id];
        return `<td><button type="button" class="cell${v ? "" : " empty"}" data-date="${d}" data-cat="${esc(c.id)}"
          aria-label="${esc(c.name)} on ${fmtDay(d)}: ${v ? money(v) : "nothing yet"}">${v ? cell(v) : "–"}</button></td>`;
      }).join("")}
      <td class="total"><button type="button" class="cell day-total" data-date="${d}" ${dayTotal(d) ? "" : "disabled"}>${dayTotal(d) ? cell(dayTotal(d)) : ""}</button></td>
    </tr>`;
    }).join("")}</tbody>
    <tfoot>
      <tr><th scope="row"><span class="n-full">Last 7 days</span><span class="n-short">7 days</span></th>${cols.map((c) => `<td>${cell(weekCat(c.id))}</td>`).join("")}<td><b>${cell(weekTotal)}</b></td></tr>
      <tr class="avg"><th scope="row">Avg / day</th>${cols.map((c) => `<td>${cell(weekCat(c.id) / 7)}</td>`).join("")}<td>${cell(weekTotal / 7)}</td></tr>
    </tfoot>`;
  renderDetail();
  sizeGrid();
  $("#gridDate").max = today;
  if (gridToTop) {
    wrap.scrollTop = 0;
    gridToTop = false;
  } else wrap.scrollTop = scroll;
}

// Fits the scrolling table to a week: the header, 7 days and the footer.
function sizeGrid() {
  const table = $("#grid");
  const rows = [...(table.tBodies[0]?.rows ?? [])].filter((r) => r.dataset.date).slice(0, 7);
  if (!rows.length) return;
  // The two footer rows stick to the bottom, the totals row just above the averages.
  table.style.setProperty("--avg-row-h", `${table.tFoot.rows[1]?.offsetHeight ?? 0}px`);
  const h = table.tHead.offsetHeight + table.tFoot.offsetHeight + rows.reduce((s, r) => s + r.offsetHeight, 0) + 2;
  table.parentElement.style.maxHeight = `${h}px`;
}
window.addEventListener("resize", () => { if (doc) sizeGrid(); });

// Scrolls the table to a day (adding earlier days if needed) and highlights it.
function goToDay(d) {
  const today = localToday();
  if (!d || d > today) return;
  if (d < (gridDays(gridItems()).at(-1) ?? today)) gridFrom = d;
  renderGrid();
  const table = $("#grid");
  const row = table.querySelector(`tbody tr[data-date="${d}"]`);
  if (!row) return;
  table.parentElement.scrollTop = row.offsetTop - table.tHead.offsetHeight;
  row.classList.remove("flash");
  void row.offsetWidth; // restart the highlight
  row.classList.add("flash");
}

function itemRow(i) {
  const c = catOf(i.cat);
  const who = i.kind === "personal"
    ? i.owner
    : `Paid by ${i.paidBy} · ${Object.entries(i.shares ?? {}).filter(([, f]) => f > 0).map(([p, f]) => `${p} ${Math.round(f * 100)}%`).join(" / ")}`;
  const card = cardOf(i.card);
  const b = borrowed(i);
  const paid = card ? `<span class="item-card">💳 ${esc(card.owner)}'s ${esc(card.name)}${b ? ` · ${esc(b.from)} owes ${esc(b.to)}` : ""}</span>` : "";
  return `<li>
    <div class="item-main">
      <span class="item-note">${esc(c.emoji)} <b class="item-who">${esc(who)}</b>${i.note ? ` · ${esc(i.note)}` : ""}</span>
      ${paid}
      <span class="item-meta">${fmtDay(i.date)} · added by ${esc(i.by)} ${timeAgo(i.t)}${i.editedAt ? ` · edited by ${esc(i.editedBy)}` : ""}</span>
    </div>
    <div class="item-amt">${money(i.a)}</div>
    <button type="button" class="icon-btn" data-edit-item="${esc(i.id)}" title="Edit" aria-label="Edit ${money(i.a)}">✏️</button>
    <button type="button" class="icon-btn" data-del="${esc(i.id)}" title="Delete" aria-label="Delete ${money(i.a)}">🗑</button>
  </li>`;
}

// The expenses behind an amount, dropped down under its day.
function renderDetail() {
  const table = $("#grid");
  table.querySelector("tr.detail-row")?.remove();
  for (const b of table.querySelectorAll("button.cell.open")) b.classList.remove("open");
  if (!openCell) return;
  const dayRow = table.querySelector(`tbody tr[data-date="${openCell.date}"]`);
  if (!dayRow) return void (openCell = null);
  const list = gridItems().filter((i) => i.date === openCell.date && (!openCell.cat || i.cat === openCell.cat)).sort((a, b) => a.t - b.t);
  const btn = openCell.cat ? dayRow.querySelector(`button.cell[data-cat="${CSS.escape(openCell.cat)}"]`) : dayRow.querySelector(".day-total");
  btn?.classList.add("open");
  const cat = openCell.cat && catOf(openCell.cat);
  const row = document.createElement("tr");
  row.className = "detail-row";
  row.innerHTML = `<td colspan="${dayRow.children.length}"><div class="detail" id="detail">
    <div class="detail-head">
      <div><h3>${cat ? `${esc(cat.emoji)} ${esc(cat.name)}` : "Everything this day"}</h3>
        <p class="muted small">${fmtDay(openCell.date, { weekday: "long", month: "short", day: "numeric" })} · ${list.length} expense${list.length === 1 ? "" : "s"}</p></div>
      <div class="detail-sum">${money(sum(list))}</div>
    </div>
    ${list.length ? `<ul class="items-list">${list.map(itemRow).join("")}</ul>` : `<p class="muted">Nothing here yet.</p>`}
    <div class="detail-actions">
      <button type="button" class="btn ghost" data-detail-close>▲ Close</button>
      <button type="button" class="btn" data-detail-add>＋ Add expense</button>
    </div>
  </div></td>`;
  dayRow.after(row);
}

$("#grid").addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit-item]");
  if (edit) return openAdd({}, doc.items.find((i) => i.id === edit.dataset.editItem));
  const del = e.target.closest("[data-del]");
  if (del) {
    del.disabled = true;
    if (!(await sync.runOp({ op: "deleteItem", id: del.dataset.del }, "Deleted"))) del.disabled = false;
    return;
  }
  if (e.target.closest("[data-detail-close]")) return void (openCell = null, renderDetail());
  if (e.target.closest("[data-detail-add]")) return openAdd({ date: openCell.date, cat: openCell.cat });
  const btn = e.target.closest("button.cell");
  if (!btn) return;
  const { date, cat } = btn.dataset;
  if (btn.classList.contains("empty")) return openAdd({ date, cat });
  const target = btn.classList.contains("day-total") ? { date, cat: null } : { date, cat };
  openCell = openCell && openCell.date === target.date && openCell.cat === target.cat ? null : target;
  renderDetail();
});

// ---------------------------------------------------------------- summary chart

const catColor = (n) => `var(--series-${n < 7 ? n + 1 : "other"})`;

function arcPath(r, r0, a0, a1) {
  const pt = (rad, a) => [100 + rad * Math.sin(a), 100 - rad * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
}

function showTip(html, x, y) {
  const tip = $("#vizTip");
  tip.innerHTML = html;
  tip.hidden = false;
  const box = tip.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(x - box.left, 60), box.width - 60)}px`;
  tip.style.top = `${y - box.top}px`;
}
const hideTip = () => { $("#vizTip").hidden = true; };

function renderSummary(items) {
  const total = sum(items);
  $("#donutCenter").textContent = `S$${whole.format(total / 100)}`;
  const slices = doc.categories.map((c, n) => ({ c, v: sum(items.filter((i) => i.cat === c.id)), color: catColor(n) })).filter((s) => s.v);
  const svg = $("#donut");
  const title = svg.querySelector("title").outerHTML;
  let a = 0;
  svg.innerHTML = title + (total ? slices.map((s) => {
    const sweep = (s.v / total) * Math.PI * 2;
    const d = arcPath(90, 58, a, a + Math.min(sweep, Math.PI * 2 - 0.0001));
    a += sweep;
    return `<path d="${d}" fill="${s.color}" data-slice="${esc(s.c.id)}" />`;
  }).join("") : `<circle cx="100" cy="100" r="74" fill="none" stroke="var(--surface-2)" stroke-width="32" />`);
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  $("#catLegend").innerHTML = slices.length ? [...slices].sort((x, y) => y.v - x.v).map((s) => `
    <li data-slice="${esc(s.c.id)}"><span class="cat-icon" style="--c:${s.color}"><span>${esc(s.c.emoji)}</span></span>
      <span class="cat-main"><b>${esc(s.c.name)}</b><span class="muted small">${pct(s.v)}%</span></span>
      <span class="cat-amt"><b>${money(s.v)}</b></span></li>`).join("") : `<li class="muted small">Nothing spent this month yet.</li>`;
  svg.onpointermove = (e) => {
    const s = slices.find((x) => x.c.id === e.target.closest("[data-slice]")?.dataset.slice);
    if (!s) return hideTip();
    showTip(`<b>${esc(s.c.emoji)} ${esc(s.c.name)}</b><br>${money(s.v)} · ${pct(s.v)}%`, e.clientX, e.clientY);
  };
  svg.onpointerleave = hideTip;

  const days = [...daysOf(month)].reverse();
  const byDay = (d) => sum(items.filter((i) => i.date === d));
  const max = Math.max(...days.map(byDay), 1) / 100;
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((v) => v >= max);
  const tick = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(2)}k` : `${Math.round(v)}`);
  $("#dayBars").innerHTML = `
    <div class="db-axis">${[top, top / 2, 0].map((t) => `<span>${tick(t)}</span>`).join("")}</div>
    <div class="db-plot">${[top, top / 2, 0].map((t) => `<i class="db-grid" style="bottom:${(t / top) * 100}%"></i>`).join("")}
      ${days.map((d) => `<button type="button" class="db-col${d === localToday() ? " today" : ""}" data-day="${d}" aria-label="${fmtDay(d)}: ${money(byDay(d))}">
        <span class="db-bar" style="height:${byDay(d) ? Math.max((byDay(d) / 100 / top) * 100, 1.5) : 0}%"></span>
        <span class="db-label">${Number(d.slice(8)) % 5 === 1 || days.length <= 10 ? Number(d.slice(8)) : ""}</span></button>`).join("")}
    </div>`;
  $("#dayBars").onpointermove = (e) => {
    const col = e.target.closest(".db-col");
    if (!col) return hideTip();
    const r = col.querySelector(".db-bar").getBoundingClientRect();
    showTip(`<b>${fmtDay(col.dataset.day)}</b><br>${money(byDay(col.dataset.day))}`, r.left + r.width / 2, r.top);
  };
  $("#dayBars").onpointerleave = hideTip;
}

function renderLog() {
  $("#log").innerHTML = doc.log.slice(0, 40).map((e) =>
    `<li><b>${esc(e.by)}</b> ${esc(e.msg)}<time>${timeAgo(e.t)}</time></li>`).join("") || `<li class="empty">No changes yet.</li>`;
}

function renderPayments() {
  const list = [...doc.settlements].sort((a, b) => b.date.localeCompare(a.date) || b.t - a.t);
  $("#payments").innerHTML = list.length ? list.map((s) => `<li>
    <div class="item-main"><span class="item-note"><b>${esc(s.from)}</b> paid <b>${esc(s.to)}</b>${s.note ? ` · ${esc(s.note)}` : ""}</span>
      <span class="item-meta">${fmtDay(s.date)} · recorded by ${esc(s.by)}</span></div>
    <div class="item-amt">${money(s.a)}</div>
    <button type="button" class="icon-btn" data-del-payment="${esc(s.id)}" title="Delete" aria-label="Delete payment">🗑</button>
  </li>`).join("") : `<li class="muted small">No payments recorded yet.</li>`;
}

$("#payments").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del-payment]");
  if (b) sync.runOp({ op: "deleteSettlement", id: b.dataset.delPayment }, "Payment removed");
});

// ---------------------------------------------------------------- add / edit expense

const form = $("#addForm");
const radioValue = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;

function chips(container, name, options, selected) {
  $(container).innerHTML = options.map((o) => `<label class="cat-choice"><input type="radio" name="${name}" value="${esc(o.value)}"
    ${o.value === selected ? "checked" : ""} required /><span>${o.label}</span></label>`).join("");
}

function splitShares() {
  if (radioValue("split") !== "custom") return Object.fromEntries(doc.people.map((p) => [p, 1 / doc.people.length]));
  const raw = Object.fromEntries([...$("#splitCustom").querySelectorAll("input")].map((i) => [i.name, Math.max(0, Number(i.value) || 0)]));
  const total = Object.values(raw).reduce((s, v) => s + v, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([p, v]) => [p, v / total]));
}

function updateSplitUI() {
  $("#splitCustom").hidden = radioValue("split") !== "custom";
  const a = parseCents(form.elements.amount.value);
  const shares = splitShares();
  $("#splitPreview").textContent = a > 0 ? doc.people.map((p) => `${p} ${money(a * shares[p])}`).join(" · ") : "";
}

// The card meant for this category, preferring the given person's own; null if none.
function suggestCard(cat, person) {
  const fits = doc.cards.filter((c) => c.cats.includes(cat));
  return fits.find((c) => c.owner === person) ?? fits[0] ?? null;
}

function updateCardUI() {
  const kind = editing?.kind ?? screen;
  if (!cardTouched) {
    const person = kind === "personal" ? radioValue("owner") : me();
    const id = suggestCard(radioValue("cat"), person)?.id ?? "";
    const input = form.querySelector(`input[name="card"][value="${CSS.escape(id)}"]`);
    if (input) input.checked = true;
  }
  const card = cardOf(radioValue("card"));
  const a = parseCents(form.elements.amount.value);
  const amt = a > 0 ? money(a) : "the amount";
  let note = "";
  if (card && kind === "shared") {
    note = `Paid by ${card.owner}, on their card.`;
    const payer = form.querySelector(`input[name="payer"][value="${CSS.escape(card.owner)}"]`);
    if (payer) payer.checked = true;
  } else if (card && card.owner !== radioValue("owner")) {
    note = `${radioValue("owner")} will owe ${card.owner} ${amt} for using ${card.owner}'s card.`;
  }
  $("#cardNote").textContent = note;
  $("#payerPick").hidden = kind !== "shared" || !!card;
}

function openAdd(prefill = {}, item = null) {
  if (!doc) return;
  editing = item;
  $("#addDelete").hidden = !item;
  const kind = item?.kind ?? screen;
  for (const el of form.querySelectorAll("[data-kind]")) el.hidden = el.dataset.kind !== kind;
  const f = form.elements;
  const lastCat = store.get(`daily.lastCat.${kind}`);
  const cat = item?.cat ?? prefill.cat ?? lastCat ?? doc.categories[0].id;
  chips("#catChoices", "cat", doc.categories.map((c) => ({ value: c.id, label: `<span class="emoji">${esc(c.emoji)}</span>${esc(c.name)}` })),
    doc.categories.some((c) => c.id === cat) ? cat : doc.categories[0].id);
  const people = doc.people.map((p) => ({ value: p, label: esc(p) }));
  chips("#ownerChoices", "owner", people, item?.owner ?? (filter !== "all" ? filter : me()) ?? doc.people[0]);
  chips("#payerChoices", "payer", people, item?.paidBy ?? me() ?? doc.people[0]);
  chips("#cardChoices", "card", [{ value: "", label: "💵 Cash / other" },
    ...doc.cards.map((c) => ({ value: c.id, label: `${esc(c.emoji)} ${esc(c.name)} <span class="muted small">${esc(c.owner)}</span>` }))],
    item?.card ?? "");
  cardTouched = !!item;
  const shares = item?.shares ?? {};
  const equal = !item || doc.people.every((p) => Math.abs((shares[p] ?? 0) - 1 / doc.people.length) < 0.001);
  form.querySelector(`input[name="split"][value="${equal ? "equal" : "custom"}"]`).checked = true;
  $("#splitCustom").innerHTML = doc.people.map((p) => `<label>${esc(p)} pays (%)
    <input name="${esc(p)}" type="number" min="0" max="100" step="1" inputmode="numeric" value="${Math.round((equal ? 1 / doc.people.length : shares[p] ?? 0) * 100)}" /></label>`).join("");
  f.date.value = item?.date ?? prefill.date ?? localToday();
  f.date.max = localToday();
  f.amount.value = item ? (item.a / 100).toFixed(2) : "";
  f.note.value = item?.note ?? "";
  $("#addTitle").textContent = `${item ? "Edit" : "Add"} ${kind === "shared" ? "shared " : ""}expense`;
  $("#addSubmit").textContent = item ? "Save changes" : "Add";
  updateSplitUI();
  updateCardUI();
  $("#addDlg").showModal();
  f.amount.focus();
}

form.addEventListener("input", (e) => {
  if (e.target.name === "card") cardTouched = true;
  updateSplitUI();
  updateCardUI();
});
$("#addCancel").addEventListener("click", () => $("#addDlg").close());
$("#addDelete").addEventListener("click", async () => {
  if (editing && (await sync.runOp({ op: "deleteItem", id: editing.id }, `Deleted ${money(editing.a)}`))) $("#addDlg").close();
});
document.addEventListener("click", (e) => { if (e.target.closest("[data-add]")) openAdd(); });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = parseCents(form.elements.amount.value);
  if (!(a > 0)) return toast("Enter an amount, e.g. 12.50");
  const kind = editing?.kind ?? screen;
  const body = {
    kind, date: form.elements.date.value, cat: radioValue("cat"), a, note: form.elements.note.value, card: radioValue("card") || "",
    ...(kind === "personal" ? { owner: radioValue("owner") } : { paidBy: cardOf(radioValue("card"))?.owner ?? radioValue("payer"), shares: splitShares() }),
  };
  const submit = $("#addSubmit");
  submit.disabled = true;
  const ok = await sync.runOp(editing ? { op: "updateItem", id: editing.id, ...body } : { op: "addItem", ...body },
    `${editing ? "Saved" : "Added"} ${money(a)}`);
  submit.disabled = false;
  if (!ok) return;
  store.set(`daily.lastCat.${kind}`, body.cat);
  if (body.date.slice(0, 7) !== month) month = body.date.slice(0, 7);
  $("#addDlg").close();
  render();
});

// ---------------------------------------------------------------- settle up

$("#settleBtn").addEventListener("click", () => {
  const t = balances()[0];
  const f = $("#settleForm").elements;
  const opts = doc.people.map((p) => `<option>${esc(p)}</option>`).join("");
  f.from.innerHTML = opts;
  f.to.innerHTML = opts;
  f.from.value = t?.from ?? doc.people[1] ?? doc.people[0];
  f.to.value = t?.to ?? doc.people[0];
  f.amount.value = t ? (t.a / 100).toFixed(2) : "";
  f.date.value = localToday();
  f.note.value = "";
  $("#settleDlg").showModal();
});
$("#settleCancel").addEventListener("click", () => $("#settleDlg").close());
$("#settleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const a = parseCents(f.amount.value);
  if (!(a > 0)) return toast("Enter an amount, e.g. 42.50");
  if (await sync.runOp({ op: "addSettlement", from: f.from.value, to: f.to.value, a, date: f.date.value, note: f.note.value },
    `Recorded ${f.from.value} paying ${f.to.value} ${money(a)}`)) $("#settleDlg").close();
});

// ---------------------------------------------------------------- settings

function renderSettings() {
  renderGuideEdit();
  if ($("#settingsDlg").contains(document.activeElement)) return;
  $("#peopleInputs").innerHTML = doc.people.map((p, n) => `<label>Person ${n + 1} <input name="p${n}" value="${esc(p)}" maxlength="30" required /></label>`).join("");
  $("#catList").innerHTML = doc.categories.map((c) => `<li data-id="${esc(c.id)}">
    <input class="emoji-in" name="emoji" value="${esc(c.emoji)}" maxlength="8" aria-label="Emoji" />
    <input name="name" value="${esc(c.name)}" maxlength="40" aria-label="Category name" />
    <span class="acts"><button type="button" class="icon-btn" data-remove-cat title="Remove">🗑</button></span></li>`).join("");
  const owners = (sel) => doc.people.map((p) => `<option ${p === sel ? "selected" : ""}>${esc(p)}</option>`).join("");
  const catBoxes = (picked) => doc.categories.map((k) => `<label class="cat-choice"><input type="checkbox" name="cats" value="${esc(k.id)}"
    ${picked.includes(k.id) ? "checked" : ""} /><span><span class="emoji">${esc(k.emoji)}</span>${esc(k.name)}</span></label>`).join("");
  $("#cardEditList").innerHTML = doc.cards.map((c) => `<li class="card-edit" data-id="${esc(c.id)}">
    <div class="row card-add-row">
      <input class="emoji-in" name="emoji" value="${esc(c.emoji)}" maxlength="8" aria-label="Card emoji" />
      <input name="name" value="${esc(c.name)}" maxlength="30" aria-label="Card name" />
      <select name="owner" aria-label="Whose card">${owners(c.owner)}</select>
      <button type="button" class="icon-btn" data-remove-card title="Remove card" aria-label="Remove ${esc(c.name)}">🗑</button>
    </div>
    <div class="cat-choices card-cats" aria-label="${esc(c.name)} is used for">${catBoxes(c.cats)}</div>
  </li>`).join("") || `<li class="muted small">No cards yet.</li>`;
  const add = $("#cardForm");
  if (!add.contains(document.activeElement)) {
    const picked = [...add.querySelectorAll('input[name="cats"]:checked')].map((i) => i.value);
    add.elements.owner.innerHTML = owners(add.elements.owner.value || me() || doc.people[0]);
    add.querySelector(".card-cats").innerHTML = catBoxes(picked);
  }
}

const cardFields = (el) => ({
  emoji: el.querySelector('[name="emoji"]').value,
  name: el.querySelector('[name="name"]').value,
  owner: el.querySelector('[name="owner"]').value,
  cats: [...el.querySelectorAll('input[name="cats"]:checked')].map((i) => i.value),
});

$("#cardEditList").addEventListener("change", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (li && !(await sync.runOp({ op: "editCard", id: li.dataset.id, ...cardFields(li) }, "Card saved"))) renderSettingsNow();
});
$("#cardEditList").addEventListener("click", (e) => {
  if (e.target.closest("[data-remove-card]")) sync.runOp({ op: "removeCard", id: e.target.closest("li").dataset.id }, "Card removed");
});
$("#cardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fields = cardFields(e.target);
  if (await sync.runOp({ op: "addCard", ...fields }, `Added ${fields.name}`)) {
    e.target.reset();
    document.activeElement?.blur();
    renderSettingsNow();
  }
});
// Redraws settings even while a field in it has focus (after a refused or finished edit).
function renderSettingsNow() {
  document.activeElement?.blur();
  renderSettings();
}
$("#manageCards").addEventListener("click", () => {
  if (!doc) return;
  renderSettings();
  $("#settingsDlg").showModal();
  $("#cardsHeading").scrollIntoView({ block: "start" });
});

$("#settingsBtn").addEventListener("click", () => { if (doc) { renderSettings(); $("#settingsDlg").showModal(); } });
$("#closeSettings").addEventListener("click", () => $("#settingsDlg").close());
$("#peopleForm").addEventListener("submit", (e) => {
  e.preventDefault();
  sync.runOp({ op: "updateSettings", people: [...e.target.querySelectorAll("input")].map((i) => i.value) }, "Names saved");
});
$("#catList").addEventListener("change", (e) => {
  const li = e.target.closest("li");
  sync.runOp({ op: "editCategory", id: li.dataset.id, name: li.querySelector('[name="name"]').value, emoji: li.querySelector('[name="emoji"]').value });
});
$("#catList").addEventListener("click", (e) => {
  if (e.target.closest("[data-remove-cat]")) sync.runOp({ op: "removeCategory", id: e.target.closest("li").dataset.id }, "Category removed");
});
$("#catForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { name, emoji } = Object.fromEntries(new FormData(e.target));
  if (await sync.runOp({ op: "addCategory", name, emoji }, `Added ${name}`)) e.target.reset();
});

$("#csvBtn").addEventListener("click", () => {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [...doc.items].sort((a, b) => a.date.localeCompare(b.date));
  const lines = [["Date", "Type", "Category", "Note", "Amount (SGD)", "Whose / paid by", "Split", "Card", "Added by"].map(q).join(","),
    ...rows.map((i) => [i.date, i.kind, q(catOf(i.cat).name), q(i.note), (i.a / 100).toFixed(2), q(i.owner ?? i.paidBy),
      q(i.shares ? Object.entries(i.shares).map(([p, f]) => `${p} ${Math.round(f * 100)}%`).join(" / ") : ""),
      q(cardOf(i.card) ? `${cardOf(i.card).owner}'s ${cardOf(i.card).name}` : ""), q(i.by)].join(","))];
  downloadFile(`our-expenses_${localToday()}.csv`, lines.join("\n"), "text/csv");
});
$("#jsonBtn").addEventListener("click", () => downloadFile(`our-expenses_${localToday()}.json`, JSON.stringify(doc, null, 2), "application/json"));

// ---------------------------------------------------------------- navigation

function openFold(id) {
  for (const btn of document.querySelectorAll(".fold-tab")) {
    const open = btn.dataset.fold === id;
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-expanded", String(open));
    $(`#${btn.dataset.fold}`).hidden = !open;
  }
  store.set("daily.fold", id ?? "");
}
$(".fold-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".fold-tab");
  if (btn) { openFold(btn.classList.contains("active") ? null : btn.dataset.fold); render(); }
});

$("#personFilter").addEventListener("change", (e) => {
  filter = e.target.value;
  store.set("daily.filter", filter);
  openCell = null;
  gridToTop = true;
  render();
});
$("#prevMonth").addEventListener("click", () => { month = shiftMonth(month, -1); openCell = null; render(); });
$("#nextMonth").addEventListener("click", () => { month = shiftMonth(month, 1); openCell = null; render(); });

function readScreen() {
  screen = location.hash === "#shared" ? "shared" : "personal";
  openCell = null;
  gridToTop = true;
  render();
}

$("#gridToday").addEventListener("click", () => {
  $("#grid").parentElement.scrollTo({ top: 0, behavior: "smooth" });
});
$("#gridDate").addEventListener("click", (e) => { try { e.target.showPicker(); } catch { /* opens natively */ } });
$("#gridDate").addEventListener("change", (e) => {
  goToDay(e.target.value);
  e.target.value = "";
});
window.addEventListener("hashchange", readScreen);

setInterval(() => { if (doc) renderLog(); }, 60000);
openFold(store.get("daily.fold") || null);
setupIdentity();
readScreen();
sync.start();
