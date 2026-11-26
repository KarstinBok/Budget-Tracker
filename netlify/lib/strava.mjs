// Strava sync for Food & fitness: workouts recorded on Garmin, Life Fitness or anything else
// that sends them to Strava are added to the person's exercise diary automatically.
//
// Set up once: create an API app at https://www.strava.com/settings/api with
// "Authorization Callback Domain" set to this site's domain, then add STRAVA_CLIENT_ID and
// STRAVA_CLIENT_SECRET in Netlify's environment variables and redeploy. Each person then
// taps "Connect Strava" in the Exercise panel. The webhook subscription (Strava tells
// /api/strava/webhook about every new, changed or deleted activity) is made on the first
// connect.
//
// Netlify Blobs store "strava" (private: never sent to the page):
//   tokens  { athletes: { [athleteId]: { person, name, access_token, refresh_token, expires_at, t } } }
//   sub     { id }  the webhook subscription
// The fitness doc only holds doc.strava[person] = { athlete, name, t } (who is connected),
// and on each imported exercise: source "strava" and stravaId.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { latestWeightOf } from "../../public/calc.js";
import { FITNESS_KEY, defaultDoc, normalize } from "../functions/fitness.mjs";
import { notifyChange } from "./notify.mjs";
import { fail, updateDoc } from "./shared-doc.mjs";

const API = "https://www.strava.com/api/v3";
const SCOPE = "read,activity:read_all"; // read_all so workouts set to "Only me" come in too
const BACKFILL_DAYS = 14;
const MAX_IGNORED = 500;

const stravaStore = () => getStore({ name: "strava", consistency: "strong" });

export const stravaConfigured = () => Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);

const sign = (text) => createHmac("sha256", process.env.STRAVA_CLIENT_SECRET).update(text).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// The token Strava echoes back when the webhook subscription is made (no extra setting needed).
export const verifyToken = () => sign("webhook").slice(0, 32);

// ---------------------------------------------------------------- connecting

// The Strava login page for `person`, with a signed state so the callback knows whose it is.
export function authorizeUrl(origin, person) {
  const payload = `${Buffer.from(person).toString("base64url")}.${Date.now()}`;
  const u = new URL("https://www.strava.com/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: `${origin}/api/strava/callback`,
    response_type: "code",
    approval_prompt: "auto",
    scope: SCOPE,
    state: `${payload}.${sign(payload)}`,
  });
  return u.href;
}

// The person a callback's state was made for, or null if it's forged or older than 30 minutes.
export function personFromState(state) {
  const [who, ts, sig] = String(state ?? "").split(".");
  if (!who || !ts || !sig || !safeEqual(sig, sign(`${who}.${ts}`))) return null;
  if (Date.now() - Number(ts) > 30 * 60 * 1000) return null;
  return Buffer.from(who, "base64url").toString();
}

async function tokenRequest(params) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Strava login failed (${res.status})`);
  return data;
}

async function updateTokens(change) {
  const store = stravaStore();
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await store.getWithMetadata("tokens", { type: "json" });
    const value = current?.data ?? { athletes: {} };
    change(value);
    const res = await store.setJSON("tokens", value, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (res.modified) return value;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error("Strava tokens stayed busy");
}

const athleteName = (a) => [a?.firstname, a?.lastname].filter(Boolean).join(" ") || "Strava";

// After the Strava login: swaps the code for tokens, links the athlete to `person`, makes the
// webhook subscription if there isn't one, and brings in the last two weeks of workouts.
export async function finishConnect(origin, person, code, scope) {
  if (!String(scope ?? "").includes("activity:read")) fail("Tick “View data about your activities” on Strava's page, so workouts can be read");
  const data = await tokenRequest({ code, grant_type: "authorization_code" });
  const id = String(data.athlete?.id ?? "");
  if (!id) throw new Error("Strava didn't say whose account this is");
  const name = athleteName(data.athlete);
  await updateTokens((v) => {
    for (const [aid, a] of Object.entries(v.athletes)) if (a.person === person && aid !== id) delete v.athletes[aid]; // one account each
    v.athletes[id] = { person, name, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at, t: Date.now() };
  });
  await updateDoc({
    key: FITNESS_KEY, defaultDoc, normalize, by: person,
    mutate(doc) {
      doc.strava[person] = { athlete: id, name, t: Date.now() };
      return `connected ${person}'s Strava (${name})`;
    },
  });
  await ensureSubscription(origin).catch((err) => console.error("Strava webhook subscription failed:", err.message));
  return syncRecent(person).catch((err) => {
    console.error("Strava backfill failed:", err.message);
    return 0;
  });
}

export async function disconnect(person) {
  let token = null;
  await updateTokens((v) => {
    for (const [aid, a] of Object.entries(v.athletes)) if (a.person === person) {
      token = a.access_token;
      delete v.athletes[aid];
    }
  });
  if (token) await fetch("https://www.strava.com/oauth/deauthorize", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  await updateDoc({
    key: FITNESS_KEY, defaultDoc, normalize, by: person,
    mutate(doc) {
      if (!doc.strava[person]) return null;
      delete doc.strava[person];
      return `disconnected ${person}'s Strava`;
    },
  });
}

// Strava sends events for every athlete of this API app to one callback URL.
async function ensureSubscription(origin) {
  const store = stravaStore();
  const auth = new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET });
  const listed = await fetch(`${API}/push_subscriptions?${auth}`).then((r) => r.json()).catch(() => []);
  const callback = `${origin}/api/strava/webhook`;
  const existing = Array.isArray(listed) ? listed.find((s) => s.callback_url === callback) ?? listed[0] : null;
  if (existing) {
    await store.setJSON("sub", { id: existing.id });
    return;
  }
  const res = await fetch(`${API}/push_subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, callback_url: callback, verify_token: verifyToken() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data.errors ?? data.message ?? res.status));
  await store.setJSON("sub", { id: data.id });
}

export async function subscriptionId() {
  return (await stravaStore().get("sub", { type: "json" }))?.id ?? null;
}

// ---------------------------------------------------------------- reading activities

// An access token for the athlete, refreshed when it's about to expire.
async function accessToken(athleteId) {
  const { athletes } = (await stravaStore().get("tokens", { type: "json" })) ?? { athletes: {} };
  const a = athletes[athleteId];
  if (!a) return null;
  if (a.expires_at * 1000 > Date.now() + 120000) return { token: a.access_token, person: a.person };
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: a.refresh_token });
  await updateTokens((v) => {
    if (v.athletes[athleteId]) Object.assign(v.athletes[athleteId], { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at });
  });
  return { token: data.access_token, person: a.person };
}

async function athleteOf(person) {
  const { athletes } = (await stravaStore().get("tokens", { type: "json" })) ?? { athletes: {} };
  return Object.entries(athletes).find(([, a]) => a.person === person)?.[0] ?? null;
}

async function stravaGet(token, path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Strava request failed (${res.status})`);
  return data;
}

// Rough MET values by Strava sport type, for when Strava has no calories (e.g. no heart rate).
const METS = {
  Run: 9.8, TrailRun: 9.8, VirtualRun: 9.8, Walk: 3.5, Hike: 6, Ride: 7.5, VirtualRide: 7.5, EBikeRide: 4,
  MountainBikeRide: 8.5, GravelRide: 8, Swim: 7, WeightTraining: 5, Workout: 5, Crossfit: 8, HighIntensityIntervalTraining: 8,
  Yoga: 3, Pilates: 3, Elliptical: 5, StairStepper: 9, Rowing: 7, VirtualRow: 7, Badminton: 5.5, Tennis: 7.3,
};

const SPORT_NAMES = {
  Run: "Run", TrailRun: "Trail run", VirtualRun: "Treadmill run", Walk: "Walk", Hike: "Hike", Ride: "Ride", VirtualRide: "Indoor ride",
  Swim: "Swim", WeightTraining: "Weights", Workout: "Workout", HighIntensityIntervalTraining: "HIIT", Yoga: "Yoga", Pilates: "Pilates",
  Elliptical: "Elliptical", StairStepper: "Stair stepper", Rowing: "Rowing", Crossfit: "CrossFit",
};

// A diary exercise from a Strava activity (calories: Strava's, else kJ for rides, else worked
// out from the person's weight).
function toExercise(doc, person, a) {
  const sport = a.sport_type || a.type || "Workout";
  const minutes = Math.round((a.moving_time || a.elapsed_time || 0) / 60);
  const date = String(a.start_date_local ?? a.start_date ?? "").slice(0, 10);
  let kcal = Math.round(Number(a.calories) || 0);
  if (!kcal && a.kilojoules) kcal = Math.round(a.kilojoules); // ~1 kcal burned per kJ of work on a bike
  if (!kcal) {
    const kg = latestWeightOf(doc, person, date)?.kg;
    if (kg && minutes) kcal = Math.round(((METS[sport] ?? 5) * kg * minutes) / 60);
  }
  const km = a.distance >= 100 ? `${(a.distance / 1000).toFixed(a.distance >= 10000 ? 1 : 2)} km` : "";
  const note = [SPORT_NAMES[sport] ?? sport.replace(/([a-z])([A-Z])/g, "$1 $2"), km].filter(Boolean).join(" · ");
  return { date, name: String(a.name || SPORT_NAMES[sport] || "Workout").slice(0, 60), minutes: Math.min(minutes, 1440), kcal: Math.min(kcal, 10000), note: note.slice(0, 120) };
}

// Adds or updates one Strava activity in the diary. Returns "added", "linked", "updated",
// "removed" or null (nothing to do). A workout already added by hand on the same day for
// about the same time is linked rather than added twice, keeping its calories.
function applyActivity(doc, person, a, { deleted = false } = {}) {
  const id = String(a.id);
  const old = doc.exercises.find((x) => x.stravaId === id);
  if (deleted) {
    if (!old) return null;
    doc.exercises = doc.exercises.filter((x) => x !== old);
    return "removed";
  }
  if (doc.stravaIgnored.includes(id)) return null; // deleted in the diary: leave it out
  const x = toExercise(doc, person, a);
  if (!x.date) return null;
  if (old) {
    const before = JSON.stringify(old);
    Object.assign(old, { date: x.date, name: old.edited ? old.name : x.name, minutes: x.minutes, note: old.edited ? old.note : x.note, kcal: old.edited ? old.kcal : x.kcal });
    return JSON.stringify(old) === before ? null : "updated";
  }
  const near = doc.exercises.find((e) => e.person === person && e.date === x.date && !e.stravaId
    && Math.abs((e.minutes || 0) - x.minutes) <= Math.max(5, x.minutes * 0.2));
  if (near) {
    near.stravaId = id;
    return "linked";
  }
  if (doc.exercises.length >= 10000) fail("Too many exercises");
  doc.exercises.push({ id: randomUUID(), person, ...x, source: "strava", stravaId: id, by: "Strava", t: Date.now() });
  return "added";
}

// Pulls the person's activities from the last two weeks and adds any that are missing.
// Returns how many were added. Used after connecting and by "Sync now".
export async function syncRecent(person, days = BACKFILL_DAYS) {
  const athlete = await athleteOf(person);
  if (!athlete) fail(`${person} hasn't connected Strava yet`);
  const { token } = await accessToken(athlete);
  const after = Math.floor(Date.now() / 1000) - days * 86400;
  const list = (await stravaGet(token, `/athlete/activities?after=${after}&per_page=100`)) ?? [];
  const current = await getStore({ name: "japan-trip", consistency: "strong" }).get(FITNESS_KEY, { type: "json" });
  const known = new Set((current?.exercises ?? []).filter((x) => x.stravaId).map((x) => x.stravaId));
  const ignored = new Set(current?.stravaIgnored ?? []);
  // The list leaves out calories, so read each new one in full (a few requests at most).
  const fresh = [];
  for (const a of list.filter((a) => !known.has(String(a.id)) && !ignored.has(String(a.id)))) {
    fresh.push((await stravaGet(token, `/activities/${a.id}`)) ?? a);
  }
  if (!fresh.length) return 0;
  let added = 0;
  await updateDoc({
    key: FITNESS_KEY, defaultDoc, normalize, by: "Strava",
    mutate(doc) {
      added = 0;
      for (const a of fresh) if (applyActivity(doc, person, a) === "added") added++;
      return added ? `added ${added} workout${added === 1 ? "" : "s"} from ${person}'s Strava` : null;
    },
  });
  return added;
}

// ---------------------------------------------------------------- webhook events

// One event from Strava: { object_type, aspect_type, object_id, owner_id, subscription_id, updates }.
// Strava doesn't sign these, so nothing is taken from the event itself: the activity is read
// back from Strava with the owner's token (and a delete only counts if Strava agrees it's gone).
export async function handleEvent(event) {
  const owner = String(event.owner_id ?? "");
  if (event.object_type === "athlete") {
    if (String(event.updates?.authorized) !== "false") return;
    const { athletes } = (await stravaStore().get("tokens", { type: "json" })) ?? { athletes: {} };
    const person = athletes[owner]?.person;
    if (person) await disconnect(person); // they removed access on Strava's side
    return;
  }
  if (event.object_type !== "activity") return;
  const auth = await accessToken(owner);
  if (!auth) return; // not one of ours (or disconnected)
  const activity = await stravaGet(auth.token, `/activities/${event.object_id}`);
  const deleted = !activity; // 404: deleted, or made private without read_all
  if (deleted && event.aspect_type !== "delete") return;
  let result = null;
  const doc = await updateDoc({
    key: FITNESS_KEY, defaultDoc, normalize, by: "Strava",
    mutate(d) {
      result = applyActivity(d, auth.person, activity ?? { id: event.object_id }, { deleted });
      return result === "added" ? `added ${d.exercises.at(-1).name} from ${auth.person}'s Strava`
        : result === "removed" ? `removed a workout deleted on ${auth.person}'s Strava` : null;
    },
  });
  if (doc && result === "added") await notifyChange(FITNESS_KEY, { op: "addExercise" }, "Strava", doc);
}
