// Connector for the Claude app: an MCP server (Streamable HTTP, stateless JSON responses)
// at /mcp/<FITNESS_MCP_KEY>. Added to Claude as a custom connector, it lets Claude read
// the food & fitness diary and log to it, e.g. after you send it a photo of a meal:
// Claude works out the ingredients and their weights, looks them up (USDA FoodData
// Central, Open Food Facts, the web) and logs the result here, where the app shows it.
//
// The secret in the URL is the only key, so it's off until FITNESS_MCP_KEY is set on
// Netlify, and the URL should be kept private like a password.

import { timingSafeEqual } from "node:crypto";
import { json, str, updateDoc, liveStore } from "../lib/shared-doc.mjs";
import { lookupFood, lookupUsda } from "../lib/food-lookup.mjs";
import { FITNESS_KEY, MEALS, applyOp, defaultDoc, normalize } from "./fitness.mjs";

const SERVER = { name: "our-food-diary", version: "1.0.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TZ = "Asia/Singapore";
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very: 1.9 };

const INSTRUCTIONS = `Karstin and Lilin's food & fitness diary (calories, macros, weight, exercise), shown in their app at https://japan-trip-budget.netlify.app/fitness/.
When someone sends a photo or description of food to log:
1. Identify each dish and break it into ingredients. Estimate each ingredient's weight in grams from the photo's scale cues (a dinner plate is ~26 cm, a hawker plate ~23 cm, a rice bowl ~250 ml, a dessert spoon ~15 cm), counting pieces where you can, and include cooking oil and sauces.
2. Look up nutrition per 100 g and scale it to each weight: lookup_usda for whole foods and cooked staples; lookup_open_food_facts for packaged products (by barcode if visible); web search for restaurant and chain items (the brand's published nutrition facts) and local dishes (e.g. Singapore HPB). A dish's totals are the sum of its ingredients.
3. Show the person the breakdown (ingredients, grams, kcal, protein, carbs, fat, sources) and the totals, then log it with log_food to the right person, meal and date. If whose diary or which meal isn't clear, ask or infer from the time of day (Singapore time). Mention calories left for the day from the result.
Use get_food_diary to answer questions about the day, goals and what's left. Use delete_food to fix a mistake.`;

// ---------------------------------------------------------------- tools

const num = (description) => ({ type: "number", description });
const PERSON = { type: "string", description: "Whose diary: Karstin or Lilin." };
const DATE = { type: "string", description: "Day as YYYY-MM-DD. Defaults to today in Singapore." };

const TOOLS = [
  {
    name: "get_food_diary",
    title: "Read the food diary",
    description: "A person's diary for one day: calorie and macro goals, each meal's foods (with ids), exercise, totals and what's left, plus their latest weight and goal weight.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { person: PERSON, date: DATE }, required: ["person"] },
  },
  {
    name: "log_food",
    title: "Log food",
    description: "Log one or more foods to a meal in a person's diary. Give the nutrition for the amount eaten. For a dish, include its ingredients with estimated grams and their nutrition (the item's totals should be their sum), and the source of the numbers.",
    inputSchema: {
      type: "object",
      required: ["person", "meal", "foods"],
      properties: {
        person: PERSON,
        date: DATE,
        meal: { type: "string", enum: MEALS },
        foods: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "kcal", "protein_g", "carbs_g", "fat_g"],
            properties: {
              name: { type: "string", description: "Short name, with brand or restaurant if known." },
              amount: { type: "string", description: "Portion in everyday words, e.g. \"1 plate\"." },
              grams: num("Weight of the portion in grams (ml for drinks)."),
              kcal: num("Calories for the portion."),
              protein_g: num("Protein, g."),
              carbs_g: num("Carbohydrates, g."),
              fat_g: num("Fat, g."),
              fiber_g: num("Fibre, g (optional)."),
              sugar_g: num("Sugars, g (optional)."),
              sodium_mg: num("Sodium, mg (optional)."),
              source: { type: "string", description: "Where the numbers came from, e.g. \"USDA FoodData Central\", \"mcdonalds.com.sg\", \"Ingredients\"." },
              source_url: { type: "string", description: "Link to the source, if any." },
              ingredients: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "grams", "kcal"],
                  properties: {
                    name: { type: "string" }, grams: num("g"), kcal: num("kcal"),
                    protein_g: num("g"), carbs_g: num("g"), fat_g: num("g"),
                    source: { type: "string" }, source_url: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "delete_food",
    title: "Delete a logged food",
    description: "Remove a food from the diary by its id (from get_food_diary or log_food).",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "log_weight",
    title: "Log weight",
    description: "Record a weigh-in in kg (replaces any other weigh-in that day).",
    inputSchema: { type: "object", properties: { person: PERSON, date: DATE, kg: num("Weight in kg.") }, required: ["person", "kg"] },
  },
  {
    name: "log_exercise",
    title: "Log exercise",
    description: "Record exercise and the calories it burned (they're added back to the day's goal). Estimate calories from MET x kg x hours if the person doesn't give them.",
    inputSchema: {
      type: "object",
      properties: { person: PERSON, date: DATE, name: { type: "string" }, minutes: num("Minutes."), kcal: num("Calories burned."), note: { type: "string" } },
      required: ["person", "name", "minutes", "kcal"],
    },
  },
  {
    name: "lookup_usda",
    title: "Look up USDA FoodData Central",
    description: "Search USDA FoodData Central (Foundation and SR Legacy) for an ingredient. Returns up to 5 matches with nutrition per 100 g and links. Use cooked forms for cooked food, e.g. \"rice white cooked\".",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "lookup_open_food_facts",
    title: "Look up Open Food Facts",
    description: "Search the Open Food Facts database of packaged foods and drinks, by barcode (most exact) or product name and brand. Returns up to 5 products with nutrition per 100 g/ml and per serving, and links.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: { barcode: { type: "string" }, query: { type: "string" } } },
  },
];

// ---------------------------------------------------------------- diary helpers

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

class ToolError extends Error {}

function dayOf(value) {
  const d = value ? str(value, 10) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ToolError("date must be YYYY-MM-DD");
  return d;
}

function personOf(doc, name) {
  const n = str(name, 30).toLowerCase();
  const p = doc.people.find((x) => x.toLowerCase() === n) ?? doc.people.find((x) => n && (x.toLowerCase().startsWith(n) || n.startsWith(x.toLowerCase())));
  if (!p) throw new ToolError(`Unknown person. Use one of: ${doc.people.join(", ")}`);
  return p;
}

async function readDoc() {
  const stored = await liveStore().get(FITNESS_KEY, { type: "json" });
  return stored ? normalize(stored) : defaultDoc();
}

// Same goals as the page (public/fitness/fitness.js targets()).
function targets(doc, p, d) {
  const pr = doc.profiles[p] ?? {};
  const w = doc.weights.filter((x) => x.person === p && x.date <= d).sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.kg;
  const age = pr.birthYear ? new Date().getFullYear() - pr.birthYear : null;
  let calc = null;
  if (w && pr.heightCm && age) {
    const bmr = 10 * w + 6.25 * pr.heightCm - 5 * age + (pr.sex === "male" ? 5 : pr.sex === "female" ? -161 : -78);
    const tdee = bmr * (ACTIVITY[pr.activity] ?? 1.375);
    calc = Math.max(pr.sex === "male" ? 1500 : 1200, Math.round((tdee + ((pr.weeklyKg ?? 0) * 7700) / 7) / 10) * 10);
  }
  const kcal = pr.kcalTarget || calc || 2000;
  const m = pr.macros ?? { p: 30, c: 40, f: 30 };
  return { kcal, protein_g: Math.round((kcal * m.p) / 400), carbs_g: Math.round((kcal * m.c) / 400), fat_g: Math.round((kcal * m.f) / 900), personalised: !!(pr.kcalTarget || calc) };
}

const r1 = (v) => Math.round(v * 10) / 10;
const total = (list, k) => r1(list.reduce((s, x) => s + (Number(x[k]) || 0), 0));

function diary(doc, p, d) {
  const foods = doc.foods.filter((f) => f.person === p && f.date === d);
  const ex = doc.exercises.filter((x) => x.person === p && x.date === d);
  const goal = targets(doc, p, d);
  const eaten = { kcal: total(foods, "kcal"), protein_g: total(foods, "p"), carbs_g: total(foods, "c"), fat_g: total(foods, "f") };
  const burned = total(ex, "kcal");
  const latest = doc.weights.filter((w) => w.person === p).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return {
    person: p,
    date: d,
    goal,
    eaten,
    exercise_kcal: burned,
    remaining: {
      kcal: Math.round(goal.kcal - eaten.kcal + burned),
      protein_g: r1(goal.protein_g - eaten.protein_g), carbs_g: r1(goal.carbs_g - eaten.carbs_g), fat_g: r1(goal.fat_g - eaten.fat_g),
    },
    meals: Object.fromEntries(MEALS.map((m) => [m, foods.filter((f) => f.meal === m).map((f) => ({
      id: f.id, name: f.name, amount: f.amount, grams: f.grams, kcal: f.kcal, protein_g: f.p, carbs_g: f.c, fat_g: f.f,
    }))])),
    exercise: ex.map((x) => ({ id: x.id, name: x.name, minutes: x.minutes, kcal: x.kcal })),
    weight_kg: latest?.kg ?? null,
    goal_weight_kg: doc.profiles[p]?.goalKg ?? null,
    app: "https://japan-trip-budget.netlify.app/fitness/",
  };
}

// Applies one diary change as the page would, signed "Claude".
async function change(body) {
  const doc = await updateDoc({ key: FITNESS_KEY, defaultDoc, normalize, by: "Claude", mutate: (d) => applyOp(d, body, "Claude") })
    .catch((err) => {
      throw err.status ? new ToolError(err.message) : err; // fail() from applyOp: a message for Claude
    });
  if (!doc) throw new ToolError("The diary is busy, try again.");
  return doc;
}

const foodFromTool = (f) => ({
  name: f.name, amount: f.amount ?? "", grams: f.grams, kcal: Math.round(Number(f.kcal) || 0),
  p: f.protein_g ?? 0, c: f.carbs_g ?? 0, f: f.fat_g ?? 0,
  fiber: f.fiber_g, sugar: f.sugar_g, sodium: f.sodium_mg,
  ref: f.source_url, refName: f.source, source: "claude",
  ingredients: (f.ingredients ?? []).map((g) => ({
    name: g.name, grams: g.grams, kcal: g.kcal, p: g.protein_g ?? 0, c: g.carbs_g ?? 0, f: g.fat_g ?? 0, url: g.source_url, source: g.source,
  })),
});

async function lookup(source, run) {
  try {
    return JSON.parse(await run());
  } catch (err) {
    throw new ToolError(`Couldn't search ${source} (${err.message}). Use another source or web search instead.`);
  }
}

async function callTool(name, args = {}) {
  switch (name) {
    case "get_food_diary": {
      const doc = await readDoc();
      return diary(doc, personOf(doc, args.person), dayOf(args.date));
    }
    case "log_food": {
      const pre = await readDoc();
      const p = personOf(pre, args.person);
      const d = dayOf(args.date);
      const before = new Set(pre.foods.map((f) => f.id));
      const doc = await change({ op: "addFoods", person: p, date: d, meal: args.meal, foods: (args.foods ?? []).map(foodFromTool) });
      const added = doc.foods.filter((f) => !before.has(f.id) && f.person === p && f.date === d && f.meal === args.meal);
      return { logged: added.map((f) => ({ id: f.id, name: f.name, kcal: f.kcal })), day: diary(doc, p, d) };
    }
    case "delete_food": {
      const pre = await readDoc();
      const f = pre.foods.find((x) => x.id === args.id);
      if (!f) throw new ToolError("No food with that id");
      const doc = await change({ op: "deleteFood", id: f.id });
      return { deleted: f.name, day: diary(doc, f.person, f.date) };
    }
    case "log_weight": {
      const pre = await readDoc();
      const p = personOf(pre, args.person);
      const doc = await change({ op: "addWeight", person: p, date: dayOf(args.date), kg: args.kg });
      return { saved: true, weight_kg: Number(args.kg), goal_weight_kg: doc.profiles[p]?.goalKg ?? null };
    }
    case "log_exercise": {
      const pre = await readDoc();
      const p = personOf(pre, args.person);
      const d = dayOf(args.date);
      const doc = await change({ op: "addExercise", person: p, date: d, name: args.name, minutes: args.minutes, kcal: Math.round(Number(args.kcal) || 0), note: args.note ?? "" });
      return { saved: true, day: diary(doc, p, d) };
    }
    case "lookup_usda":
      return lookup("USDA FoodData Central", () => lookupUsda(args));
    case "lookup_open_food_facts":
      return lookup("Open Food Facts", () => lookupFood({ barcode: args.barcode ?? "", query: args.query ?? "" }));
    default:
      throw new ToolError(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC over HTTP

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return null; // a notification: nothing to answer
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      try {
        const out = await callTool(params?.name, params?.arguments);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
      } catch (err) {
        if (!(err instanceof ToolError)) console.error("Tool failed:", params?.name, err);
        const text = err instanceof ToolError ? err.message : `Something went wrong: ${err.message}`;
        return rpcResult(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default async (req, context) => {
  const key = process.env.FITNESS_MCP_KEY;
  if (!key || key.length < 16 || !sameSecret(context.params?.key, key)) return new Response("Not found", { status: 404 });
  if (req.method === "GET" || req.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(body);
  const answers = (await Promise.all((batch ? body : [body]).map(handle))).filter(Boolean);
  if (!answers.length) return new Response(null, { status: 202 });
  return json(batch ? answers : answers[0]);
};

export const config = { path: "/mcp/:key" };
