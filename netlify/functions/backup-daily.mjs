// Scheduled daily backup of every document, so there is a recent copy even on days with
// no changes. Netlify runs it on the published site; see netlify/lib/backups.mjs.

import { snapshotAll } from "../lib/backups.mjs";

export default async () => {
  const saved = await snapshotAll();
  console.log(`Daily backup saved ${saved} document(s)`);
};

export const config = { schedule: "@daily" };
