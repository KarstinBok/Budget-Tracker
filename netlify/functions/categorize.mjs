// Transcript to journal entry: POST /api/categorize
//
//   { text, fileName?, date?, tags[] }          a transcript as plain text, or
//   { pdf: <base64>, fileName?, date?, tags[] } a transcript exported as PDF
//
// -> { title, tag, text, lessons: [{ type: "avoid" | "tip" | "keep", text }] }
//
// Claude writes a short summary and sorts the lessons into Avoid / Tip / Do again
// (netlify/lib/claude.mjs). Nothing is saved here: the page fills the entry form with
// the result so it can be checked before saving.

import { DraftError, draftEntry } from "../lib/claude.mjs";
import { json, passcodeError } from "../lib/shared-doc.mjs";

const MAX_PDF = 8_000_000; // base64 characters (~6 MB file)

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (body.pdf && String(body.pdf).length > MAX_PDF) {
    return json({ error: "That PDF is too large. Export the transcript as a .txt or .docx instead." }, 413);
  }

  try {
    const { title, tag, text, lessons } = await draftEntry({
      text: body.text,
      pdf: body.pdf ? String(body.pdf) : undefined,
      fileName: body.fileName,
      date: body.date,
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
    return json({ title, tag, text, lessons });
  } catch (err) {
    if (err instanceof DraftError) return json({ error: err.message }, err.status);
    throw err;
  }
};

export const config = { path: "/api/categorize" };
