// Sums shared by the apps and the home page, so they always agree:
// who owes whom in everyday expenses, and daily calorie and macro goals.

// ---------------------------------------------------------------- everyday expenses (/daily/)

// A personal expense paid with someone else's card: { from, to, card }, else null.
export function borrowedOf(doc, item) {
  const card = item.kind === "personal" && item.card && doc.cards?.find((c) => c.id === item.card);
  return card && card.owner !== item.owner ? { from: item.owner, to: card.owner, card } : null;
}

// Who owes whom over all time, from shared expenses, borrowed cards and payments back:
// the fewest transfers [{ from, to, a: cents }] that even it out.
export function settleUp(doc) {
  const net = Object.fromEntries(doc.people.map((p) => [p, 0])); // positive = is owed money
  for (const i of doc.items) {
    const b = borrowedOf(doc, i);
    if (b && b.from in net && b.to in net) {
      net[b.to] += i.a;
      net[b.from] -= i.a;
    }
  }
  for (const i of doc.items.filter((x) => x.kind === "shared")) {
    if (i.paidBy in net) net[i.paidBy] += i.a;
    for (const [p, f] of Object.entries(i.shares ?? {})) if (p in net) net[p] -= i.a * f;
  }
  for (const s of doc.settlements) {
    if (s.from in net) net[s.from] += s.a;
    if (s.to in net) net[s.to] -= s.a;
  }
  // Largest debtor pays largest creditor, repeat.
  const owe = Object.entries(net).map(([p, v]) => ({ p, v: Math.round(v) }));
  const transfers = [];
  for (let guard = 0; guard < 20; guard++) {
    owe.sort((a, b) => a.v - b.v);
    const debtor = owe[0], creditor = owe[owe.length - 1];
    if (!debtor || debtor.v > -1 || creditor.v < 1) break;
    const a = Math.min(-debtor.v, creditor.v);
    transfers.push({ from: debtor.p, to: creditor.p, a });
    debtor.v += a;
    creditor.v -= a;
  }
  return transfers;
}

// ---------------------------------------------------------------- food & fitness (/fitness/)

const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very: 1.9 };
const KCAL_PER_KG = 7700;

// Whether a person's exercise calories are added back to their daily goal (on unless they
// turned it off in Goals). Exercise is still logged and shown either way.
export const exerciseAddsBack = (doc, p) => doc.profiles?.[p]?.addExercise !== false;

// A person's weigh-ins, oldest first.
export function weighInsOf(doc, p) {
  return doc.weights.filter((w) => w.person === p).sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
}

export const latestWeightOf = (doc, p, onOrBefore = "9999") => weighInsOf(doc, p).filter((w) => w.date <= onOrBefore).at(-1) ?? null;

// Daily goals from the profile: Mifflin-St Jeor BMR x activity, plus the weekly goal, never
// below 1,200 kcal (women) or 1,500 (men); or the person's own calorie goal. 2,000 if unset.
export function fitnessTargets(doc, p, onDay) {
  const pr = doc.profiles[p] ?? {};
  const w = latestWeightOf(doc, p, onDay)?.kg ?? null;
  const age = pr.birthYear ? new Date().getFullYear() - pr.birthYear : null;
  let calc = null;
  if (w && pr.heightCm && age) {
    const bmr = 10 * w + 6.25 * pr.heightCm - 5 * age + (pr.sex === "male" ? 5 : pr.sex === "female" ? -161 : -78);
    const tdee = bmr * (ACTIVITY[pr.activity] ?? 1.375);
    const floor = pr.sex === "male" ? 1500 : 1200;
    calc = { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal: Math.max(floor, Math.round((tdee + ((pr.weeklyKg ?? 0) * KCAL_PER_KG) / 7) / 10) * 10), floor };
  }
  const kcal = pr.kcalTarget || calc?.kcal || 2000;
  return { ...macroGoals(pr, kcal), calc, set: !!(pr.kcalTarget || calc) };
}

function macroGoals(pr, kcal) {
  const m = pr.macros ?? { p: 30, c: 40, f: 30 };
  return { kcal, p: (kcal * m.p) / 100 / 4, c: (kcal * m.c) / 100 / 4, f: (kcal * m.f) / 100 / 9, pct: m };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekStart = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7)); // Monday
const r10 = (v) => Math.round(v / 10) * 10;

// The lowest daily goal a make-up will go to.
export const kcalFloor = (doc, p) => (doc.profiles?.[p]?.sex === "male" ? 1500 : 1200);

// Whether a person's goal drops on the following days to make up for going over (Goals).
export const makesUp = (doc, p) => doc.profiles?.[p]?.makeUp === true;

// Calories eaten on a day, minus exercise when the person adds it back.
function netKcal(doc, p, d) {
  const eaten = doc.foods.reduce((s, f) => s + (f.person === p && f.date === d ? f.kcal : 0), 0);
  const burned = exerciseAddsBack(doc, p) ? doc.exercises.reduce((s, x) => s + (x.person === p && x.date === d ? x.kcal : 0), 0) : 0;
  return { eaten, net: eaten - burned };
}

// kcal over the usual goal across [from, to), counting only days with food logged (days
// under make up for days over).
function surplusBetween(doc, p, from, to) {
  let s = 0;
  for (let d = from; d < to; d = addDays(d, 1)) {
    const { eaten, net } = netKcal(doc, p, d);
    if (eaten) s += net - fitnessTargets(doc, p, d).kcal;
  }
  return s;
}

// What's left over from last week to make up this week (only if the person makes up).
function carryInto(doc, p, start) {
  return makesUp(doc, p) ? Math.max(0, surplusBetween(doc, p, addDays(start, -7), start)) : 0;
}

// The day's goals. For someone who makes up, the usual goal minus their surplus so far this
// week (plus any carried over from last week) spread evenly over the days left, never below
// the floor.
//   base   the usual goal    cut  how much lower today's goal is    carry  from last week
export function dayTargets(doc, p, day) {
  const t = fitnessTargets(doc, p, day);
  if (!makesUp(doc, p)) return { ...t, base: t.kcal, cut: 0, carry: 0 };
  const start = weekStart(day);
  const carry = carryInto(doc, p, start);
  const before = carry + surplusBetween(doc, p, start, day);
  const daysLeft = 7 - Math.round((Date.parse(day) - Date.parse(start)) / 86400000);
  const kcal = before > 0 ? Math.max(kcalFloor(doc, p), r10(t.kcal - before / daysLeft)) : t.kcal;
  return { ...t, ...macroGoals(doc.profiles[p] ?? {}, kcal), base: t.kcal, cut: t.kcal - kcal, carry };
}

// How a person's week (Monday to Sunday) stands as of `day`. The budget is the usual goal x 7
// (less anything carried over from last week). Earlier days with food logged count fully;
// `day` counts only once it is over its goal, as it isn't finished yet.
//   goal      today's goal (lowered when making up)   base  the usual goal
//   over      kcal over today's goal (0 if not)
//   surplus   kcal over the week's budget so far (negative = under)
//   daysLeft  days still to come this week that can make up for it
//   perDay    the goal for each of those days that finishes the week on budget (not below the floor)
//   nextWeek  when nothing is left this week: how much lower each day next week will be (makers-up)
export function weekBalance(doc, p, day) {
  const start = weekStart(day);
  const t = dayTargets(doc, p, day);
  const dow = Math.round((Date.parse(day) - Date.parse(start)) / 86400000);
  const { net } = netKcal(doc, p, day);
  const over = Math.max(0, net - t.kcal);
  let surplus = carryInto(doc, p, start) + surplusBetween(doc, p, start, day);
  if (over) surplus += net - t.base;
  const daysLeft = over ? 6 - dow : 7 - dow; // today still counts while it isn't over
  const floor = kcalFloor(doc, p);
  const perDay = daysLeft ? Math.max(floor, r10(t.base - surplus / daysLeft)) : null;
  const nextWeek = !daysLeft && surplus > 0 && makesUp(doc, p) ? Math.min(t.base - floor, r10(surplus / 7)) : 0;
  return { goal: t.kcal, base: t.base, cut: t.cut, carry: t.carry, weekly: t.base * 7, start, end: addDays(start, 6), over, surplus, daysLeft, perDay, floor, nextWeek, makeUp: makesUp(doc, p) };
}

// The reminder for weekBalance(), or null when there's nothing to say. `when` is "today" or
// a day's name.
export function weekNote(w, when = "today") {
  const n = (v) => Math.round(v).toLocaleString("en-US");
  const span = w.daysLeft === 1 ? "tomorrow" : `for the next ${w.daysLeft} days`;
  const atFloor = w.perDay === w.floor ? ` (the lowest it goes; the rest stays over)` : "";
  if (w.over) {
    const head = `${n(w.over)} kcal over ${when}'s ${n(w.goal)} kcal goal.`;
    if (w.surplus <= 0) return `${head} This week is still ${n(-w.surplus)} kcal under its budget, so no need to cut back.`;
    const week = w.surplus !== w.over ? ` That's ${n(w.surplus)} kcal over for the week so far.` : "";
    if (!w.daysLeft) {
      return w.makeUp
        ? `${head}${week} It carries into next week: your goal will be about ${n(w.nextWeek)} kcal lower each day (${n(w.base - w.nextWeek)} kcal).`
        : `${head} That ends the week ${n(w.surplus)} kcal over its budget.`;
    }
    return w.makeUp
      ? `${head}${week} To make up for it, your goal drops to about ${n(w.perDay)} kcal ${span}${atFloor}.`
      : `${head}${week} To keep to ${n(w.base)} a day (${n(w.weekly)} kcal this week), aim for about ${n(w.perDay)} kcal ${span}${atFloor}.`;
  }
  if (w.makeUp && w.cut > 0) {
    const why = w.carry > 0 && w.carry >= w.surplus ? "going over last week" : "going over earlier this week";
    return `🎯 ${when === "today" ? "Today's" : `${when}'s`} goal is ${n(w.goal)} kcal, ${n(w.cut)} below your usual ${n(w.base)}, to make up for ${why}${w.goal === w.floor ? " (the lowest it goes)" : ""}.`;
  }
  if (!w.makeUp && w.surplus > 0 && w.daysLeft) {
    return `This week is ${n(w.surplus)} kcal over its budget so far. To keep to ${n(w.base)} a day (${n(w.weekly)} kcal this week), aim for about ${n(w.perDay)} kcal ${w.daysLeft === 1 ? "today" : "a day for the rest of the week"}${atFloor}.`;
  }
  return null;
}
