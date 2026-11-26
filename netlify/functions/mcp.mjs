// Connector for the Claude app: an MCP server (Streamable HTTP, stateless JSON responses)
// at /mcp/<FITNESS_MCP_KEY>. Added to Claude as a custom connector, it lets Claude read
// and log to the food & fitness diary (food, weight, exercise), the toilet log and the
// everyday expenses, e.g. after you send it a photo of a meal:
// Claude works out the ingredients and their weights, looks them up (USDA FoodData
// Central, Open Food Facts, the web) and logs the result here, where the app shows it.
//
// The secret in the URL is the only key, so it's off until FITNESS_MCP_KEY is set on
// Netlify, and the URL should be kept private like a password.

import { timingSafeEqual } from "node:crypto";
import { json, str, updateDoc, liveStore } from "../lib/shared-doc.mjs";
import { lookupFood, lookupUsda } from "../lib/food-lookup.mjs";
import { notifyChange } from "../lib/notify.mjs";
import { FITNESS_KEY, MEALS, applyOp, defaultDoc, normalize } from "./fitness.mjs";
import { DAILY_KEY, applyOp as applyDailyOp, defaultDoc as defaultDailyDoc, normalize as normalizeDaily } from "./daily.mjs";
import { dayTargets, weekBalance, weekNote } from "../../public/calc.js";

const SERVER = { name: "our-food-diary", version: "1.1.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TZ = "Asia/Singapore";

const INSTRUCTIONS = `Karstin and Lilin's food & fitness diary (calories, macros, weight, exercise), shown in their app at https://japan-trip-budget.netlify.app/fitness/.
When someone sends a photo or description of food to log:
0. Check find_saved_foods first: their saved foods and home recipes have exact numbers per portion.
1. Identify each dish and break it into ingredients. Estimate each ingredient's weight in grams from the photo's scale cues (a dinner plate is ~26 cm, a hawker plate ~23 cm, a rice bowl ~250 ml, a dessert spoon ~15 cm), counting pieces where you can, and include cooking oil and sauces.
2. Look up nutrition per 100 g and scale it to each weight: lookup_usda for whole foods and cooked staples; lookup_open_food_facts for packaged products (by barcode if visible); web search for restaurant and chain items (the brand's published nutrition facts) and local dishes (e.g. Singapore HPB). A dish's totals are the sum of its ingredients.
3. Show the person the breakdown (ingredients, grams, kcal, protein, carbs, fat, sources) and the totals, then log it with log_food to the right person, meal and date. If whose diary or which meal isn't clear, ask or infer from the time of day (Singapore time). Mention calories left for the day from the result.
Use get_food_diary to answer questions about the day, goals and what's left. Use delete_food to fix a mistake. When they ask to add a food or recipe to the database (without saying they ate it), use save_food.

The same connector also logs the rest of their day:
- Weight: log_weight. Exercise: log_exercise (estimate calories burned if not given); delete_exercise to fix a mistake.
- Toilet log (https://japan-trip-budget.netlify.app/toilet/): log_poop with the Bristol stool type 1-7 (1 hard lumps, 2 lumpy sausage, 3 cracked sausage, 4 smooth soft sausage, 5 soft blobs, 6 mushy, 7 watery). If they don't say the type, ask, or use 4 for "normal". The time defaults to now. get_toilet_log and delete_poop to read and fix.
- Everyday expenses in SGD (https://japan-trip-budget.netlify.app/daily/): call get_expenses first for the categories and cards, then log_expense. Personal expenses belong to one person; shared ones are split (equally unless told otherwise) and record who paid. Pick the category that fits; set the card only when they say which card or account paid. A receipt photo works too: read the total, shop and date from it. delete_expense to fix a mistake.
If it isn't clear whose entry it is, ask.`;

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
    description: "Record exercise and the calories it burned (added back to the day's goal unless the person turned that off; see exercise_added_to_goal). Estimate calories from MET x kg x hours if the person doesn't give them.",
    inputSchema: {
      type: "object",
      properties: { person: PERSON, date: DATE, name: { type: "string" }, minutes: num("Minutes."), kcal: num("Calories burned."), note: { type: "string" } },
      required: ["person", "name", "minutes", "kcal"],
    },
  },
  {
    name: "delete_exercise",
    title: "Delete logged exercise",
    description: "Remove an exercise entry by its id (from get_food_diary or log_exercise).",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "log_poop",
    title: "Log a toilet visit",
    description: "Record a bowel movement in a person's toilet log, with its type on the Bristol stool scale.",
    inputSchema: {
      type: "object",
      required: ["person", "type"],
      properties: {
        person: PERSON,
        date: DATE,
        time: { type: "string", description: "Time as HH:MM (24-hour, Singapore). Defaults to now when the date is today." },
        type: { type: "integer", minimum: 1, maximum: 7, description: "Bristol stool scale: 1 separate hard lumps, 2 lumpy sausage, 3 sausage with cracks, 4 smooth soft sausage, 5 soft blobs, 6 mushy ragged pieces, 7 watery." },
        note: { type: "string", description: "Optional note, e.g. \"after coffee\"." },
      },
    },
  },
  {
    name: "get_toilet_log",
    title: "Read the toilet log",
    description: "A person's toilet visits (with ids) for the last few days, newest first, with a count per day.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { person: PERSON, days: num("How many days back, including today (default 7).") }, required: ["person"] },
  },
  {
    name: "delete_poop",
    title: "Delete a toilet entry",
    description: "Remove a toilet log entry by its id (from get_toilet_log or log_poop).",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_expenses",
    title: "Read everyday expenses",
    description: "The everyday expense tracker (SGD): the people, expense categories and cards/accounts to log against, and the expenses between two dates (with ids), with totals per person and category.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD. Defaults to the 1st of this month." },
        to: { type: "string", description: "Last day, YYYY-MM-DD. Defaults to today." },
        person: { type: "string", description: "Only this person's personal expenses and shared ones (leave out for everyone)." },
      },
    },
  },
  {
    name: "log_expense",
    title: "Log an expense",
    description: "Add an expense to the everyday expense tracker. Personal: give owner. Shared: give paid_by (or a card, whose owner paid) and optionally split.",
    inputSchema: {
      type: "object",
      required: ["kind", "amount", "category"],
      properties: {
        kind: { type: "string", enum: ["personal", "shared"] },
        amount: num("Amount in SGD dollars, e.g. 12.5."),
        category: { type: "string", description: "Category id or name from get_expenses, e.g. food, groceries, transport." },
        date: DATE,
        note: { type: "string", description: "What it was, e.g. \"Ya Kun breakfast\" (max 80 characters)." },
        owner: { type: "string", description: "Personal: whose expense (Karstin or Lilin)." },
        paid_by: { type: "string", description: "Shared: who paid." },
        split: { type: "object", additionalProperties: { type: "number" }, description: "Shared: each person's share, e.g. {\"Karstin\": 0.5, \"Lilin\": 0.5}. Defaults to equal." },
        card: { type: "string", description: "Card or account name (or id) from get_expenses that paid, if they said." },
      },
    },
  },
  {
    name: "delete_expense",
    title: "Delete an expense",
    description: "Remove an expense by its id (from get_expenses or log_expense).",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "find_saved_foods",
    title: "Find saved foods",
    description: "Search the foods and recipes Karstin and Lilin saved (shared by both), with nutrition per portion. Check here first for home recipes and foods they eat often, then log with log_food using these numbers (scaled to the amount eaten).",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Part of the name; leave out to list all." } } },
  },
  {
    name: "save_food",
    title: "Save a food or recipe",
    description: "Save a food or home recipe to the shared saved foods, so it can be added to either diary in one tap. Give the nutrition for one portion (say what a portion is in amount); for a recipe, list the ingredients for one portion and put the full recipe (quantities for the whole batch, servings, method) in recipe. Doesn't log it to a diary.",
    inputSchema: {
      type: "object",
      required: ["name", "kcal", "protein_g", "carbs_g", "fat_g"],
      properties: {
        name: { type: "string" }, amount: { type: "string", description: "What one portion is, e.g. \"1 serving (8 g)\"." },
        grams: num("Weight of one portion in grams."), kcal: num("Calories per portion."),
        protein_g: num("g"), carbs_g: num("g"), fat_g: num("g"), fiber_g: num("g"), sugar_g: num("g"), sodium_mg: num("mg"),
        source: { type: "string" }, source_url: { type: "string" },
        recipe: { type: "string", description: "Whole-batch recipe and notes." },
        ingredients: { type: "array", items: { type: "object", required: ["name", "grams", "kcal"], properties: { name: { type: "string" }, grams: num("g"), kcal: num("kcal"), protein_g: num("g"), carbs_g: num("g"), fat_g: num("g"), source: { type: "string" }, source_url: { type: "string" } } } },
      },
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

// Same goals as the page (public/calc.js dayTargets(): lowered while making up for going over).
function targets(doc, p, d) {
  const t = dayTargets(doc, p, d);
  return {
    kcal: t.kcal, protein_g: Math.round(t.p), carbs_g: Math.round(t.c), fat_g: Math.round(t.f), personalised: t.set,
    ...(t.cut ? { usual_kcal: t.base, lowered_by_kcal: t.cut, why: "making up for going over earlier" } : {}),
  };
}

const r1 = (v) => Math.round(v * 10) / 10;
const total = (list, k) => r1(list.reduce((s, x) => s + (Number(x[k]) || 0), 0));

function diary(doc, p, d) {
  const foods = doc.foods.filter((f) => f.person === p && f.date === d);
  const ex = doc.exercises.filter((x) => x.person === p && x.date === d);
  const goal = targets(doc, p, d);
  const eaten = { kcal: total(foods, "kcal"), protein_g: total(foods, "p"), carbs_g: total(foods, "c"), fat_g: total(foods, "f") };
  const burned = total(ex, "kcal");
  const addsBack = doc.profiles[p]?.addExercise !== false;
  const latest = doc.weights.filter((w) => w.person === p).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  return {
    person: p,
    date: d,
    goal,
    eaten,
    exercise_kcal: burned,
    exercise_added_to_goal: addsBack,
    remaining: {
      kcal: Math.round(goal.kcal - eaten.kcal + (addsBack ? burned : 0)),
      protein_g: r1(goal.protein_g - eaten.protein_g), carbs_g: r1(goal.carbs_g - eaten.carbs_g), fat_g: r1(goal.fat_g - eaten.fat_g),
    },
    meals: Object.fromEntries(MEALS.map((m) => [m, foods.filter((f) => f.meal === m).map((f) => ({
      id: f.id, name: f.name, amount: f.amount, grams: f.grams, kcal: f.kcal, protein_g: f.p, carbs_g: f.c, fat_g: f.f,
    }))])),
    exercise: ex.map((x) => ({ id: x.id, name: x.name, minutes: x.minutes, kcal: x.kcal })),
    week: (() => {
      const w = weekBalance(doc, p, d);
      return { from: w.start, to: w.end, budget_kcal: w.weekly, over_budget_kcal: Math.round(w.surplus), aim_kcal_per_day_for_rest_of_week: w.surplus > 0 ? w.perDay : null, reminder: weekNote(w, new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })) };
    })(),
    weight_kg: latest?.kg ?? null,
    goal_weight_kg: doc.profiles[p]?.goalKg ?? null,
    app: "https://japan-trip-budget.netlify.app/fitness/",
  };
}

// Applies one diary change as the page would, signed "Claude".
async function change(body) {
  return changeDoc({ key: FITNESS_KEY, defaultDoc, normalize, applyOp }, body);
}

const EXPENSES = { key: DAILY_KEY, defaultDoc: defaultDailyDoc, normalize: normalizeDaily, applyOp: applyDailyOp };

async function changeDoc({ key, defaultDoc, normalize, applyOp }, body) {
  const doc = await updateDoc({ key, defaultDoc, normalize, by: "Claude", mutate: (d) => applyOp(d, body, "Claude") })
    .catch((err) => {
      throw err.status ? new ToolError(err.message) : err; // fail() from applyOp: a message for Claude
    });
  if (!doc) throw new ToolError("The app is busy, try again.");
  await notifyChange(key, body, "Claude", doc);
  return doc;
}

async function readExpenses() {
  const stored = await liveStore().get(DAILY_KEY, { type: "json" });
  return stored ? normalizeDaily(stored) : defaultDailyDoc();
}

const nowTime = () => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const BRISTOL = ["", "separate hard lumps", "lumpy sausage", "sausage with cracks", "smooth soft sausage", "soft blobs", "mushy ragged pieces", "watery"];
const dollars = (cents) => Math.round(cents) / 100;

function poopOut(x) {
  return { id: x.id, date: x.date, time: x.time || null, type: x.type, looks_like: BRISTOL[x.type], note: x.note || undefined };
}

function toiletLog(doc, p, days) {
  const to = today();
  const from = shiftDay(to, -(Math.min(Math.max(Math.round(Number(days) || 7), 1), 90) - 1));
  const list = (doc.toilet ?? []).filter((x) => x.person === p && x.date >= from && x.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.time || "").localeCompare(a.time || "") || b.t - a.t);
  const perDay = {};
  for (const x of list) perDay[x.date] = (perDay[x.date] ?? 0) + 1;
  return { person: p, from, to, visits: list.length, per_day: perDay, entries: list.map(poopOut), app: "https://japan-trip-budget.netlify.app/toilet/" };
}

function categoryOf(doc, value) {
  const v = str(value, 40).toLowerCase();
  const cat = doc.categories.find((c) => c.id === v) ?? doc.categories.find((c) => c.name.toLowerCase() === v) ??
    doc.categories.find((c) => v && (c.name.toLowerCase().includes(v) || c.id.includes(v)));
  if (!cat) throw new ToolError(`Unknown category. Use one of: ${doc.categories.map((c) => `${c.id} (${c.name})`).join(", ")}`);
  return cat;
}

function cardOf(doc, value, owner) {
  if (!value) return null;
  const v = str(value, 80).toLowerCase();
  const byId = doc.cards.find((c) => c.id === value);
  if (byId) return byId;
  const matches = doc.cards.filter((c) => c.name.toLowerCase() === v).concat(doc.cards.filter((c) => c.name.toLowerCase().includes(v) && c.name.toLowerCase() !== v));
  const card = matches.find((c) => c.owner === owner) ?? matches[0];
  if (!card) throw new ToolError(`Unknown card. Use one of: ${doc.cards.map((c) => `${c.owner}'s ${c.name}`).join(", ") || "(no cards set up; leave card out)"}`);
  return card;
}

function expenseOut(doc, i) {
  const cat = doc.categories.find((c) => c.id === i.cat);
  const card = i.card && doc.cards.find((c) => c.id === i.card);
  return {
    id: i.id, date: i.date, kind: i.kind, amount_sgd: dollars(i.a), category: cat ? `${cat.emoji} ${cat.name}` : i.cat, note: i.note || undefined,
    ...(i.kind === "personal" ? { owner: i.owner } : { paid_by: i.paidBy, split: i.shares }),
    ...(card ? { card: `${card.owner}'s ${card.name}` } : {}),
  };
}

function expenses(doc, { from, to, person }) {
  const end = to ? dayOf(to) : today();
  const start = from ? dayOf(from) : `${end.slice(0, 8)}01`;
  const items = doc.items.filter((i) => i.date >= start && i.date <= end &&
    (!person || (i.kind === "shared" ? true : i.owner === person)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.t - a.t);
  // Each person's spending: their personal expenses plus their share of shared ones.
  const spent = Object.fromEntries(doc.people.map((p) => [p, 0]));
  const byCat = {};
  for (const i of items) {
    const cat = doc.categories.find((c) => c.id === i.cat)?.name ?? i.cat;
    byCat[cat] = (byCat[cat] ?? 0) + i.a;
    if (i.kind === "personal") spent[i.owner] = (spent[i.owner] ?? 0) + i.a;
    else for (const [p, f] of Object.entries(i.shares ?? {})) spent[p] = (spent[p] ?? 0) + i.a * f;
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dollars(v)]));
  return {
    from: start, to: end, currency: "SGD",
    people: doc.people,
    categories: doc.categories.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji })),
    cards: doc.cards.map((c) => ({ id: c.id, name: c.name, owner: c.owner, kind: c.kind ?? "card", for_categories: c.cats })),
    total_sgd: dollars(items.reduce((s, i) => s + i.a, 0)),
    spent_per_person_sgd: round(person ? { [person]: spent[person] ?? 0 } : spent),
    per_category_sgd: round(byCat),
    expenses: items.slice(0, 200).map((i) => expenseOut(doc, i)),
    ...(items.length > 200 ? { note: `Showing the latest 200 of ${items.length}; ask for a shorter range.` } : {}),
    app: "https://japan-trip-budget.netlify.app/daily/",
  };
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
    case "delete_exercise": {
      const pre = await readDoc();
      const x = pre.exercises.find((e) => e.id === args.id);
      if (!x) throw new ToolError("No exercise with that id");
      const doc = await change({ op: "deleteExercise", id: x.id });
      return { deleted: x.name, day: diary(doc, x.person, x.date) };
    }
    case "log_poop": {
      const pre = await readDoc();
      const p = personOf(pre, args.person);
      const d = dayOf(args.date);
      if (![1, 2, 3, 4, 5, 6, 7].includes(Number(args.type))) throw new ToolError("type must be 1-7 on the Bristol stool scale");
      const time = args.time ? str(args.time, 5).padStart(5, "0") : d === today() ? nowTime() : "";
      const before = new Set((pre.toilet ?? []).map((x) => x.id));
      const doc = await change({ op: "addBowel", person: p, date: d, time, type: args.type, note: args.note ?? "" });
      const added = doc.toilet.find((x) => !before.has(x.id) && x.person === p && x.date === d);
      return { logged: added ? poopOut(added) : true, today: d === today() ? doc.toilet.filter((x) => x.person === p && x.date === d).length : undefined, recent: toiletLog(doc, p, 7).per_day };
    }
    case "get_toilet_log": {
      const doc = await readDoc();
      return toiletLog(doc, personOf(doc, args.person), args.days);
    }
    case "delete_poop": {
      const pre = await readDoc();
      const x = (pre.toilet ?? []).find((e) => e.id === args.id);
      if (!x) throw new ToolError("No toilet entry with that id");
      await change({ op: "deleteBowel", id: x.id });
      return { deleted: poopOut(x), person: x.person };
    }
    case "get_expenses": {
      const doc = await readExpenses();
      return expenses(doc, { from: args.from, to: args.to, person: args.person ? personOf(doc, args.person) : null });
    }
    case "log_expense": {
      const pre = await readExpenses();
      const kind = args.kind === "shared" ? "shared" : "personal";
      const cat = categoryOf(pre, args.category);
      const amount = Number(args.amount);
      if (!(amount > 0)) throw new ToolError("amount must be more than 0 (SGD dollars)");
      const owner = kind === "personal" ? personOf(pre, args.owner) : null;
      const paidBy = kind === "shared" && args.paid_by ? personOf(pre, args.paid_by) : null;
      const card = cardOf(pre, args.card, owner ?? paidBy);
      if (kind === "shared" && !paidBy && !card) throw new ToolError("For a shared expense, say who paid (paid_by) or which card.");
      let shares;
      if (kind === "shared" && args.split && typeof args.split === "object") {
        shares = {};
        for (const [name, f] of Object.entries(args.split)) shares[personOf(pre, name)] = Number(f);
      }
      const body = {
        op: "addItem", kind, date: dayOf(args.date), cat: cat.id, a: Math.round(amount * 100), note: args.note ?? "",
        ...(owner ? { owner } : {}), ...(paidBy ? { paidBy } : {}), ...(shares ? { shares } : {}), ...(card ? { card: card.id } : {}),
      };
      const before = new Set(pre.items.map((i) => i.id));
      const doc = await changeDoc(EXPENSES, body);
      const added = doc.items.find((i) => !before.has(i.id));
      const month = expenses(doc, { from: `${body.date.slice(0, 8)}01`, to: body.date, person: owner ?? undefined });
      return {
        logged: added ? expenseOut(doc, added) : true,
        ...(card && owner && card.owner !== owner ? { heads_up: `${card.owner}'s card paid, so ${owner} owes ${card.owner} for it.` } : {}),
        month_so_far: { from: month.from, to: month.to, spent_per_person_sgd: month.spent_per_person_sgd, per_category_sgd: month.per_category_sgd },
      };
    }
    case "delete_expense": {
      const pre = await readExpenses();
      const i = pre.items.find((x) => x.id === args.id);
      if (!i) throw new ToolError("No expense with that id");
      await changeDoc(EXPENSES, { op: "deleteItem", id: i.id });
      return { deleted: expenseOut(pre, i) };
    }
    case "find_saved_foods": {
      const doc = await readDoc();
      const q = String(args.query ?? "").toLowerCase().trim();
      return (doc.library ?? []).filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) => ({
        name: f.name, amount: f.amount, grams: f.grams, kcal: f.kcal, protein_g: f.p, carbs_g: f.c, fat_g: f.f,
        fiber_g: f.fiber, sugar_g: f.sugar, sodium_mg: f.sodium, recipe: f.recipe,
        ingredients: f.ingredients?.map((g) => ({ name: g.name, grams: g.grams, kcal: g.kcal, protein_g: g.p, carbs_g: g.c, fat_g: g.f })),
      }));
    }
    case "save_food": {
      const food = foodFromTool(args);
      delete food.source;
      await change({ op: "saveLibraryFood", ...food, recipe: args.recipe ?? "" });
      return { saved: args.name };
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
