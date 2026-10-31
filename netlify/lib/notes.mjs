// Turns meeting notes pasted from Fireflies into journal lessons, without needing Claude.
//
// Fireflies notes look like this (the bullets are often lost when copied, leaving one
// line per item):
//
//   Packing                         <- section heading (Title Case, no timestamp)
//   Pack one clothing set (00:01)   <- key point (ends in a timestamp)
//   Include sleepwear               <- details of that key point
//   Bathrobes preferred there
//
// Each key point becomes one lesson: "Pack one clothing set — Include sleepwear;
// Bathrobes preferred there". Text without timestamped key points is left alone.

const TIMESTAMP = /\s*\(\d{1,2}:\d{2}(?::\d{2})?\)\s*$/;
const SMALL_WORDS = new Set(["and", "or", "of", "to", "the", "a", "an", "in", "on", "for", "at", "by", "&", "vs"]);

// Wording that marks a mistake or a problem to steer clear of, and things that went well.
const AVOID = /\b(avoid|don'?t|do not|never|risky?|limited|lacks?|rushed|reduces?|downgrade|overheat\w*|missed|mistakes?|problems?|wasted?|too late|too early|no space)\b/i;
const KEEP = /\b(comfortable|successful(ly)?|worked( well)?|manageable|no complaints|great|loved|recommend(ed)?)\b/i;

function cleanLine(line) {
  return line
    .replace(/^\s*(#{1,6}\s*|[-*•–>]+\s*|\d+[.)]\s+)/, "") // markdown heading, bullet or number
    .replace(/\*\*|__/g, "")
    .trim();
}

function isTitleCase(line) {
  const words = line.split(/\s+/).filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  return words.length > 0 && words.length <= 5 && words.every((w) => /^[\p{Lu}\d]/u.test(w));
}

// Judged on the key point itself: its details often mention a problem a tip solves.
export function lessonType(text) {
  if (KEEP.test(text)) return "keep";
  if (AVOID.test(text)) return "avoid";
  return "tip";
}

// Returns [{ type, text }] for each key point, or [] if the text isn't Fireflies notes.
export function lessonsFromNotes(text) {
  const raw = String(text ?? "").split(/\r?\n/);
  const lines = raw.map((l) => ({ text: cleanLine(l), heading: /^\s*#{1,6}\s/.test(l) })).filter((l) => l.text);
  const isPoint = (l) => l && !l.heading && TIMESTAMP.test(l.text);
  if (lines.filter(isPoint).length < 2) return [];

  const lessons = [];
  let current = null;
  lines.forEach((line, n) => {
    if (isPoint(line)) {
      current = { point: line.text.replace(TIMESTAMP, ""), details: [] };
      lessons.push(current);
      return;
    }
    // A Title Case line right before a key point is the next section's heading.
    const heading = line.heading || (isPoint(lines[n + 1]) && isTitleCase(line.text));
    if (heading || !current) {
      current = null;
      return;
    }
    current.details.push(line.text);
  });

  return lessons.map(({ point, details }) => ({
    type: lessonType(point),
    text: (details.length ? `${point} — ${details.join("; ")}` : point).slice(0, 500),
  }));
}
