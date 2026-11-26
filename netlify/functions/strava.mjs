// Strava sync endpoints (see netlify/lib/strava.mjs):
//   POST /api/strava/connect     { person }  -> { url } of Strava's login page
//   GET  /api/strava/callback    Strava sends the person back here after logging in
//   POST /api/strava/sync        { person }  -> { added } workouts from the last two weeks
//   POST /api/strava/disconnect  { person }
//   GET  /api/strava/webhook     Strava checking the subscription (hub.challenge)
//   POST /api/strava/webhook     Strava telling us about a new, changed or deleted activity

import { authorizeUrl, disconnect, finishConnect, handleEvent, personFromState, stravaConfigured, subscriptionId, syncRecent, verifyToken } from "../lib/strava.mjs";
import { json, liveStore, passcodeError, str } from "../lib/shared-doc.mjs";
import { FITNESS_KEY } from "./fitness.mjs";

const NOT_SET_UP = "Strava isn't set up yet: add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in Netlify's environment variables, then redeploy.";

async function personOf(name) {
  const doc = await liveStore().get(FITNESS_KEY, { type: "json" });
  const n = str(name, 30).toLowerCase();
  return (doc?.people ?? ["Karstin", "Lilin"]).find((p) => p.toLowerCase() === n) ?? null;
}

const back = (origin, params) => Response.redirect(`${origin}/fitness/?${new URLSearchParams(params)}#diary`, 302);

export default async (req, context) => {
  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();
  const origin = url.origin;

  if (action === "webhook") {
    if (req.method === "GET") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && stravaConfigured() && url.searchParams.get("hub.verify_token") === verifyToken();
      return ok ? json({ "hub.challenge": url.searchParams.get("hub.challenge") }) : json({ error: "Forbidden" }, 403);
    }
    if (req.method !== "POST" || !stravaConfigured()) return json({ ok: true });
    const event = await req.json().catch(() => null);
    if (!event) return json({ error: "Invalid JSON" }, 400);
    const sub = await subscriptionId();
    if (sub && String(event.subscription_id) !== String(sub)) return json({ ok: true, ignored: "other subscription" });
    // Strava wants an answer within 2 seconds, so the work carries on after replying.
    const work = handleEvent(event).catch((err) => console.error("Strava event failed:", err));
    if (context?.waitUntil) context.waitUntil(work);
    else await work;
    return json({ ok: true });
  }

  if (action === "callback") {
    if (!stravaConfigured()) return back(origin, { strava: "error", msg: NOT_SET_UP });
    if (url.searchParams.get("error")) return back(origin, { strava: "error", msg: "Strava wasn't connected (access was cancelled)." });
    const person = personFromState(url.searchParams.get("state"));
    if (!person || !(await personOf(person))) return back(origin, { strava: "error", msg: "That Strava link expired. Tap Connect Strava again." });
    try {
      const added = await finishConnect(origin, person, url.searchParams.get("code"), url.searchParams.get("scope"));
      return back(origin, { strava: "connected", person, added: String(added) });
    } catch (err) {
      console.error("Strava connect failed:", err);
      return back(origin, { strava: "error", msg: err.message });
    }
  }

  const denied = passcodeError(req);
  if (denied) return denied;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!stravaConfigured()) return json({ error: NOT_SET_UP }, 503);
  const body = await req.json().catch(() => ({}));
  const person = await personOf(body.person);
  if (!person) return json({ error: "Pick whose diary this is" }, 400);

  try {
    if (action === "connect") return json({ url: authorizeUrl(origin, person) });
    if (action === "sync") return json({ added: await syncRecent(person) });
    if (action === "disconnect") {
      await disconnect(person);
      return json({ ok: true });
    }
  } catch (err) {
    if (err.status) return json({ error: err.message }, err.status);
    console.error("Strava request failed:", err);
    return json({ error: err.message || "Strava didn't answer, please try again." }, 502);
  }
  return json({ error: "Not found" }, 404);
};

export const config = { path: ["/api/strava/connect", "/api/strava/callback", "/api/strava/sync", "/api/strava/disconnect", "/api/strava/webhook"] };
