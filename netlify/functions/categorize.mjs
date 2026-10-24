// Transcript to journal entry: POST /api/categorize
//
//   { text, fileName?, date?, tags[] }          a transcript as plain text, or
//   { pdf: <base64>, fileName?, date?, tags[] } a transcript exported as PDF
//
// -> { title, tag, text, lessons: [{ type: "avoid" | "tip" | "keep", text }] }
//
// Sends the transcript (e.g. a Fireflies export) to Claude, which writes a short
// summary and sorts the lessons into Avoid / Tip / Do again. Nothing is saved here:
// the page fills the entry form with the result so it can be checked before saving.
//
// Needs the ANTHROPIC_API_KEY environment variable on Netlify. CLAUDE_MODEL is optional.

import { json, passcodeError, str } from "../lib/shared-doc.mjs";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const MAX_TEXT = 200_000; // characters of transcript sent to Claude
const MAX_PDF = 8_000_000; // base64 characters (~6 MB file)
const LESSON_TYPES = ["avoid", "tip", "keep"];

const ENTRY_TOOL = {
  name: "save_journal_entry",
  description: "Save the travel journal entry drafted from the transcript.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the entry, at most 80 characters." },
      tag: { type: "string", description: "The topic that fits best, chosen from the list given." },
      summary: {
        type: "string",
        description: "What happened, in plain sentences or short bullet lines. Keep the useful specifics (times, places, prices, durations).",
      },
      lessons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: LESSON_TYPES,
              description: "avoid = a mistake or problem not to repeat; tip = useful know-how for next time; keep = something that worked well and is worth doing again.",
            },
            text: { type: "string", description: "One short, actionable sentence." },
          },
          required: ["type", "text"],
        },
      },
    },
    required: ["title", "tag", "summary", "lessons"],
  },
};

function prompt({ fileName, date, tags }) {
  return [
    "This is a transcript of a voice note recorded during our trip to Japan, made with the Fireflies note taker.",
    "Turn it into one travel journal entry and call save_journal_entry.",
    "",
    `- Topic: choose the best fit from: ${tags.join(", ")}.`,
    "- Summary: what happened, in the order it happened. Drop filler, repetition and timestamps.",
    "- Lessons: every takeaway worth remembering for the next trip, each labelled:",
    "  avoid = a mistake or problem to avoid; tip = practical know-how; keep = something that worked and is worth repeating.",
    "  Write each as one short, actionable sentence. Only include lessons the transcript supports.",
    "- Write in the same language as the transcript.",
    fileName ? `\nFile name: ${fileName}` : "",
    date ? `Entry date: ${date}` : "",
  ].join("\n");
}

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: "Auto-categorise isn't set up yet: add ANTHROPIC_API_KEY in Netlify's environment variables, then redeploy." }, 503);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => str(t, 30)).filter(Boolean).slice(0, 30);
  if (!tags.length) tags.push("General");
  const meta = { fileName: str(body.fileName, 200), date: str(body.date, 10), tags };

  const content = [];
  if (body.pdf) {
    const data = String(body.pdf);
    if (data.length > MAX_PDF) return json({ error: "That PDF is too large. Export the transcript as a .txt or .docx instead." }, 413);
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
  } else {
    const text = String(body.text ?? "").trim();
    if (!text) return json({ error: "The transcript is empty" }, 400);
    content.push({ type: "text", text: `<transcript>\n${text.slice(0, MAX_TEXT)}\n</transcript>` });
  }
  content.push({ type: "text", text: prompt(meta) });

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        tools: [ENTRY_TOOL],
        tool_choice: { type: "tool", name: ENTRY_TOOL.name },
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(55_000), // Netlify stops synchronous functions at 60 s
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError";
    return json({ error: timedOut ? "That took too long. Try a shorter transcript." : "Couldn't reach Claude. Check your connection and try again." }, 504);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Claude API error", res.status, data?.error);
    return json({ error: `Claude couldn't read the transcript (${data?.error?.message ?? res.status}).` }, 502);
  }

  const out = data.content?.find((c) => c.type === "tool_use")?.input ?? {};
  const lessons = (Array.isArray(out.lessons) ? out.lessons : [])
    .map((l) => ({ type: LESSON_TYPES.includes(l?.type) ? l.type : "tip", text: str(l?.text, 500) }))
    .filter((l) => l.text)
    .slice(0, 30);

  return json({
    title: str(out.title, 120),
    tag: tags.includes(out.tag) ? out.tag : "General",
    text: String(out.summary ?? "").slice(0, 20000).trim(),
    lessons,
  });
};

export const config = { path: "/api/categorize" };
