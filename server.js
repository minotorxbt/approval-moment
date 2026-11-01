import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ITEMS, ITEM_ORDER } from "./scenarios.js";
import { verify, fetchAttestation } from "./verifier.js";
import { check } from "./rules.js";
import { createOrder, providerAction, expireOrder, userView, providerView } from "./orders.js";

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, ".env")); } catch { /* no .env file: demo mode */ }

const MAX_BODY = 4096;
const MAX_ORDERS = 200;

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Keep reading (so the client gets a clean 413 instead of a reset) but never store more than MAX_BODY.
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () =>
      size > MAX_BODY
        ? reject(Object.assign(new Error("too large"), { code: 413 }))
        : resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Parses a JSON object body. Sends the error response itself and returns null when the body is unusable.
async function jsonBody(req, res) {
  try {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
    send(res, 400, { error: "body must be a JSON object" });
  } catch (e) {
    send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? "body too large" : "invalid JSON" });
  }
  return null;
}

const isoDay = (d) => d.toISOString().slice(0, 10);

// Everything the page needs. All of it is fixed demo data; the page never sends rules or plans back.
function stateFor(now) {
  return {
    today: isoDay(now),
    items: ITEM_ORDER.map((id) => {
      const it = ITEMS[id];
      return {
        id: it.id, title: it.title, category: it.category, dueInDays: it.dueInDays, oneOff: Boolean(it.oneOff),
        instruction: it.instruction, rule: it.rule, agentSays: it.agentSays,
        payMode: it.payMode, provider: it.provider,
        proposals: it.proposals.map(({ id: pid, label, plan, page }) => ({ id: pid, label, plan, page })),
      };
    }),
  };
}

export function createApp({ verifyImpl = verify, attestImpl = fetchAttestation, now = () => new Date() } = {}) {
  const orders = new Map();
  const watchers = new Set();
  const announce = (id) => { for (const w of watchers) w.write(`event: order\ndata: ${JSON.stringify({ id })}\n\n`); };
  const keepAlive = setInterval(() => { for (const w of watchers) w.write(": ping\n\n"); }, 25000);
  keepAlive.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      const get = req.method === "GET";
      const post = req.method === "POST";

      if (get && (p === "/" || p === "/index.html")) return send(res, 200, await readFile(path.join(here, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
      if (get && p === "/provider") return send(res, 200, await readFile(path.join(here, "public", "provider.html"), "utf8"), "text/html; charset=utf-8");
      if (get && p === "/api/status") return send(res, 200, { mode: process.env.NEAR_AI_API_KEY ? "live" : "demo" });
      if (get && p === "/api/state") return send(res, 200, stateFor(now()));
      if (get && p === "/api/attestation") return send(res, 200, await attestImpl());

      if (get && p === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
        res.write(": connected\n\n");
        watchers.add(res);
        req.on("close", () => watchers.delete(res));
        return;
      }

      if (post && p === "/api/check") {
        const body = await jsonBody(req, res);
        if (!body) return;
        const item = typeof body.item === "string" && Object.hasOwn(ITEMS, body.item) ? ITEMS[body.item] : null;
        const proposal = item && typeof body.proposal === "string" ? item.proposals.find((x) => x.id === body.proposal) : null;
        if (!item || !proposal) return send(res, 400, { error: "unknown item or proposal" });
        return send(res, 200, await verifyImpl({ ins: item.rule, plan: proposal.plan, page: proposal.page }));
      }

      // The user approved a plan: create the order the provider will see. The fixed rules are run again here,
      // so a blocked plan can never become an order even if the page is tampered with.
      if (post && p === "/api/orders") {
        const body = await jsonBody(req, res);
        if (!body) return;
        const item = typeof body.item === "string" && Object.hasOwn(ITEMS, body.item) ? ITEMS[body.item] : null;
        const proposal = item && typeof body.proposal === "string" ? item.proposals.find((x) => x.id === body.proposal) : null;
        if (!item || !proposal) return send(res, 400, { error: "unknown item or proposal" });
        if (typeof body.digest !== "string" || !/^[0-9a-f]{64}$/.test(body.digest)) return send(res, 400, { error: "digest must be a SHA-256 hex string" });
        if (check(item.rule, proposal.plan, proposal.page).verdict === "bad") return send(res, 409, { error: "blocked by the fixed rules" });
        const order = createOrder({ itemId: item.id, proposalId: proposal.id, digest: body.digest, now: now() });
        orders.set(order.id, order);
        if (orders.size > MAX_ORDERS) orders.delete(orders.keys().next().value);
        announce(order.id);
        return send(res, 200, userView(order));
      }

      let m = p.match(/^\/api\/orders\/([0-9a-f]{16})$/);
      if (get && m) {
        const o = orders.get(m[1]);
        return o ? send(res, 200, userView(o)) : send(res, 404, { error: "order not found" });
      }
      m = p.match(/^\/api\/orders\/([0-9a-f]{16})\/expire$/);
      if (post && m) {
        const o = orders.get(m[1]);
        if (!o) return send(res, 404, { error: "order not found" });
        try { expireOrder(o, now()); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
        announce(o.id);
        return send(res, 200, userView(o));
      }

      if (get && p === "/api/provider/orders") {
        const list = [...orders.values()].reverse().map((o) => providerView(o, now()));
        return send(res, 200, { orders: list });
      }
      m = p.match(/^\/api\/provider\/orders\/([0-9a-f]{16})\/action$/);
      if (post && m) {
        const o = orders.get(m[1]);
        if (!o) return send(res, 404, { error: "order not found" });
        const body = await jsonBody(req, res);
        if (!body) return;
        if (typeof body.action !== "string") return send(res, 400, { error: "missing action" });
        try { providerAction(o, body.action, body, now()); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
        announce(o.id);
        return send(res, 200, providerView(o, now()));
      }

      return send(res, 404, { error: "not found" });
    } catch {
      return send(res, 500, { error: "server error" });
    }
  });
  server.on("close", () => clearInterval(keepAlive));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Approval Moment is ready: http://localhost:${port}  (mode: ${process.env.NEAR_AI_API_KEY ? "NEAR AI Cloud" : "demo, no API key"})`);
    console.log(`Provider portal (play the school, shop, insurer): http://localhost:${port}/provider`);
  });
}
