// Backups of the shared documents in their own Netlify Blobs store, separate from the live
// data. A copy is saved after every change, once a day (scheduled), and on request.
//
// Backup keys look like "trip-v1/2026-10-23T04-33-17-120Z_v42_n37": the document, when it
// was saved, its version and how many expenses or journal entries it held, so a listing
// needs no extra reads.

import { getStore } from "@netlify/blobs";

const STORE = "japan-trip-backups";
const KEEP_RECENT = 300; // newest backups kept per document; older ones thin out to one per day

// The documents that can be backed up and restored, by the name the API uses.
export const DOCS = {
  trip: { key: "trip-v1", count: (doc) => doc.items?.length ?? 0, noun: "expenses" },
  journal: { key: "journal-v1", count: (doc) => doc.entries?.length ?? 0, noun: "journal entries" },
};

export const backupStore = () => getStore({ name: STORE, consistency: "strong" });
const liveStore = () => getStore({ name: "japan-trip", consistency: "strong" }); // same as shared-doc.mjs

export function docNameForKey(docKey) {
  return Object.keys(DOCS).find((name) => DOCS[name].key === docKey);
}

// Saves a copy of doc. Never throws: a failed backup must not fail the change itself.
export async function saveBackup(docKey, doc) {
  try {
    const name = docNameForKey(docKey);
    const count = name ? DOCS[name].count(doc) : 0;
    const stamp = new Date(doc.updatedAt ?? Date.now()).toISOString().replace(/[:.]/g, "-");
    await backupStore().setJSON(`${docKey}/${stamp}_v${doc.version}_n${count}`, doc);
    if (Math.random() < 0.05) await pruneBackups(docKey);
  } catch (err) {
    console.error(`Backup of ${docKey} failed:`, err);
  }
}

// Parses a backup key back into its parts; null if it isn't one.
export function parseBackupKey(key) {
  const m = /^([\w-]+)\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_v(\d+)_n(\d+)$/.exec(key);
  if (!m) return null;
  const [, docKey, date, h, min, s, ms, version, count] = m;
  return { key, docKey, t: Date.parse(`${date}T${h}:${min}:${s}.${ms}Z`), version: Number(version), count: Number(count) };
}

export async function listBackups(docKey) {
  const { blobs } = await backupStore().list({ prefix: `${docKey}/` });
  return blobs.map((b) => parseBackupKey(b.key)).filter(Boolean).sort((a, b) => b.t - a.t);
}

// Keeps the newest KEEP_RECENT backups plus the last one of every earlier day.
async function pruneBackups(docKey) {
  const all = await listBackups(docKey);
  const keepDaily = new Set();
  for (const b of all.slice(KEEP_RECENT)) { // newest first, so the first per day is its last
    const day = new Date(b.t).toISOString().slice(0, 10);
    if (!keepDaily.has(day)) {
      keepDaily.add(day);
      b.keep = true;
    }
  }
  const store = backupStore();
  for (const b of all.slice(KEEP_RECENT)) {
    if (!b.keep) await store.delete(b.key);
  }
}

// Backs up every document as it is right now. Returns how many were saved.
export async function snapshotAll() {
  let saved = 0;
  for (const { key } of Object.values(DOCS)) {
    const doc = await liveStore().get(key, { type: "json" });
    if (doc) {
      await saveBackup(key, { ...doc, updatedAt: Date.now() });
      saved++;
    }
  }
  return saved;
}
