// Trip journal API: GET/POST /api/journal (see netlify/lib/shared-doc.mjs).
// Entries are write-ups of what happened on the trip, each with lessons learned
// ("avoid", "tip" or "keep") to look back on when planning the next one.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LESSON_TYPES = ["avoid", "tip", "keep"];
const MAX_ENTRIES = 1000;
const MAX_LESSONS = 30;

function defaultDoc() {
  return { version: 0, schema: 1, updatedAt: Date.now(), entries: [], log: [] };
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
      Object.assign(entry, cleanEntry(body.entry), { editedBy: by, editedAt: Date.now() });
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
  key: "journal-v1",
  defaultDoc,
  applyOp,
  busyMessage: "The journal is busy, please try again.",
});

export const config = { path: "/api/journal" };
