// Turns a transcript into a journal entry draft with Claude. Used by the transcript
// upload (/api/categorize) and the Fireflies import.
//
//   draftEntry({ text | pdf, fileName?, date?, tags, travelCheck? })
//   -> { isTravelNote, title, tag, text, lessons: [{ type, text }] }
//
// With travelCheck, Claude also decides whether the recording is a note about the trip
// at all, so private or work recordings are never written into the shared journal.
// Needs ANTHROPIC_API_KEY. CLAUDE_MODEL is optional.

import { str } from "./shared-doc.mjs";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
export const LESSON_TYPES = ["avoid", "tip", "keep"];
const MAX_TEXT = 200_000; // characters of transcript sent to Claude

// An error with a message that's safe to show on the page.
export class DraftError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function entryTool(travelCheck) {
  const properties = {
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
  };
  const required = ["title", "tag", "summary", "lessons"];
  if (travelCheck) {
    properties.is_travel_note = {
      type: "boolean",
      description: "True only if the recording is mainly about the trip: travel experiences, logistics, places, food, plans or lessons. False for anything else, such as health or medical matters, work, money or other private conversations, even if travel is mentioned in passing.",
    };
    required.unshift("is_travel_note");
  }
  return {
    name: "save_journal_entry",
    description: "Save the travel journal entry drafted from the transcript.",
    input_schema: { type: "object", properties, required },
  };
}

function prompt({ fileName, date, tags, travelCheck }) {
  return [
    "This is a transcript of a voice note, made with the Fireflies note taker, possibly recorded during our trip to Japan.",
    "Turn it into one entry for the trip journal we share with our travel group, and call save_journal_entry.",
    "",
    travelCheck
      ? "- First decide is_travel_note. If it is false, give a placeholder title, summary and no lessons: don't repeat anything from the recording.\n"
      : "",
    `- Topic: choose the best fit from: ${tags.join(", ")}.`,
    "- Summary: what happened, in the order it happened. Drop filler, repetition and timestamps.",
    "  Leave out private details that aren't about the trip, such as health matters.",
    "- Lessons: every takeaway worth remembering for the next trip, each labelled:",
    "  avoid = a mistake or problem to avoid; tip = practical know-how; keep = something that worked and is worth repeating.",
    "  Write each as one short, actionable sentence. Only include lessons the transcript supports.",
    "- Write in the same language as the transcript.",
    fileName ? `\nFile or recording name: ${fileName}` : "",
    date ? `Date: ${date}` : "",
  ].join("\n");
}

export async function draftEntry({ text, pdf, fileName = "", date = "", tags = [], travelCheck = false }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new DraftError("Auto-categorise isn't set up yet: add ANTHROPIC_API_KEY in Netlify's environment variables, then redeploy.", 503);
  }
  const topics = tags.map((t) => str(t, 30)).filter(Boolean).slice(0, 30);
  if (!topics.length) topics.push("General");

  const content = [];
  if (pdf) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } });
  } else {
    const body = String(text ?? "").trim();
    if (!body) throw new DraftError("The transcript is empty", 400);
    content.push({ type: "text", text: `<transcript>\n${body.slice(0, MAX_TEXT)}\n</transcript>` });
  }
  content.push({ type: "text", text: prompt({ fileName: str(fileName, 200), date: str(date, 10), tags: topics, travelCheck }) });

  const tool = entryTool(travelCheck);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(55_000), // Netlify stops synchronous functions at 60 s
    });
  } catch (err) {
    throw new DraftError(err?.name === "TimeoutError"
      ? "That took too long. Try a shorter transcript."
      : "Couldn't reach Claude. Check your connection and try again.", 504);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Claude API error", res.status, data?.error);
    throw new DraftError(`Claude couldn't read the transcript (${data?.error?.message ?? res.status}).`, 502);
  }

  const out = data.content?.find((c) => c.type === "tool_use")?.input ?? {};
  const lessons = (Array.isArray(out.lessons) ? out.lessons : [])
    .map((l) => ({ type: LESSON_TYPES.includes(l?.type) ? l.type : "tip", text: str(l?.text, 500) }))
    .filter((l) => l.text)
    .slice(0, 30);

  return {
    // Without the check every upload counts; with it, only an explicit true does.
    isTravelNote: travelCheck ? out.is_travel_note === true : true,
    title: str(out.title, 120),
    tag: topics.includes(out.tag) ? out.tag : "General",
    text: String(out.summary ?? "").slice(0, 20000).trim(),
    lessons,
  };
}
