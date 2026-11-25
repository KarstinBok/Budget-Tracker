// ✨ What's new (/new/): the latest features from features.js, newest first. Each shows a
// screenshot when a picture is enough, or a ▶ Watch walkthrough that opens the real page and
// spotlights each button in turn (/tour/tours.js). A feature stays marked New (and the ✨ button
// on Home keeps its dot) until its walkthrough or screenshot is opened, or "Mark all as read".

import { $, esc, store, fmtDay } from "/common.js";
import { FEATURES } from "/new/features.js";

let seen = new Set();
try { seen = new Set(JSON.parse(store.get("new.seen") || "[]")); } catch { /* ignore */ }
const markSeen = (ids) => { for (const id of ids) seen.add(id); store.set("new.seen", JSON.stringify([...seen])); };

// One filter chip per app (an entry for two apps, "A · B", shows under both).
const appsOf = (f) => f.app.split("·").map((a) => a.trim());
const APPS = [...new Set(FEATURES.flatMap(appsOf))];
let filter = "all";

function render() {
  const unseen = FEATURES.filter((f) => !seen.has(f.id)).length;
  $("#clearNew").hidden = !unseen;
  $("#clearNew").textContent = `✓ Mark all as read (${unseen})`;
  $("#newFilter").innerHTML = [["all", "All"], ...APPS.map((a) => [a, a])].map(([v, l]) =>
    `<label><input type="radio" name="newApp" value="${esc(v)}" ${v === filter ? "checked" : ""} /><span>${esc(l)}</span></label>`).join("");
  const list = FEATURES.filter((f) => filter === "all" || appsOf(f).includes(filter));
  $("#newList").innerHTML = list.map((f) => `<li class="new-item${seen.has(f.id) ? "" : " unseen"}" id="${esc(f.id)}">
    <span class="new-meta">${esc(f.app)} · ${fmtDay(f.date, { day: "numeric", month: "short" })}${seen.has(f.id) ? "" : ` <span class="new-badge">New</span>`}</span>
    <b class="new-title">${esc(f.title)}</b>
    <span class="muted small">${esc(f.why)}</span>
    ${f.shot
      ? `<button type="button" class="new-shot" data-shot="${esc(f.id)}" aria-label="Enlarge the screenshot"><img src="${esc(f.shot)}" alt="Screenshot: ${esc(f.title)}" loading="lazy" /></button>
         <span class="new-where">📍 ${esc(f.where)}</span>`
      : `<a class="btn new-try" data-tour="${esc(f.id)}" href="${esc(f.page)}?tour=${encodeURIComponent(f.id)}">▶ Watch walkthrough</a>`}
  </li>`).join("");
}

$("#newFilter").addEventListener("change", (e) => { filter = e.target.value; render(); });
$("#clearNew").addEventListener("click", () => { markSeen(FEATURES.map((f) => f.id)); render(); });
$("#newList").addEventListener("click", (e) => {
  const tour = e.target.closest("[data-tour]");
  if (tour) return markSeen([tour.dataset.tour]);
  const shot = e.target.closest("[data-shot]");
  if (!shot) return;
  const f = FEATURES.find((x) => x.id === shot.dataset.shot);
  $("#shotImg").src = f.shot;
  $("#shotImg").alt = `Screenshot: ${f.title}`;
  $("#shotCaption").textContent = `📍 ${f.where}`;
  $("#shotDlg").showModal();
  markSeen([f.id]);
  render();
});
$("#shotDlg").addEventListener("click", () => $("#shotDlg").close());

render();
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
