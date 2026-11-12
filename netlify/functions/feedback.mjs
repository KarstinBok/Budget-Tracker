// Feedback API: GET/POST /api/feedback (see netlify/lib/shared-doc.mjs).
//
// Problems and ideas either of us sends from ⚙️ Settings, so they can be gone through and
// fixed. Each has a status (open → planned → done, or won't do) and an optional reply.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";

export const FEEDBACK_KEY = "feedback-v1";
const KINDS = ["problem", "idea", "other"];
const AREAS = ["home", "expenses", "fitness", "toilet", "insurance", "japan", "settings", "other"];
const STATUSES = ["open", "planned", "done", "wontdo"];
const MAX_ITEMS = 2000;

function defaultDoc() {
  return { version: 0, schema: 1, updatedAt: Date.now(), items: [], log: [] };
}

const normalize = (doc) => {
  doc.items ??= [];
  return doc;
};

function applyOp(doc, body, by) {
  switch (body.op) {
    case "addFeedback": {
      const text = str(body.text, 2000);
      if (!text) fail("Write what you'd like changed");
      if (doc.items.length >= MAX_ITEMS) fail("Too much feedback");
      const item = {
        id: randomUUID(), text,
        kind: KINDS.includes(body.kind) ? body.kind : "other",
        area: AREAS.includes(body.area) ? body.area : "other",
        status: "open", reply: "", by, t: Date.now(),
      };
      doc.items.unshift(item);
      return `sent feedback: ${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`;
    }

    case "updateFeedback": {
      const item = doc.items.find((i) => i.id === body.id);
      if (!item) fail("That feedback was removed", 409);
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) fail("Pick a status");
        item.status = body.status;
      }
      if (body.reply !== undefined) item.reply = str(body.reply, 1000);
      Object.assign(item, { editedBy: by, editedAt: Date.now() });
      return `marked feedback as ${item.status}`;
    }

    case "deleteFeedback": {
      const item = doc.items.find((i) => i.id === body.id);
      if (!item) return null;
      doc.items = doc.items.filter((i) => i !== item);
      return "removed a piece of feedback";
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: FEEDBACK_KEY,
  defaultDoc,
  normalize,
  applyOp,
  busyMessage: "Feedback is busy, please try again.",
});

export const config = { path: "/api/feedback" };
