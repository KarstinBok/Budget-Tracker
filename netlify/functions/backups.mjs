// Backups API (see netlify/lib/backups.mjs):
//
//   GET  /api/backups?doc=trip|journal      -> { backups: [{ key, t, version, count }] }, newest first
//   GET  /api/backups?key=<backup key>      -> that backup's JSON, as a file download
//   POST /api/backups { op: "snapshot" }    -> backs up every document now
//   POST /api/backups { op: "restore", key } -> makes that backup the live document again

import { DOCS, backupStore, docNameForKey, listBackups, parseBackupKey, saveBackup, snapshotAll } from "../lib/backups.mjs";
import { json, liveStore, passcodeError, sleep, str } from "../lib/shared-doc.mjs";

async function restore(backupKey, by) {
  const info = parseBackupKey(backupKey);
  const name = info && docNameForKey(info.docKey);
  if (!name) return json({ error: "Unknown backup" }, 400);
  const snapshot = await backupStore().get(backupKey, { type: "json" });
  if (!snapshot) return json({ error: "That backup no longer exists" }, 404);

  const store = liveStore();
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await store.getWithMetadata(info.docKey, { type: "json" });
    // Continue the live version numbering so open pages accept the restored copy.
    const doc = { ...structuredClone(snapshot), version: (current?.data.version ?? snapshot.version) + 1, updatedAt: Date.now() };
    if (Array.isArray(doc.log)) {
      const when = new Date(info.t).toLocaleString("en-SG", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" });
      doc.log.unshift({ t: doc.updatedAt, by, msg: `restored the backup from ${when} (Singapore time)` });
    }
    const result = await store.setJSON(info.docKey, doc, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (result.modified) {
      await saveBackup(info.docKey, doc);
      return json({ restored: name, doc });
    }
    await sleep(30 + Math.random() * 120 * (attempt + 1));
  }
  return json({ error: "Busy, please try again." }, 409);
}

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;
  const url = new URL(req.url);

  if (req.method === "GET") {
    const key = url.searchParams.get("key");
    if (key) {
      const info = parseBackupKey(key);
      const doc = info && (await backupStore().get(key, { type: "json" }));
      if (!doc) return json({ error: "That backup no longer exists" }, 404);
      return new Response(JSON.stringify(doc, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${key.replace(/[^\w-]+/g, "_")}.json"`,
          "cache-control": "no-store",
        },
      });
    }
    const name = url.searchParams.get("doc");
    if (!DOCS[name]) return json({ error: "Unknown document" }, 400);
    const backups = await listBackups(DOCS[name].key);
    return json({ backups: backups.slice(0, 100), total: backups.length });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (body.op === "snapshot") return json({ saved: await snapshotAll() });
    if (body.op === "restore") return restore(str(body.key, 200), str(body.by, 30) || "Someone");
    return json({ error: "Unknown operation" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/backups" };
