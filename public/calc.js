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
  const m = pr.macros ?? { p: 30, c: 40, f: 30 };
  return {
    kcal, calc, set: !!(pr.kcalTarget || calc),
    p: (kcal * m.p) / 100 / 4, c: (kcal * m.c) / 100 / 4, f: (kcal * m.f) / 100 / 9, pct: m,
  };
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Calories eaten on a day, minus exercise when the person adds it back.
function netKcal(doc, p, d) {
  const eaten = doc.foods.reduce((s, f) => s + (f.person === p && f.date === d ? f.kcal : 0), 0);
  const burned = exerciseAddsBack(doc, p) ? doc.exercises.reduce((s, x) => s + (x.person === p && x.date === d ? x.kcal : 0), 0) : 0;
  return { eaten, net: eaten - burned };
}

// How a person's week (Monday to Sunday) stands against their daily goal x 7, as of `day`.
// Earlier days with food logged count fully (over or under); `day` itself counts only once it
// is over, as it isn't finished yet. Days with nothing logged are left out.
//   over      kcal over the goal on `day` (0 if not over)
//   surplus   kcal over the week's budget so far (negative = under)
//   daysLeft  days still to come this week that can make up for it
//   perDay    what to aim for on each of those days to finish the week on budget
export function weekBalance(doc, p, day) {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const start = addDays(day, -dow);
  const goal = fitnessTargets(doc, p, day).kcal;
  let surplus = 0;
  for (let i = 0; i < dow; i++) {
    const d = addDays(start, i);
    const { eaten, net } = netKcal(doc, p, d);
    if (eaten) surplus += net - fitnessTargets(doc, p, d).kcal;
  }
  const over = Math.max(0, netKcal(doc, p, day).net - goal);
  surplus += over;
  const daysLeft = over ? 6 - dow : 7 - dow; // today still counts while it isn't over
  const perDay = daysLeft ? Math.round((goal - surplus / daysLeft) / 10) * 10 : null;
  return { goal, weekly: goal * 7, start, end: addDays(start, 6), over, surplus, daysLeft, perDay };
}

// The reminder for weekBalance(): "350 kcal over on today. To keep this week at 2,300 a day…".
// Null when there's nothing to say. `when` is "today" or a day's name.
export function weekNote(w, when = "today") {
  const n = (v) => Math.round(v).toLocaleString("en-US");
  const budget = `${n(w.goal)} a day (${n(w.weekly)} kcal this week)`;
  const aim = (incToday) => w.daysLeft === 1 ? (incToday ? "today" : "tomorrow")
    : `a day for the ${incToday ? "rest of the week" : `next ${w.daysLeft} days`}`;
  if (w.over) {
    const head = `${n(w.over)} kcal over ${when}'s ${n(w.goal)} kcal.`;
    if (w.surplus <= 0) return `${head} This week is still ${n(-w.surplus)} kcal under its ${n(w.weekly)} kcal budget, so no need to cut back.`;
    const week = w.surplus !== w.over ? ` That's ${n(w.surplus)} kcal over for the week so far.` : "";
    if (!w.daysLeft) return `${head} That ends the week ${n(w.surplus)} kcal over its ${n(w.weekly)} kcal budget.`;
    return `${head}${week} To keep to ${budget}, aim for about ${n(w.perDay)} kcal ${aim(false)}.`;
  }
  if (w.surplus > 0 && w.daysLeft) {
    return `This week is ${n(w.surplus)} kcal over its budget so far. To keep to ${budget}, aim for about ${n(w.perDay)} kcal ${aim(true)}.`;
  }
  return null;
}
