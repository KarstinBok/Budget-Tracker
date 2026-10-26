// Background import of Fireflies recordings into the journal (see netlify/lib/fireflies.mjs).
// Netlify runs functions named "*-background" for up to 15 minutes and answers the caller
// straight away with 202.
//
//   POST /.netlify/functions/fireflies-import-background  (header x-import-token)
//     { ids: [...] }   import these recordings
//     { sync: true }   import every recording made during the trip that isn't in yet
//
// Only other functions on this site can start it (fireflies-webhook, fireflies-sync).

import { importRecording, importTripRecordings, internalToken, sameSecret } from "../lib/fireflies.mjs";

const RETRY_EMPTY_MS = [30_000, 90_000, 180_000]; // a webhook can arrive before the text is ready

export default async (req) => {
  if (!process.env.FIREFLIES_API_KEY || !sameSecret(req.headers.get("x-import-token"), internalToken())) return;
  const body = await req.json().catch(() => ({}));

  if (body.sync) {
    console.log("Fireflies sync", await importTripRecordings());
    return;
  }
  for (const id of (Array.isArray(body.ids) ? body.ids : []).slice(0, 20).map(String)) {
    try {
      let result = await importRecording(id);
      for (const wait of RETRY_EMPTY_MS) {
        if (result !== "empty") break;
        await new Promise((r) => setTimeout(r, wait));
        result = await importRecording(id);
      }
      console.log("Fireflies import", id, result);
    } catch (err) {
      console.error("Fireflies import failed for", id, err);
    }
  }
};
