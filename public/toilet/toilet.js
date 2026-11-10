// 🚽 Toilet log (/toilet/): each poop by date and time, with its type on the Bristol stool
// scale. Stored with Food & fitness (/api/fitness, doc.toilet); its own page on the home screen.

import { $, esc, store, localToday, fmtDay, timeAgo, toast, myName, setupIdentity, createSync, launchAction, returnHomeAfter, checkIdentity } from "/common.js";

let doc = null;
let who = store.get("fitness.person") || "";

const sync = createSync({
  path: "/api/fitness",
  schema: 1,
  onDoc(next) {
    checkIdentity(next.people);
    doc = next;
    render();
    quickAction();
  },
});

const shiftDay = (iso, by) => new Date(Date.parse(iso + "T00:00:00Z") + by * 86400000).toISOString().slice(0, 10);
const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, "");
function me() {
  const n = norm(myName());
  return doc.people.find((p) => n && (norm(p) === n || n.startsWith(norm(p)) || norm(p).startsWith(n))) ?? null;
}
function dayLabel(d) {
  const today = localToday();
  const name = d === today ? "Today" : d === shiftDay(today, -1) ? "Yesterday" : null;
  return name ? `${name}, ${fmtDay(d, { month: "short", day: "numeric" })}` : fmtDay(d, { weekday: "long", month: "short", day: "numeric" });
}

function render() {
  if (!doc) return;
  if (!doc.people.includes(who)) who = me() ?? doc.people[0];
  $("#personPick").innerHTML = doc.people.map((p) => `<label><input type="radio" name="who" value="${esc(p)}"
    ${p === who ? "checked" : ""} /><span>${esc(p)}</span></label>`).join("");
  $("#subtitle").textContent = `${who}'s log`;
  $("#logTitle").textContent = `${who}'s toilet log`;
  renderToilet();
}
$("#personPick").addEventListener("change", (e) => {
  who = e.target.value;
  store.set("fitness.person", who);
  render();
});

// From the home page: /toilet/?add=1 opens the log dialog straight away.
function quickAction() {
  if (!launchAction()) return;
  openBowel();
  returnHomeAfter($("#bowelDlg"));
}


// The Bristol stool scale, with a small drawing of each type.
const POO = "#8a5a2b";
const BRISTOL = [
  { type: 1, name: "Separate hard lumps", hint: "Constipated", tone: "hard",
    svg: `<circle cx="10" cy="14" r="5"/><circle cx="22" cy="10" r="4.5"/><circle cx="33" cy="15" r="5"/><circle cx="44" cy="11" r="4"/>` },
  { type: 2, name: "Lumpy and sausage-like", hint: "Mildly constipated", tone: "hard",
    svg: `<path d="M6 13c0-5 6-6 9-4 3-3 8-3 10 0 3-2 8-2 10 1 3-1 9 0 9 4s-5 6-9 4c-2 3-8 3-10 0-3 2-8 2-10-1-4 2-9 0-9-4z"/>` },
  { type: 3, name: "Sausage with cracks", hint: "Healthy", tone: "good",
    svg: `<rect x="4" y="7" width="44" height="12" rx="6"/><path d="M14 8v4M22 18v-4M30 8v4M38 18v-4" stroke="#fff" stroke-width="1.5" opacity=".55"/>` },
  { type: 4, name: "Smooth, soft sausage", hint: "Healthy", tone: "good",
    svg: `<path d="M5 15c4-8 14-9 22-6s15 1 20-1c2 4-2 9-9 10-9 1-16-2-22 0-6 1-11 0-11-3z"/>` },
  { type: 5, name: "Soft blobs, clear edges", hint: "Lacking fibre", tone: "soft",
    svg: `<ellipse cx="10" cy="13" rx="7" ry="5"/><ellipse cx="25" cy="11" rx="6.5" ry="4.5"/><ellipse cx="40" cy="14" rx="7" ry="5"/>` },
  { type: 6, name: "Mushy, ragged pieces", hint: "Mild diarrhoea", tone: "loose",
    svg: `<path d="M4 16c2-6 7-4 9-7 3 3 6-1 9 2 3-3 7 0 9-2 3 3 8 0 10 4 2 4-4 6-9 4-4 2-9 1-13 0-4 2-9 2-11 0-3 1-5 0-4-1z"/>` },
  { type: 7, name: "Watery, no solid pieces", hint: "Diarrhoea", tone: "loose",
    svg: `<path d="M4 17c6-4 12 1 18-2s12 2 18-1 6 2 6 3c-4 3-11 0-16 2s-12-1-17 1-9 0-9-3z" opacity=".75"/><circle cx="14" cy="9" r="2"/><circle cx="34" cy="8" r="1.6"/>` },
];
const bristol = (t) => BRISTOL[(t || 4) - 1];
const pooIcon = (t, size = 52) => `<svg class="poo" viewBox="0 0 52 26" width="${size}" height="${size / 2}" fill="${POO}" aria-hidden="true">${bristol(t).svg}</svg>`;
const bowelsOf = (p = who) => (doc.toilet ?? []).filter((x) => x.person === p).sort((a, b) => b.date.localeCompare(a.date) || (b.time || "").localeCompare(a.time || "") || b.t - a.t);

function renderToilet() {
  const all = bowelsOf();
  const today = localToday();
  const inLast = (n) => all.filter((x) => x.date > shiftDay(today, -n));
  const week = inLast(7);
  const month = inLast(30);
  const counts = new Map();
  for (const x of month) counts.set(x.type, (counts.get(x.type) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0];
  const healthy = month.filter((x) => x.type === 3 || x.type === 4).length;
  const last = all[0];
  const card = (label, big, sub) => `<article class="card"><h2>${label}</h2><p class="big">${big}</p><p class="muted">${sub}</p></article>`;
  $("#bowelCards").innerHTML = [
    card("Today", String(all.filter((x) => x.date === today).length), last ? `Last: ${last.date === today ? "today" : fmtDay(last.date)}${last.time ? ` at ${last.time}` : ""}` : "Nothing logged yet"),
    card("Last 7 days", String(week.length), `${(week.length / 7).toFixed(1)} a day on average`),
    card("Most common · 30 days", common ? `Type ${common[0]}` : "—", common ? `${bristol(common[0]).name} · ${common[1]}×` : "Nothing logged yet"),
    card("Healthy (type 3–4)", month.length ? `${Math.round((healthy / month.length) * 100)}%` : "—", month.length ? `${healthy} of ${month.length} in 30 days` : "Nothing logged yet"),
  ].join("");

  $("#bowelStrip").innerHTML = Array.from({ length: 14 }, (_, i) => shiftDay(today, i - 13)).map((d) => {
    const list = all.filter((x) => x.date === d);
    return `<div class="bs-day${d === today ? " today" : ""}" title="${fmtDay(d)}: ${list.length}">
      <div class="bs-dots">${list.slice(0, 4).map((x) => `<i class="bs-dot tone-${bristol(x.type).tone}">${x.type}</i>`).join("")}${list.length > 4 ? `<i class="bs-more">+${list.length - 4}</i>` : ""}</div>
      <b>${list.length || "·"}</b><span>${d === today ? "Today" : fmtDay(d, { weekday: "narrow" })}</span><span class="bs-date">${Number(d.slice(8))}</span></div>`;
  }).join("");

  const days = [...new Set(all.map((x) => x.date))].slice(0, 45);
  $("#bowelList").innerHTML = days.length ? days.map((d) => {
    const list = all.filter((x) => x.date === d);
    return `<section class="bowel-day"><h4><span>${dayLabel(d)}</span><span class="muted">${list.length} time${list.length === 1 ? "" : "s"}</span></h4>
      <ul class="items-list">${list.map((x) => `<li>
        <span class="bowel-time">${x.time || "—"}</span>
        <div class="item-main"><span class="item-note">${pooIcon(x.type, 44)}<span><b>Type ${x.type}</b> · ${esc(bristol(x.type).name)}</span></span>
          <span class="item-meta"><span class="tone-chip tone-${bristol(x.type).tone}">${bristol(x.type).hint}</span>${x.note ? ` · ${esc(x.note)}` : ""} · added by ${esc(x.by)} ${timeAgo(x.t)}</span></div>
        <button type="button" class="icon-btn" data-del-bowel="${esc(x.id)}" title="Delete" aria-label="Delete this entry">🗑</button>
      </li>`).join("")}</ul></section>`;
  }).join("") : `<p class="muted small">Nothing logged yet. Tap ＋ Log a poop after each visit.</p>`;

  $("#bristolGuide").innerHTML = BRISTOL.map((b) => `<li>${pooIcon(b.type, 52)}<span><b>Type ${b.type}</b> · ${b.name}<br><span class="tone-chip tone-${b.tone}">${b.hint}</span></span></li>`).join("");
}

function openBowel() {
  const f = $("#bowelForm");
  f.reset();
  f.elements.date.value = localToday();
  f.elements.date.max = localToday();
  const now = new Date();
  f.elements.time.value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("#bowelWho").textContent = who;
  $("#bristolPick").innerHTML = BRISTOL.map((b) => `<label class="bristol-opt"><input type="radio" name="type" value="${b.type}" ${b.type === 4 ? "checked" : ""} required />
    <span>${pooIcon(b.type, 64)}<b>Type ${b.type}</b><small>${b.name}</small><span class="tone-chip tone-${b.tone}">${b.hint}</span></span></label>`).join("");
  $("#bowelDlg").showModal();
}
for (const b of document.querySelectorAll("[data-add-bowel]")) b.addEventListener("click", openBowel);
$("#bowelCancel").addEventListener("click", () => $("#bowelDlg").close());
$("#bowelForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const type = Number(e.target.querySelector('input[name="type"]:checked')?.value);
  if (await sync.runOp({ op: "addBowel", person: who, date: f.date.value, time: f.time.value, type, note: f.note.value }, `💩 Logged type ${type} for ${who}`)) $("#bowelDlg").close();
});
$("#bowelList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del-bowel]");
  if (b && confirm("Delete this entry?")) await sync.runOp({ op: "deleteBowel", id: b.dataset.delBowel }, "Removed");
});


setupIdentity();
sync.start();
