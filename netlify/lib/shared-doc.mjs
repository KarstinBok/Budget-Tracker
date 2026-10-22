// Shared JSON document over Netlify Blobs, used by the trip tracker and the journal.
//
//   GET  <path>?v=<version>  -> { changed:false, version } when the client is up to date,
//                               otherwise { changed:true, doc }
//   POST <path>  { op, by, ... } -> applies one change and returns { changed:true, doc }
//
// Writes are applied server-side as small operations on top of the latest stored copy,
// using the blob's ETag for compare-and-swap, so two people saving at the same moment
// never overwrite each other.

import { getStore } from "@netlify/blobs";

const MAX_LOG = 150;

export function str(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

// Throw from applyOp to reject a request with a 400 (or the given status).
export function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// key: blob key; defaultDoc(): a fresh doc; normalize(doc): upgrade old docs in place;
// applyOp(doc, body, by): mutate doc and return a log line (or null). A doc with a
// `log` array gets each log line added to it.
export function createDocHandler({ key, defaultDoc, normalize = (doc) => doc, applyOp, busyMessage }) {
  return async (req) => {
    const passcode = process.env.TRIP_PASSCODE;
    if (passcode && req.headers.get("x-trip-code") !== passcode) {
      return json({ error: "passcode" }, 401);
    }

    const store = getStore({ name: "japan-trip", consistency: "strong" });

    if (req.method === "GET") {
      const stored = await store.get(key, { type: "json" });
      const doc = stored ? normalize(stored) : defaultDoc();
      const since = new URL(req.url).searchParams.get("v");
      if (since !== null && Number(since) === doc.version) {
        return json({ changed: false, version: doc.version });
      }
      return json({ changed: true, doc });
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const by = str(body.by, 30) || "Someone";

      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await store.getWithMetadata(key, { type: "json" });
        const doc = current ? normalize(current.data) : defaultDoc();

        let message;
        try {
          message = applyOp(doc, body, by);
        } catch (err) {
          if (err.status) return json({ error: err.message }, err.status);
          throw err;
        }

        doc.version += 1;
        doc.updatedAt = Date.now();
        if (message && Array.isArray(doc.log)) {
          doc.log.unshift({ t: doc.updatedAt, by, msg: message });
          doc.log.length = Math.min(doc.log.length, MAX_LOG);
        }

        const result = await store.setJSON(
          key,
          doc,
          current ? { onlyIfMatch: current.etag } : { onlyIfNew: true },
        );
        if (result.modified) return json({ changed: true, doc });

        // Someone else wrote in between; back off briefly and re-apply on the newer copy.
        await sleep(30 + Math.random() * 120 * (attempt + 1));
      }
      return json({ error: busyMessage ?? "Busy, please try again." }, 409);
    }

    return json({ error: "Method not allowed" }, 405);
  };
}
