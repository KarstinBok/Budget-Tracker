// Fireflies → trip journal. Each recording is fetched from the Fireflies API, checked,
// and written into the journal as an entry with its lessons sorted by Claude.
//
// A recording only becomes an entry if it was made during the trip (the dates in the
// budget tracker's settings) AND Claude judges it to be a note about the trip. Anything
// else (work calls, private conversations) is skipped: only its id is remembered so it
// isn't checked again, and nothing from it is stored.
//
// Needs FIREFLIES_API_KEY (Fireflies → Settings → Developer settings) and ANTHROPIC_API_KEY.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { draftEntry } from "./claude.mjs";
import { liveStore, updateDoc } from "./shared-doc.mjs";
import {
  JOURNAL_KEY, TAGS, defaultDoc, importRecordingOp, markSeen, normalize, seenRecording,
} from "../functions/journal.mjs";

const API = "https://api.fireflies.ai/graphql";
const TRIP_TZ = "Asia/Tokyo"; // recordings are dated in Japan time
const TRIP_KEY = "trip-v1";

export const firefliesConfigured = () => Boolean(process.env.FIREFLIES_API_KEY);

async function gql(query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.FIREFLIES_API_KEY}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors?.length) {
    throw new Error(`Fireflies API: ${data.errors?.[0]?.message ?? res.status}`);
  }
  return data.data;
}

const tokyoDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TRIP_TZ }).format(new Date(ms));

function mmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// One recording, with its transcript as "[mm:ss] Speaker: text" lines.
export async function getRecording(id) {
  const { transcript: t } = await gql(
    `query Transcript($id: String!) {
      transcript(id: $id) { id title date transcript_url sentences { speaker_name text start_time } }
    }`,
    { id },
  );
  if (!t) return null;
  const text = (t.sentences ?? [])
    .map((s) => `[${mmss(s.start_time)}] ${s.speaker_name ? `${s.speaker_name}: ` : ""}${s.text}`)
    .join("\n");
  return {
    id: t.id,
    title: t.title ?? "",
    date: tokyoDate(Number(t.date) || Date.now()),
    url: t.transcript_url || `https://app.fireflies.ai/view/${t.id}`,
    text,
  };
}

// Ids of the recordings you made between two dates (inclusive, YYYY-MM-DD).
export async function listRecordings(start, end) {
  const ids = [];
  const toDate = new Date(Date.parse(`${end}T00:00:00+09:00`) + 86_400_000).toISOString();
  for (let skip = 0; skip < 500; skip += 50) {
    const { transcripts } = await gql(
      `query Recent($from: DateTime, $to: DateTime, $skip: Int) {
        transcripts(fromDate: $from, toDate: $to, mine: true, limit: 50, skip: $skip) { id }
      }`,
      { from: new Date(`${start}T00:00:00+09:00`).toISOString(), to: toDate, skip },
    );
    ids.push(...(transcripts ?? []).map((t) => t.id));
    if (!transcripts || transcripts.length < 50) break;
  }
  return ids;
}

async function tripDates() {
  const trip = (await liveStore().get(TRIP_KEY, { type: "json" }))?.trip;
  return trip?.start && trip?.end ? { start: trip.start, end: trip.end } : null;
}

const saveJournal = (mutate) => updateDoc({ key: JOURNAL_KEY, defaultDoc, normalize, by: "Fireflies", mutate });

// Imports one recording. Returns what happened: "imported", "already", "not-travel",
// "outside-trip" or "empty".
export async function importRecording(id) {
  const journal = normalize((await liveStore().get(JOURNAL_KEY, { type: "json" })) ?? defaultDoc());
  if (seenRecording(journal, id)) return "already";

  const rec = await getRecording(id);
  if (!rec || !rec.text.trim()) return "empty"; // not transcribed yet; try again later

  const trip = await tripDates();
  if (trip && (rec.date < trip.start || rec.date > trip.end)) return "outside-trip";

  const draft = await draftEntry({ text: rec.text, fileName: rec.title, date: rec.date, tags: TAGS, travelCheck: true });
  if (!draft.isTravelNote) {
    await saveJournal((doc) => { markSeen(doc, id); return null; });
    return "not-travel";
  }

  const entry = { date: rec.date, tag: draft.tag, title: draft.title || rec.title || "Voice note", text: draft.text, lessons: draft.lessons };
  let added = false;
  await saveJournal((doc) => {
    const msg = importRecordingOp(doc, { id, url: rec.url, entry });
    added = Boolean(msg);
    return msg;
  });
  return added ? "imported" : "already";
}

// Every recording made during the trip that isn't in the journal yet.
export async function importTripRecordings() {
  const trip = await tripDates();
  if (!trip) return {};
  const results = {};
  for (const id of await listRecordings(trip.start, trip.end)) {
    try {
      results[id] = await importRecording(id);
    } catch (err) {
      console.error("Fireflies import failed for", id, err);
      results[id] = "error";
    }
  }
  return results;
}

// ---------------------------------------------------------------- request checks

// The token functions on this site use to start the background import, so it can't be
// started from outside. Derived from the Fireflies key, so there's no extra setting.
export function internalToken() {
  return createHash("sha256").update(`trip-journal-import:${process.env.FIREFLIES_API_KEY}`).digest("hex");
}

export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Fireflies signs webhooks as X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>.
export function validWebhookSignature(rawBody, header) {
  const secret = process.env.FIREFLIES_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return sameSecret(expected, header);
}

// Starts the background import on this site and returns once it has been accepted.
export async function startImport(siteUrl, body) {
  const res = await fetch(new URL("/.netlify/functions/fireflies-import-background", siteUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-import-token": internalToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Couldn't start the import (${res.status})`);
}
