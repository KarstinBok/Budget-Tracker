// Trip journal – client.
// Talks to /api/journal (netlify/functions/journal.mjs). Entries are write-ups of what
// happened, each with lessons learned; everyone sees new and edited entries live.

import {
  $, esc, store, localToday, dayNumber, fmtDay, timeAgo, toast,
  downloadFile, setupIdentity, createSync, fetchJson,
} from "./common.js";

const TAGS = [
  "General", "Transport", "Food & Drinks", "Lodging", "Activities", "Shopping",
  "Money", "Planning & bookings", "Packing", "Health & safety", "Other",
];
const LESSON_TYPES = {
  avoid: { icon: "⚠️", label: "Avoid" },
  tip: { icon: "💡", label: "Tip" },
  keep: { icon: "✅", label: "Do again" },
};
const DRAFT_KEY = "journal.draft";
const LONG_TEXT_PX = 220; // transcripts taller than this start collapsed

let doc = null;
let trip = null; // { name, start, end } from the budget tracker, for day numbers
let lessonFilter = "all";
let editing = null; // entry being edited, or null for a new entry
const expanded = new Set(); // entry ids whose full transcript is shown

const sync = createSync({
  path: "/api/journal",
  schema: 1, // matches the schema in netlify/functions/journal.mjs
  onDoc(next) {
    doc = next;
    render();
  },
});

// ---------------------------------------------------------------- helpers

function dayLabel(date) {
  const day = trip && date >= trip.start && date <= trip.end ? `Day ${dayNumber(date, trip.start)} · ` : "";
  return `${day}${fmtDay(date, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`;
}

function sortedEntries() {
  return [...doc.entries].sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
}

function matches(entry, q) {
  if (!q) return true;
  const hay = [entry.title, entry.text, entry.tag, entry.by, ...entry.lessons.map((l) => l.text)].join("\n").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!doc) return;
  renderLessons();
  renderEntries();
}

function renderLessons() {
  const all = sortedEntries().flatMap((e) => e.lessons.map((l) => ({ ...l, entry: e })));
  for (const el of document.querySelectorAll("[data-count]")) {
    const type = el.dataset.count;
    el.textContent = all.filter((l) => type === "all" || l.type === type).length;
  }
  const shown = all.filter((l) => lessonFilter === "all" || l.type === lessonFilter);
  // Mistakes first, then tips, then things worth repeating.
  const order = Object.keys(LESSON_TYPES);
  shown.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  $("#lessons").innerHTML = shown.length
    ? shown.map((l) => `<li class="lesson ${l.type}">
        <span class="lesson-type">${LESSON_TYPES[l.type].icon} ${LESSON_TYPES[l.type].label}</span>
        <span class="lesson-text">${esc(l.text)}</span>
        <a class="lesson-src" href="#entry-${esc(l.entry.id)}">${esc(l.entry.title)} · ${esc(l.entry.tag)} · ${fmtDay(l.entry.date)}</a>
      </li>`).join("")
    : `<li class="empty muted">${all.length ? "No lessons of this kind yet." : "No lessons yet. Add one to a journal entry with ＋ New entry."}</li>`;
}

function renderEntries() {
  const q = $("#search").value.trim().toLowerCase();
  const tag = $("#tagFilter").value;
  const entries = sortedEntries().filter((e) => (!tag || e.tag === tag) && matches(e, q));

  const usedTags = [...new Set(doc.entries.map((e) => e.tag))];
  const tagOptions = [...TAGS.filter((t) => usedTags.includes(t)), ...usedTags.filter((t) => !TAGS.includes(t))];
  const select = $("#tagFilter");
  const wanted = `<option value="">All topics</option>${tagOptions.map((t) => `<option>${esc(t)}</option>`).join("")}`;
  if (select.innerHTML !== wanted) {
    select.innerHTML = wanted;
    select.value = tagOptions.includes(tag) ? tag : "";
  }

  if (!entries.length) {
    $("#entries").innerHTML = `<p class="muted empty-entries">${doc.entries.length
      ? "No entries match your search."
      : "Nothing written yet. Use ＋ New entry to write up what happened, then add the lessons you learned."}</p>`;
    return;
  }

  let lastDate = null;
  $("#entries").innerHTML = entries.map((e) => {
    const heading = e.date !== lastDate ? `<h3 class="entry-day">${dayLabel(e.date)}</h3>` : "";
    lastDate = e.date;
    const edited = e.editedAt ? ` · edited by ${esc(e.editedBy)} ${timeAgo(e.editedAt)}` : "";
    return `${heading}<article class="entry" id="entry-${esc(e.id)}">
      <header class="entry-head">
        <div>
          <h4>${esc(e.title)}</h4>
          <p class="muted small"><span class="tag">${esc(e.tag)}</span> Written by ${esc(e.by)} ${timeAgo(e.t)}${edited}</p>
        </div>
        <div class="entry-actions">
          <button type="button" class="icon-btn" data-edit="${esc(e.id)}" title="Edit">✏️ Edit</button>
          <button type="button" class="icon-btn" data-delete="${esc(e.id)}" title="Delete">🗑</button>
        </div>
      </header>
      ${e.lessons.length ? `<ul class="entry-lessons">${e.lessons.map((l) => `<li class="lesson ${l.type}">
        <span class="lesson-type">${LESSON_TYPES[l.type].icon} ${LESSON_TYPES[l.type].label}</span>
        <span class="lesson-text">${esc(l.text)}</span></li>`).join("")}</ul>` : ""}
      ${e.text ? `<div class="transcript${expanded.has(e.id) ? " open" : ""}" data-id="${esc(e.id)}">${esc(e.text)}</div>
        <button type="button" class="link-btn" data-toggle="${esc(e.id)}" hidden></button>` : ""}
    </article>`;
  }).join("");

  // Collapse long transcripts behind a "Show full write-up" button.
  for (const t of document.querySelectorAll(".transcript")) {
    const btn = t.nextElementSibling;
    const long = t.scrollHeight > LONG_TEXT_PX + 40;
    t.classList.toggle("long", long);
    btn.hidden = !long;
    btn.textContent = t.classList.contains("open") ? "Show less ▲" : "Show full write-up ▼";
  }
}

// ---------------------------------------------------------------- entry editor

const form = $("#entryForm");

function lessonRow(l = { type: "avoid", text: "" }) {
  const li = document.createElement("li");
  if (l.id) li.dataset.id = l.id;
  li.innerHTML = `
    <select aria-label="Kind of lesson">${Object.entries(LESSON_TYPES).map(([k, v]) =>
      `<option value="${k}"${k === l.type ? " selected" : ""}>${v.icon} ${v.label}</option>`).join("")}</select>
    <input maxlength="500" placeholder="e.g. Check the last train time before leaving" aria-label="Lesson" />
    <button type="button" class="icon-btn" data-remove-lesson title="Remove lesson">✕</button>`;
  li.querySelector("input").value = l.text;
  return li;
}

function readForm() {
  const f = form.elements;
  return {
    date: f.date.value,
    tag: f.tag.value,
    title: f.title.value,
    text: f.text.value,
    lessons: [...$("#lessonRows").children].map((li) => ({
      id: li.dataset.id,
      type: li.querySelector("select").value,
      text: li.querySelector("input").value,
    })),
  };
}

function fillForm(entry) {
  const f = form.elements;
  f.tag.innerHTML = [...new Set([...TAGS, entry.tag])].map((t) => `<option>${esc(t)}</option>`).join("");
  f.date.value = entry.date;
  f.tag.value = entry.tag;
  f.title.value = entry.title;
  f.text.value = entry.text;
  $("#lessonRows").replaceChildren(...(entry.lessons.length ? entry.lessons : [undefined]).map((l) => lessonRow(l)));
}

function openEditor(entry = null) {
  editing = entry;
  $("#entryDlgTitle").textContent = entry ? "Edit entry" : "New entry";
  let draft = null;
  if (!entry) {
    try { draft = JSON.parse(store.get(DRAFT_KEY)); } catch { /* no draft */ }
  }
  const today = localToday();
  const defaultDate = trip && (today < trip.start || today > trip.end) ? trip.start : today;
  fillForm(entry ?? draft ?? { date: defaultDate, tag: "General", title: "", text: "", lessons: [] });
  $("#draftNote").hidden = !draft;
  $("#entryDlg").showModal();
  form.elements.title.focus();
}

// Keep an unsaved new entry on this device so a long write-up is never lost.
form.addEventListener("input", () => {
  if (!editing) store.set(DRAFT_KEY, JSON.stringify(readForm()));
});

form.addEventListener("click", (e) => {
  if (e.target.closest("[data-remove-lesson]")) {
    e.target.closest("li").remove();
    if (!editing) store.set(DRAFT_KEY, JSON.stringify(readForm()));
  }
});

$("#addLesson").addEventListener("click", () => {
  const li = lessonRow();
  $("#lessonRows").append(li);
  li.querySelector("input").focus();
});

$("#entryCancel").addEventListener("click", () => $("#entryDlg").close());

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const entry = readForm();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  const ok = editing
    ? await sync.runOp({ op: "updateEntry", id: editing.id, expect: editing.editedAt ?? editing.t, entry }, "Entry updated")
    : await sync.runOp({ op: "addEntry", entry }, "Entry saved");
  submit.disabled = false;
  if (!ok) return; // keep the dialog open so nothing typed is lost
  if (!editing) store.set(DRAFT_KEY, "null");
  $("#entryDlg").close();
});

for (const btn of document.querySelectorAll("[data-new]")) btn.addEventListener("click", () => openEditor());

// ---------------------------------------------------------------- entry actions

$("#entries").addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const id = toggle.dataset.toggle;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    return renderEntries();
  }
  const edit = e.target.closest("[data-edit]");
  if (edit) return openEditor(doc.entries.find((x) => x.id === edit.dataset.edit));

  const del = e.target.closest("[data-delete]");
  if (!del) return;
  // A journal entry can be a long write-up, so deleting takes a second click instead of a prompt.
  if (!del.classList.contains("armed")) {
    del.classList.add("armed");
    del.textContent = "Delete?";
    setTimeout(() => { del.classList.remove("armed"); del.textContent = "🗑"; }, 3000);
    return;
  }
  const entry = doc.entries.find((x) => x.id === del.dataset.delete);
  if (entry) await sync.runOp({ op: "deleteEntry", id: entry.id }, `Deleted "${entry.title}"`);
});

$("#search").addEventListener("input", renderEntries);
$("#tagFilter").addEventListener("change", renderEntries);
$(".lesson-filter").addEventListener("change", (e) => {
  lessonFilter = e.target.value;
  renderLessons();
});

// ---------------------------------------------------------------- export

function toMarkdown() {
  const name = trip?.name ?? "Our trip";
  const entries = sortedEntries();
  const lines = [`# ${name}: journal and lessons learned`, ""];
  if (trip) lines.push(`${fmtDay(trip.start, { month: "long", day: "numeric", year: "numeric" })} to ${fmtDay(trip.end, { month: "long", day: "numeric", year: "numeric" })}`, "");
  lines.push("## Lessons to remember", "");
  for (const [type, { icon, label }] of Object.entries(LESSON_TYPES)) {
    const ls = entries.flatMap((e) => e.lessons.filter((l) => l.type === type).map((l) => ({ ...l, entry: e })));
    if (!ls.length) continue;
    lines.push(`### ${icon} ${label}`, "", ...ls.map((l) => `- ${l.text} _(${l.entry.title}, ${l.entry.tag})_`), "");
  }
  lines.push("## Journal", "");
  for (const e of entries) {
    lines.push(`### ${dayLabel(e.date)}: ${e.title}`, "", `_${e.tag} · written by ${e.by}_`, "");
    if (e.text) lines.push(e.text, "");
    if (e.lessons.length) {
      lines.push("**Lessons:**", "", ...e.lessons.map((l) => `- ${LESSON_TYPES[l.type].icon} **${LESSON_TYPES[l.type].label}:** ${l.text}`), "");
    }
  }
  return lines.join("\n");
}

$("#mdBtn").addEventListener("click", () => {
  if (!doc) return;
  const name = (trip?.name ?? "trip").replace(/[^\w-]+/g, "_");
  downloadFile(`${name}_journal.md`, toMarkdown(), "text/markdown");
});

$("#printBtn").addEventListener("click", () => {
  // Show every write-up in full on paper.
  for (const e of doc?.entries ?? []) expanded.add(e.id);
  renderEntries();
  print();
});

// ---------------------------------------------------------------- boot

async function loadTrip() {
  try {
    const { doc: t } = await fetchJson("/api/trip");
    trip = t.trip;
    $("#tripDates").textContent = `${trip.name} · ${fmtDay(trip.start, { month: "short", day: "numeric" })} – ${fmtDay(trip.end, { month: "short", day: "numeric", year: "numeric" })}`;
    render();
  } catch { /* day numbers are optional */ }
}

setInterval(() => { if (doc) renderEntries(); }, 60000); // refresh "x min ago"
setupIdentity();
sync.start();
loadTrip();
