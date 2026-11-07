// Calories, macros, weight and exercise API: GET/POST /api/fitness (see netlify/lib/shared-doc.mjs).
//
// One shared document, with a separate diary per person:
//  - profiles: body details and goals, which set the daily calorie and macro targets;
//  - foods: what was eaten, by day and meal (breakfast, lunch, snacks, dinner);
//  - weights: weigh-ins (one per person per day);
//  - exercises: workouts and the calories they burned.
// Food can be added by hand or from a photo or description recognised by Claude
// (food-scan.mjs), which the page shows for checking before it's logged here.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";

export const FITNESS_KEY = "fitness-v1";
export const MEALS = ["breakfast", "lunch", "snacks", "dinner"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVITY = ["sedentary", "light", "moderate", "active", "very"];
const MAX_FOODS = 40000;
const MAX_ROWS = 10000;

function defaultProfile() {
  return {
    sex: "", birthYear: null, heightCm: null, goalKg: null, weeklyKg: -0.5,
    activity: "light", kcalTarget: null, macros: { p: 30, c: 40, f: 30 },
  };
}

function defaultDoc() {
  return {
    version: 0,
    schema: 1,
    updatedAt: Date.now(),
    people: ["Karstin", "Lilin"],
    profiles: { Karstin: defaultProfile(), Lilin: defaultProfile() },
    // { id, person, date, meal, name, amount, kcal, p, c, f, fiber?, sugar?, sodium?, source, by, t }
    foods: [],
    // { id, person, date, kg, by, t }
    weights: [],
    // { id, person, date, name, minutes, kcal, note, by, t }
    exercises: [],
    log: [],
  };
}

function normalize(doc) {
  for (const p of doc.people) doc.profiles[p] ??= defaultProfile();
  return doc;
}

const MEAL_NAMES = { breakfast: "breakfast", lunch: "lunch", snacks: "snacks", dinner: "dinner" };

function prettyDate(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function person(doc, name) {
  const n = str(name, 30).toLowerCase();
  const match = doc.people.find((p) => p.toLowerCase() === n);
  if (!match) fail("Pick whose diary this is");
  return match;
}

function date(value) {
  const d = str(value, 10);
  if (!DATE_RE.test(d)) fail("Pick a date");
  return d;
}

// A number within [min, max], rounded to `dp` decimals; null when blank and allowed.
function num(value, { min = 0, max, dp = 0, label, optional = false }) {
  if ((value === "" || value === null || value === undefined) && optional) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(`Check the ${label}`);
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function readFood(body) {
  const name = str(body.name, 80);
  if (!name) fail("Give the food a name");
  const food = {
    name,
    amount: str(body.amount, 60),
    kcal: num(body.kcal, { max: 10000, label: "calories" }),
    p: num(body.p ?? 0, { max: 1000, dp: 1, label: "protein" }),
    c: num(body.c ?? 0, { max: 1000, dp: 1, label: "carbs" }),
    f: num(body.f ?? 0, { max: 1000, dp: 1, label: "fat" }),
    source: ["photo", "describe", "manual", "recent"].includes(body.source) ? body.source : "manual",
  };
  for (const [k, max] of [["fiber", 500], ["sugar", 1000], ["sodium", 50000]]) {
    const v = num(body[k], { max, dp: k === "sodium" ? 0 : 1, label: k, optional: true });
    if (v !== null) food[k] = v;
  }
  const note = str(body.note, 200);
  if (note) food.note = note;
  return food;
}

function meal(value) {
  if (!MEALS.includes(value)) fail("Pick a meal");
  return value;
}

function readProfile(body, old) {
  const p = { ...old };
  if (body.sex !== undefined) p.sex = ["male", "female"].includes(body.sex) ? body.sex : "";
  if (body.birthYear !== undefined) p.birthYear = num(body.birthYear, { min: 1900, max: 2030, label: "birth year", optional: true });
  if (body.heightCm !== undefined) p.heightCm = num(body.heightCm, { min: 50, max: 250, dp: 1, label: "height", optional: true });
  if (body.goalKg !== undefined) p.goalKg = num(body.goalKg, { min: 20, max: 400, dp: 1, label: "goal weight", optional: true });
  if (body.weeklyKg !== undefined) p.weeklyKg = num(body.weeklyKg, { min: -1, max: 1, dp: 2, label: "weekly goal" });
  if (body.activity !== undefined) p.activity = ACTIVITY.includes(body.activity) ? body.activity : "light";
  if (body.kcalTarget !== undefined) p.kcalTarget = num(body.kcalTarget, { min: 800, max: 6000, label: "calorie goal", optional: true });
  if (body.macros !== undefined) {
    const m = { p: num(body.macros?.p, { max: 100, label: "protein %" }), c: num(body.macros?.c, { max: 100, label: "carbs %" }), f: num(body.macros?.f, { max: 100, label: "fat %" }) };
    if (m.p + m.c + m.f !== 100) fail("Protein, carbs and fat should add up to 100%");
    p.macros = m;
  }
  return p;
}

function applyOp(doc, body, by) {
  switch (body.op) {
    case "addFoods": {
      const who = person(doc, body.person);
      const d = date(body.date);
      const m = meal(body.meal);
      const list = (Array.isArray(body.foods) ? body.foods : []).slice(0, 30).map(readFood);
      if (!list.length) fail("Pick at least one food");
      if (doc.foods.length + list.length > MAX_FOODS) fail("The food diary is full");
      const t = Date.now();
      for (const f of list) doc.foods.push({ id: randomUUID(), person: who, date: d, meal: m, ...f, by, t });
      const kcal = list.reduce((s, f) => s + f.kcal, 0);
      const what = list.length === 1 ? list[0].name : `${list.length} foods`;
      return `logged ${what} (${kcal} kcal) to ${who}'s ${MEAL_NAMES[m]} on ${prettyDate(d)}`;
    }

    case "updateFood": {
      const old = doc.foods.find((f) => f.id === body.id);
      if (!old) fail("This food was deleted by someone else", 409);
      const next = readFood({ ...body, source: old.source });
      for (const k of ["fiber", "sugar", "sodium", "note"]) delete old[k];
      Object.assign(old, next, { meal: body.meal ? meal(body.meal) : old.meal, editedBy: by, editedAt: Date.now() });
      return `edited ${old.name} (${old.kcal} kcal) in ${old.person}'s ${MEAL_NAMES[old.meal]}`;
    }

    case "deleteFood": {
      const f = doc.foods.find((x) => x.id === body.id);
      if (!f) return null;
      doc.foods = doc.foods.filter((x) => x !== f);
      return `removed ${f.name} from ${f.person}'s ${MEAL_NAMES[f.meal]} on ${prettyDate(f.date)}`;
    }

    case "addWeight": {
      const who = person(doc, body.person);
      const d = date(body.date);
      const kg = num(body.kg, { min: 20, max: 400, dp: 1, label: "weight" });
      doc.weights = doc.weights.filter((w) => !(w.person === who && w.date === d));
      if (doc.weights.length >= MAX_ROWS) fail("Too many weigh-ins");
      doc.weights.push({ id: randomUUID(), person: who, date: d, kg, by, t: Date.now() });
      return `recorded ${who} at ${kg} kg on ${prettyDate(d)}`;
    }

    case "deleteWeight": {
      const w = doc.weights.find((x) => x.id === body.id);
      if (!w) return null;
      doc.weights = doc.weights.filter((x) => x !== w);
      return `removed ${w.person}'s ${w.kg} kg weigh-in on ${prettyDate(w.date)}`;
    }

    case "addExercise": {
      const who = person(doc, body.person);
      const name = str(body.name, 60);
      if (!name) fail("Name the exercise");
      if (doc.exercises.length >= MAX_ROWS) fail("Too many exercises");
      const x = {
        id: randomUUID(), person: who, date: date(body.date), name,
        minutes: num(body.minutes ?? 0, { max: 1440, label: "minutes" }),
        kcal: num(body.kcal, { max: 10000, label: "calories burned" }),
        note: str(body.note, 120), by, t: Date.now(),
      };
      doc.exercises.push(x);
      return `logged ${who}'s ${name} (${x.minutes} min, ${x.kcal} kcal) on ${prettyDate(x.date)}`;
    }

    case "deleteExercise": {
      const x = doc.exercises.find((e) => e.id === body.id);
      if (!x) return null;
      doc.exercises = doc.exercises.filter((e) => e !== x);
      return `removed ${x.person}'s ${x.name} on ${prettyDate(x.date)}`;
    }

    case "saveProfile": {
      const who = person(doc, body.person);
      doc.profiles[who] = readProfile(body, doc.profiles[who] ?? defaultProfile());
      return `updated ${who}'s goals`;
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: FITNESS_KEY,
  defaultDoc,
  normalize,
  applyOp,
  busyMessage: "The diary is busy, please try again.",
});

export const config = { path: "/api/fitness" };
