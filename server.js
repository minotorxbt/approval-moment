import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { INS, SCENARIOS } from "./scenarios.js";
import { verify } from "./verifier.js";

const here = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(here, ".env")); } catch { /* no .env file: demo mode */ }

const MAX_BODY = 4096;

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

export function createApp({ verifyImpl = verify } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        return send(res, 200, await readFile(path.join(here, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && req.url === "/api/status") {
        return send(res, 200, { mode: process.env.NEAR_AI_API_KEY ? "live" : "demo" });
      }
      if (req.method === "POST" && req.url === "/api/check") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); }
        catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? "body too large" : "invalid JSON" }); }
        const sc = Object.hasOwn(SCENARIOS, body.scenario) ? SCENARIOS[body.scenario] : null;
        if (!sc) return send(res, 400, { error: "unknown scenario" });
        return send(res, 200, await verifyImpl({ ins: INS, plan: sc.plan, page: sc.page }));
      }
      return send(res, 404, { error: "not found" });
    } catch {
      return send(res, 500, { error: "server error" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Approval Moment is ready: http://localhost:${port}  (mode: ${process.env.NEAR_AI_API_KEY ? "NEAR AI Cloud" : "demo, no API key"})`);
  });
}
