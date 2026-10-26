// Fireflies webhook: POST /api/fireflies-webhook
//
// Fireflies calls this when a recording has been transcribed (event "meeting.transcribed").
// It checks the signature, then hands the recording to the background import
// (fireflies-import-background.mjs), since fetching it and asking Claude can take longer
// than Fireflies waits for an answer (30 s).
//
// Set up in Fireflies at app.fireflies.ai/integrations/api/webhook: this URL, the same
// signing secret as FIREFLIES_WEBHOOK_SECRET, and the "meeting.transcribed" event.

import { firefliesConfigured, startImport, validWebhookSignature } from "../lib/fireflies.mjs";
import { json } from "../lib/shared-doc.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!firefliesConfigured() || !process.env.FIREFLIES_WEBHOOK_SECRET) {
    return json({ error: "Set FIREFLIES_API_KEY and FIREFLIES_WEBHOOK_SECRET on Netlify first" }, 503);
  }

  const raw = await req.text();
  if (!validWebhookSignature(raw, req.headers.get("x-hub-signature"))) {
    return json({ error: "Invalid signature" }, 401);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  // V2 sends { event, meeting_id }; the older V1 format sends { eventType, meetingId }.
  const id = String(body.meeting_id ?? body.meetingId ?? "").trim();
  const event = String(body.event ?? body.eventType ?? "");
  if (!id) return json({ ok: true, ignored: "no meeting id" }); // e.g. Fireflies' test event
  if (event && !/transcri/i.test(event)) return json({ ok: true, ignored: event });

  await startImport(req.url, { ids: [id] }); // a failure here returns 500, so Fireflies retries
  return json({ ok: true, queued: id }, 202);
};

export const config = { path: "/api/fireflies-webhook" };
