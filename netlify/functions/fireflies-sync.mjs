// "Check Fireflies" button on the journal page: POST /api/fireflies-sync
// Starts a background import of every recording made during the trip that isn't in the
// journal yet. New entries then appear on everyone's page through the usual live sync.
// Catches anything the webhook missed, and recordings made before it was set up.

import { firefliesConfigured, startImport } from "../lib/fireflies.mjs";
import { json, passcodeError } from "../lib/shared-doc.mjs";

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!firefliesConfigured()) {
    return json({ error: "Fireflies isn't connected yet: add FIREFLIES_API_KEY in Netlify's environment variables, then redeploy." }, 503);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "Add ANTHROPIC_API_KEY in Netlify's environment variables too, so recordings can be sorted." }, 503);
  }
  try {
    await startImport(req.url, { sync: true });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
  return json({ started: true }, 202);
};

export const config = { path: "/api/fireflies-sync" };
