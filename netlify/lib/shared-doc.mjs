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
import { saveBackup } from "./backups.mjs";

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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const liveStore = () => getStore({ name: "japan-trip", consistency: "strong" });

// A 401 response when TRIP_PASSCODE is set and the request doesn't carry it, else null.
export function passcodeError(req) {
  const passcode = process.env.TRIP_PASSCODE;
  return passcode && req.headers.get("x-trip-code") !== passcode ? json({ error: "passcode" }, 401) : null;
}

// key: blob key; defaultDoc(): a fresh doc; normalize(doc): upgrade old docs in place;
// applyOp(doc, body, by): mutate doc and return a log line (or null). A doc with a
// `log` array gets each log line added to it. Every saved change is also backed up.
export function createDocHandler({ key, defaultDoc, normalize = (doc) => doc, applyOp, busyMessage }) {
  return async (req) => {
    const denied = passcodeError(req);
    if (denied) return denied;

    const store = liveStore();

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
      try {
        const doc = await updateDoc({ key, defaultDoc, normalize, by, mutate: (d) => applyOp(d, body, by) });
        return doc ? json({ changed: true, doc }) : json({ error: busyMessage ?? "Busy, please try again." }, 409);
      } catch (err) {
        if (err.status) return json({ error: err.message }, err.status);
        throw err;
      }
    }

    return json({ error: "Method not allowed" }, 405);
  };
}

// Applies one change to the stored doc and saves it: mutate(doc) changes the doc and
// returns a log line (or null). Re-applies on the newer copy if someone else saved in
// between, and backs up every saved change. Returns the saved doc, or null if it stayed
// busy. Errors thrown by mutate (e.g. fail()) are passed on. Also used by functions that
// change a doc on the server, such as the Fireflies import.
export async function updateDoc({ key, defaultDoc, normalize = (doc) => doc, mutate, by = "Someone" }) {
  const store = liveStore();
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await store.getWithMetadata(key, { type: "json" });
    const doc = current ? normalize(current.data) : defaultDoc();
    const message = mutate(doc);

    doc.version += 1;
    doc.updatedAt = Date.now();
    if (message && Array.isArray(doc.log)) {
      doc.log.unshift({ t: doc.updatedAt, by, msg: message });
      doc.log.length = Math.min(doc.log.length, MAX_LOG);
    }

    const result = await store.setJSON(key, doc, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (result.modified) {
      await saveBackup(key, doc);
      return doc;
    }
    // Someone else wrote in between; back off briefly and re-apply on the newer copy.
    await sleep(30 + Math.random() * 120 * (attempt + 1));
  }
  return null;
}
