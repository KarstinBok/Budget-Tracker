// ✨ What's new (/new/): the latest features from features.js, each opening into a numbered
// walkthrough with a Try it link. Opening this page marks every feature as seen on this phone.

import { $, esc, store, fmtDay } from "/common.js";
import { FEATURES } from "/new/features.js";

const seenBefore = new Set(JSON.parse(store.get("new.seen") || "[]"));
store.set("new.seen", JSON.stringify(FEATURES.map((f) => f.id)));

// One filter chip per app (the part before any "·" so combined entries show under both).
const appsOf = (f) => f.app.split("·").map((a) => a.trim());
const APPS = [...new Set(FEATURES.flatMap(appsOf))];
let filter = "all";

function render() {
  $("#newFilter").innerHTML = [["all", "All"], ...APPS.map((a) => [a, a])].map(([v, l]) =>
    `<label><input type="radio" name="newApp" value="${esc(v)}" ${v === filter ? "checked" : ""} /><span>${esc(l)}</span></label>`).join("");
  const list = FEATURES.filter((f) => filter === "all" || appsOf(f).includes(filter));
  const open = location.hash.slice(1);
  $("#newList").innerHTML = list.map((f) => `<li class="new-item" id="${esc(f.id)}">
    <details ${f.id === open ? "open" : ""}>
      <summary>
        <span class="new-meta">${esc(f.app)} · ${fmtDay(f.date, { day: "numeric", month: "short" })}${seenBefore.has(f.id) ? "" : ` <span class="new-badge">New</span>`}</span>
        <b class="new-title">${esc(f.title)}</b>
        <span class="muted small">${esc(f.why)}</span>
      </summary>
      <ol class="new-steps">${f.steps.map((s) => `<li><span>${s}</span></li>`).join("")}</ol>
      ${f.try ? `<a class="btn new-try" href="${esc(f.try.href)}">${esc(f.try.label)} →</a>` : ""}
    </details>
  </li>`).join("");
}

$("#newFilter").addEventListener("change", (e) => { filter = e.target.value; render(); });
render();
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
