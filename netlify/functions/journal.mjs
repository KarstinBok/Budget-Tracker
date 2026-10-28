// Trip journal API: GET/POST /api/journal (see netlify/lib/shared-doc.mjs).
// Entries are write-ups of what happened on the trip, each with lessons learned
// ("avoid", "tip" or "keep") to look back on when planning the next one.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";
import { lessonsFromNotes } from "../lib/notes.mjs";

export const JOURNAL_KEY = "journal-v1";
// The topics the page offers (public/journal.js), for entries written on the server.
export const TAGS = [
  "General", "Transport", "Food & Drinks", "Lodging", "Activities", "Shopping",
  "Money", "Planning & bookings", "Packing", "Health & safety", "Other",
];
const MAX_SEEN = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LESSON_TYPES = ["avoid", "tip", "keep"];
const MAX_ENTRIES = 1000;
const MAX_LESSONS = 30;

export function defaultDoc() {
  return { version: 0, schema: 1, updatedAt: Date.now(), entries: [], log: [], fireflies: { seen: [] } };
}

export function normalize(doc) {
  doc.fireflies ??= { seen: [] };
  for (const entry of doc.entries) sortPastedNotes(entry);
  return doc;
}

// An entry whose write-up is pasted Fireflies notes, saved without lessons, gets one
// lesson per key point. This happens once per entry (notesSorted), so lessons someone
// removes on purpose don't come back. Ids come from the entry's id, so reads that don't
// save produce the same lessons each time.
function sortPastedNotes(entry) {
  if (entry.notesSorted) return;
  entry.notesSorted = true;
  if (entry.lessons.length || !entry.text) return;
  entry.lessons = lessonsFromNotes(entry.text).slice(0, MAX_LESSONS)
    .map((l, n) => ({ id: `${entry.id.slice(0, 30)}-n${n}`, ...l }));
}

// Fireflies recordings already handled: imported, or checked and found not to be about the
// trip. Only ids are kept, never anything from a recording that was left out.
export const seenRecording = (doc, id) => doc.fireflies.seen.includes(id);

export function markSeen(doc, id) {
  if (seenRecording(doc, id)) return;
  doc.fireflies.seen.push(id);
  if (doc.fireflies.seen.length > MAX_SEEN) doc.fireflies.seen.splice(0, doc.fireflies.seen.length - MAX_SEEN);
}

// Adds an entry drafted from a Fireflies recording, unless it was imported already.
export function importRecordingOp(doc, { id, url, entry }) {
  if (seenRecording(doc, id)) return null;
  if (doc.entries.length >= MAX_ENTRIES) fail("The journal is full");
  const added = { id: randomUUID(), ...cleanEntry(entry), by: "Fireflies", t: Date.now(), source: { kind: "fireflies", id, url } };
  doc.entries.push(added);
  markSeen(doc, id);
  return `imported "${added.title}" from a Fireflies recording${lessonCount(added.lessons.length)}`;
}

// Validates and cleans an entry sent by the page.
function cleanEntry(input = {}) {
  const date = str(input.date, 10);
  if (!DATE_RE.test(date)) fail("Pick a date for this entry");
  const title = str(input.title, 120);
  if (!title) fail("Give the entry a title");
  const lessons = (Array.isArray(input.lessons) ? input.lessons : [])
    .map((l) => ({
      id: /^[\w-]{1,40}$/.test(l?.id ?? "") ? l.id : randomUUID(),
      type: LESSON_TYPES.includes(l?.type) ? l.type : "tip",
      text: str(l?.text, 500),
    }))
    .filter((l) => l.text);
  if (lessons.length > MAX_LESSONS) fail(`Keep it to ${MAX_LESSONS} lessons per entry`);
  return {
    date,
    title,
    tag: str(input.tag, 30) || "General",
    text: String(input.text ?? "").slice(0, 20000).trim(),
    lessons,
  };
}

function lessonCount(n) {
  return n ? ` with ${n} lesson${n === 1 ? "" : "s"}` : "";
}

function applyOp(doc, body, by) {
  switch (body.op) {
    case "addEntry": {
      if (doc.entries.length >= MAX_ENTRIES) fail("The journal is full");
      const entry = { id: randomUUID(), ...cleanEntry(body.entry), by, t: Date.now() };
      sortPastedNotes(entry);
      doc.entries.push(entry);
      return `wrote "${entry.title}"${lessonCount(entry.lessons.length)}`;
    }

    case "updateEntry": {
      const entry = doc.entries.find((e) => e.id === body.id);
      if (!entry) fail("This entry was deleted by someone else", 409);
      // Refuse to overwrite changes made by someone else since this person opened the editor.
      if (body.expect !== (entry.editedAt ?? entry.t)) {
        fail(`${entry.editedBy ?? entry.by} changed this entry while you were editing. Copy your text, then reopen the entry.`, 409);
      }
      const before = entry.text;
      Object.assign(entry, cleanEntry(body.entry), { editedBy: by, editedAt: Date.now() });
      if (entry.text !== before) entry.notesSorted = false; // new notes pasted in: sort them
      sortPastedNotes(entry);
      return `edited "${entry.title}"`;
    }

    case "deleteEntry": {
      const entry = doc.entries.find((e) => e.id === body.id);
      if (!entry) return null; // already gone
      doc.entries = doc.entries.filter((e) => e !== entry);
      return `deleted "${entry.title}"`;
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: JOURNAL_KEY,
  defaultDoc,
  normalize,
  applyOp,
  busyMessage: "The journal is busy, please try again.",
});

export const config = { path: "/api/journal" };
