// Insurance plans API: GET/POST /api/insurance (see netlify/lib/shared-doc.mjs).
//
// One shared document with Karstin and Lilin's insurance plans: what each covers, what it
// costs (monthly and yearly), how it's paid, the payment term and dates, and how long it
// covers. "Mark paid" moves a plan's next payment date on and keeps a short history.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";

export const INSURANCE_KEY = "insurance-v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PLANS = 100;

export const TYPES = ["hospital", "rider", "life-term", "life-whole", "ci", "eci", "pa", "disability", "ltc", "savings", "ilp", "annuity", "travel", "home", "car", "maid", "pet", "other"];
export const STATUSES = ["active", "pending", "lapsed", "cancelled", "matured"];
export const FREQUENCIES = { monthly: 1, quarterly: 3, "half-yearly": 6, yearly: 12, single: 0 };
const PAY_TERMS = ["years", "age", "whole-life", "single", "renewable", ""];
const COVER_UNTIL = ["date", "age", "lifetime", "renewable", ""];
const PAID_WITH = /^(giro|cash|medisave|cpf-oa|paynow|bank|other|card:[\w-]{1,60})?$/;

export function defaultDoc() {
  return { version: 0, schema: 1, updatedAt: Date.now(), people: ["Karstin", "Lilin"], plans: [], log: [] };
}

const normalize = (doc) => {
  doc.plans ??= [];
  return doc;
};

const date = (v, label) => {
  const d = str(v, 10);
  if (d && !DATE_RE.test(d)) fail(`Check the ${label}`);
  return d;
};
const cents = (v, label) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000_000) fail(`Check the ${label}`);
  return n;
};
const whole = (v, max, label) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > max) fail(`Check the ${label}`);
  return n;
};
function link(value) {
  try {
    const u = new URL(String(value ?? ""));
    return u.protocol === "https:" ? u.href.slice(0, 300) : "";
  } catch {
    return "";
  }
}

function readPlan(doc, b) {
  const name = str(b.name, 80);
  if (!name) fail("Give the plan a name");
  const person = b.person === "Joint" ? "Joint" : doc.people.find((p) => p.toLowerCase() === str(b.person, 30).toLowerCase());
  if (!person) fail("Pick whose plan this is");
  if (!TYPES.includes(b.type)) fail("Pick the type of plan");
  const frequency = b.frequency in FREQUENCIES ? b.frequency : "monthly";
  const payKind = PAY_TERMS.includes(b.payTerm?.kind) ? b.payTerm.kind : "";
  const coverKind = COVER_UNTIL.includes(b.coverUntil?.kind) ? b.coverUntil.kind : "";
  const paidWith = str(b.paidWith, 70);
  if (!PAID_WITH.test(paidWith)) fail("Pick how it's paid");
  return {
    name,
    insurer: str(b.insurer, 60),
    policyNo: str(b.policyNo, 40),
    person,
    type: b.type,
    status: STATUSES.includes(b.status) ? b.status : "active",
    monthly: cents(b.monthly, "monthly cost"),
    annual: cents(b.annual, "yearly cost"),
    frequency,
    paidWith,
    paidNote: str(b.paidNote, 80),
    payTerm: { kind: payKind, n: payKind === "years" || payKind === "age" ? whole(b.payTerm?.n, 120, "payment term") : null },
    nextDue: date(b.nextDue, "payment date"),
    start: date(b.start, "start date"),
    coverUntil: {
      kind: coverKind,
      value: coverKind === "date" ? date(b.coverUntil?.value, "cover end date") : coverKind === "age" ? whole(b.coverUntil?.value, 120, "cover age") : null,
    },
    sumAssured: cents(b.sumAssured, "sum assured"),
    covers: str(b.covers, 2000),
    description: str(b.description, 2000),
    notes: str(b.notes, 2000),
    agent: str(b.agent, 60),
    agentContact: str(b.agentContact, 80),
    link: link(b.link),
  };
}

// The payment date `months` after `iso` (keeping the day, or the month's last day).
export function addMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

// What one payment of the plan is, in cents (null if unknown).
export function paymentOf(plan) {
  const months = FREQUENCIES[plan.frequency] ?? 1;
  if (plan.frequency === "monthly") return plan.monthly ?? (plan.annual !== null ? Math.round(plan.annual / 12) : null);
  if (plan.frequency === "yearly" || plan.frequency === "single") return plan.annual ?? (plan.monthly !== null ? plan.monthly * 12 : null);
  if (plan.annual !== null) return Math.round((plan.annual * months) / 12);
  return plan.monthly !== null ? plan.monthly * months : null;
}

const money = (c) => `S$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function applyOp(doc, body, by) {
  switch (body.op) {
    case "savePlan": {
      const plan = readPlan(doc, body);
      const old = body.id && doc.plans.find((p) => p.id === body.id);
      const whose = plan.person === "Joint" ? "the joint" : `${plan.person}'s`;
      if (old) {
        Object.assign(old, plan, { editedBy: by, editedAt: Date.now() });
        return `updated ${whose} plan ${plan.name}`;
      }
      if (doc.plans.length >= MAX_PLANS) fail("Too many plans");
      doc.plans.push({ id: randomUUID(), ...plan, payments: [], by, t: Date.now() });
      return `added ${whose} plan ${plan.name}`;
    }

    case "deletePlan": {
      const plan = doc.plans.find((p) => p.id === body.id);
      if (!plan) return null;
      doc.plans = doc.plans.filter((p) => p !== plan);
      return `removed the plan ${plan.name}`;
    }

    case "markPaid": {
      const plan = doc.plans.find((p) => p.id === body.id);
      if (!plan) fail("This plan was removed by someone else", 409);
      if (!plan.nextDue) fail("Add the payment date first");
      const months = FREQUENCIES[plan.frequency] ?? 1;
      const amount = paymentOf(plan);
      plan.payments = [{ date: plan.nextDue, amount, by, t: Date.now() }, ...(plan.payments ?? [])].slice(0, 60);
      const paid = plan.nextDue;
      plan.nextDue = months ? addMonths(plan.nextDue, months) : "";
      return `marked ${plan.name}'s ${paid} payment${amount !== null ? ` of ${money(amount)}` : ""} as paid`;
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: INSURANCE_KEY,
  defaultDoc,
  normalize,
  applyOp,
  busyMessage: "The insurance list is busy, please try again.",
});

export const config = { path: "/api/insurance" };
