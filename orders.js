// What happens after the user approves: the provider side of each payment.
// Each flow lists the steps a provider has to report and a final check that compares what the
// provider reported with the user's rule. All of it is simulated; in a real version the reports
// would arrive from the provider's own system as signed confirmations or receipts.
import { randomBytes } from "node:crypto";
import { ITEMS } from "./scenarios.js";

const DAY = 864e5;
const money = (n) => `$${n}`;
const digits = (n) => Array.from(randomBytes(n), (b) => b % 10).join("");
const isoDay = (d) => d.toISOString().slice(0, 10);
const fail = (message) => Object.assign(new Error(message), { code: 400 });
const code = (v, re, what) => {
  const t = String(v ?? "").trim().toUpperCase();
  if (!re.test(t)) throw fail(`${what} is not valid.`);
  return t;
};

// A provider step: what the provider is asked for, how its answer is validated, what it adds to the timeline.
const FLOWS = {
  receipt: {
    provider: [
      {
        action: "confirm", button: "Confirm receipt", label: (o) => `${o.provider} confirms receipt`,
        fields: (o) => [{ name: "amount", label: "Amount received ($)", type: "number", default: o.price }],
        apply(o, b) {
          const amount = Number(b.amount);
          if (!Number.isFinite(amount) || amount <= 0 || amount > 1e6) throw fail("Enter the amount received.");
          const reference = `SCH-${digits(4)}`;
          return { data: { amount, reference }, detail: `Reference ${reference}, amount received ${money(amount)}` };
        },
      },
    ],
    check(o) {
      const got = o.events.find((e) => e.action === "confirm").data.amount;
      return got === o.price
        ? { ok: true, detail: `Amount on the receipt matches (${money(got)})` }
        : { ok: false, detail: `Amount on the receipt (${money(got)}) differs from the plan (${money(o.price)})` };
    },
    checkLabel: "Receipt check",
  },
  policy: {
    provider: [
      {
        action: "issue", button: "Issue the policy", label: (o) => `${o.provider} issues the policy`,
        fields: (o) => [
          { name: "policyNo", label: "Policy number", type: "text", default: `P-${digits(5)}` },
          { name: "cover", label: "Cover level", type: "select", options: [o.expect.cover, "Basic"], default: o.expect.cover },
        ],
        apply(o, b) {
          const policyNo = code(b.policyNo, /^[A-Z0-9-]{4,20}$/, "The policy number");
          const cover = String(b.cover);
          if (![o.expect.cover, "Basic"].includes(cover)) throw fail("Choose a cover level.");
          return { data: { policyNo, cover }, detail: `Policy ${policyNo}, cover ${cover}` };
        },
      },
    ],
    check(o) {
      const cover = o.events.find((e) => e.action === "issue").data.cover;
      return cover === o.expect.cover
        ? { ok: true, detail: `Cover matches the offer (${cover})` }
        : { ok: false, detail: `Cover on the policy (${cover}) differs from the offer (${o.expect.cover})` };
    },
    checkLabel: "Policy check",
  },
  inspection: {
    provider: [
      {
        action: "confirm", button: "Confirm the appointment", label: () => "Appointment confirmed",
        fields: () => [{ name: "code", label: "Confirmation code", type: "text", default: `INS-${digits(4)}` }],
        apply(o, b) {
          const c = code(b.code, /^[A-Z0-9-]{4,20}$/, "The confirmation code");
          return { data: { code: c }, detail: `Confirmation code ${c}` };
        },
      },
      {
        action: "complete", button: "Complete the inspection", label: () => "Inspection done",
        fields: (o, now) => [
          { name: "result", label: "Result", type: "select", options: ["Passed", "Failed"], default: "Passed" },
          { name: "validUntil", label: "Certificate valid until", type: "date", default: isoDay(new Date(now.getTime() + 365 * DAY)) },
        ],
        apply(o, b) {
          const result = String(b.result);
          if (!["Passed", "Failed"].includes(result)) throw fail("Choose a result.");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.validUntil)) || Number.isNaN(Date.parse(b.validUntil))) throw fail("Enter a valid date.");
          return { data: { result, validUntil: String(b.validUntil) }, detail: `${result}, certificate valid until ${b.validUntil}` };
        },
      },
    ],
    check(o, now) {
      const r = o.events.find((e) => e.action === "complete").data;
      const longEnough = Date.parse(`${r.validUntil}T00:00:00Z`) >= now.getTime() + 300 * DAY;
      return r.result === "Passed" && longEnough
        ? { ok: true, detail: `Certificate is valid until ${r.validUntil}` }
        : { ok: false, detail: `Certificate is missing, failed or too short (${r.result}, until ${r.validUntil})` };
    },
    checkLabel: "Certificate check",
  },
  shop: {
    provider: [
      {
        action: "ship", button: "Mark as shipped", label: () => "Shipped",
        fields: () => [{ name: "tracking", label: "Tracking code", type: "text", default: `TR${digits(8)}` }],
        apply(o, b) {
          const tracking = code(b.tracking, /^[A-Z0-9]{8,20}$/, "The tracking code");
          return { data: { tracking }, detail: `Tracking code ${tracking}` };
        },
      },
      {
        action: "deliver", button: "Mark as delivered", label: () => "Delivered",
        fields: (o) => [
          { name: "deliveryCode", label: "Delivery code (the buyer tells the courier at the door)", type: "text", default: "" },
          { name: "size", label: "Size of the delivered item", type: "select", options: ["42", "43"], default: String(o.expect.size) },
        ],
        apply(o, b) {
          if (String(b.deliveryCode ?? "").trim() !== o.buyerCode) throw fail("Wrong delivery code. The courier must get the 6-digit code from the buyer.");
          const size = String(b.size);
          if (!["42", "43"].includes(size)) throw fail("Choose a size.");
          return { data: { size }, detail: `Delivery code accepted, item size ${size}` };
        },
      },
    ],
    check(o) {
      const size = o.events.find((e) => e.action === "deliver").data.size;
      return size === String(o.expect.size)
        ? { ok: true, detail: `The delivered item matches your rule (size ${size})` }
        : { ok: false, detail: `The delivered item (size ${size}) does not match your rule (size ${o.expect.size})` };
    },
    checkLabel: "Item check",
  },
};

export function createOrder({ itemId, proposalId, digest, now = new Date() }) {
  const item = ITEMS[itemId];
  const proposal = item.proposals.find((p) => p.id === proposalId);
  const flow = FLOWS[item.flow];
  const o = {
    id: randomBytes(8).toString("hex"),
    itemId, proposalId, digest,
    createdAt: now.toISOString(),
    flow: item.flow, payMode: item.payMode, provider: item.provider, title: item.title,
    price: proposal.plan.price, to: proposal.plan.to,
    expect: { ...(item.expect || {}), size: item.rule.attrs?.size },
    buyerCode: item.flow === "shop" ? digits(6) : null,
    status: "open", cursor: 1, events: [],
    steps: [
      item.payMode === "direct"
        ? { key: "pay", label: `Payment sent directly to ${item.provider}`, state: "done", detail: "Direct payment: a saved payee with a due date, so no escrow." }
        : { key: "pay", label: "Payment in escrow", state: "done", detail: "The money waits in a safe vault, not with the provider yet." },
    ],
  };
  o.steps.push(...flow.provider.map((p) => ({ key: p.action, label: p.label(o), state: "waiting", detail: "Waiting" })));
  o.steps.push({ key: "check", label: flow.checkLabel, state: "waiting", detail: "Waiting" });
  return o;
}

const nextProviderStep = (o) => (o.status === "open" ? FLOWS[o.flow].provider[o.cursor - 1] ?? null : null);

export function providerAction(o, action, body, now = new Date()) {
  const step = nextProviderStep(o);
  if (!step) throw fail("There is nothing for the provider to do on this order.");
  if (step.action !== action) throw fail(`The next step is "${step.button}".`);
  const { data, detail } = step.apply(o, body || {});
  o.events.push({ time: now.toISOString(), actor: "provider", action, data });
  Object.assign(o.steps[o.cursor], { state: "done", detail });
  o.cursor += 1;
  if (o.cursor === o.steps.length - 1) {
    const r = FLOWS[o.flow].check(o, now);
    Object.assign(o.steps[o.cursor], { state: r.ok ? "done" : "bad", detail: r.detail });
    o.status = r.ok ? "completed" : "dispute";
    o.events.push({ time: now.toISOString(), actor: "verifier", action: "check", data: { ok: r.ok, detail: r.detail } });
  }
  return o;
}

// "3 days pass and the provider never answered": escrow refunds, a direct payment goes to dispute.
export function expireOrder(o, now = new Date()) {
  if (o.status !== "open" || o.cursor !== 1) throw fail("Only an order that is waiting for its first provider confirmation can time out.");
  const escrow = o.payMode === "escrow";
  Object.assign(o.steps[1], { state: "bad", detail: "Not confirmed within 3 days" });
  o.status = escrow ? "refund" : "dispute";
  o.events.push({ time: now.toISOString(), actor: "system", action: "timeout", data: { result: o.status } });
  return o;
}

export function userView(o) {
  const step = nextProviderStep(o);
  return {
    id: o.id, itemId: o.itemId, proposalId: o.proposalId, payMode: o.payMode, provider: o.provider,
    status: o.status, price: o.price, digest: o.digest, steps: o.steps, events: o.events,
    buyerCode: o.buyerCode && o.status === "open" ? o.buyerCode : null,
    waitingFor: step ? step.button : null,
    canExpire: o.status === "open" && o.cursor === 1,
  };
}

export function providerView(o, now = new Date()) {
  const step = nextProviderStep(o);
  return {
    id: o.id, provider: o.provider, title: o.title, price: o.price, payee: o.to, ref: o.digest.slice(0, 12),
    payMode: o.payMode, createdAt: o.createdAt, status: o.status, steps: o.steps,
    action: step ? { name: step.action, button: step.button, fields: step.fields(o, now) } : null,
  };
}
