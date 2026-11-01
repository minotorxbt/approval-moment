// Sets up (or inspects) the optional NEAR TESTNET mode.
//   node scripts/testnet.js setup    creates two throw-away testnet keys and stores them in .env
//   node scripts/testnet.js status   shows the two addresses and their test NEAR balances
// Secret keys are written only to the local .env file (which git ignores) and are never printed.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateKeypair, createChain, parseSecretKey, ACCOUNT_URL } from "../chain.js";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
const cmd = process.argv[2];
// "status" must see the same settings as the server does.
if (existsSync(envPath)) { try { process.loadEnvFile(envPath); } catch { /* unreadable .env: treated as missing */ } }

function readEnv() {
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

if (cmd === "setup") {
  const env = readEnv();
  let agent, escrow;
  if (env.NEAR_TESTNET_AGENT_KEY && env.NEAR_TESTNET_ESCROW_KEY) {
    agent = parseSecretKey(env.NEAR_TESTNET_AGENT_KEY);
    escrow = parseSecretKey(env.NEAR_TESTNET_ESCROW_KEY);
    console.log("Testnet keys already exist in .env. Nothing was changed.\n");
  } else {
    agent = generateKeypair();
    escrow = generateKeypair();
    const old = existsSync(envPath) ? readFileSync(envPath, "utf8").replace(/\n*$/, "\n") : "";
    const add = `\n# NEAR TESTNET mode (test NEAR only, no real money). Never share this file.\nNEAR_TESTNET=1\nNEAR_TESTNET_AGENT_KEY=${agent.secretKey}\nNEAR_TESTNET_ESCROW_KEY=${escrow.secretKey}\n`;
    writeFileSync(envPath, old + add);
    try { chmodSync(envPath, 0o600); } catch { /* not important */ }
    console.log("Created two new testnet keys and saved them in .env (they are not shown here).\n");
  }
  console.log("Send test NEAR to these two addresses from your testnet wallet:\n");
  console.log(`  1. AGENT wallet  (send 5 test NEAR):\n     ${agent.accountId}\n`);
  console.log(`  2. ESCROW account (send 1 test NEAR):\n     ${escrow.accountId}\n`);
  console.log("Then run:  npm run testnet:status   to check that the balances arrived.");
} else if (cmd === "status") {
  const chain = createChain();
  if (!chain.enabled) {
    console.log("Testnet mode is off." + (chain.problem ? ` Problem: ${chain.problem}` : " Run: npm run testnet:setup"));
    process.exit(0);
  }
  const s = await chain.status();
  const show = (name, w) => console.log(`${name}: ${w.near === undefined ? "could not read balance" : w.near === null ? "0 (account does not exist yet: send test NEAR to it)" : w.near + " test NEAR"}\n  ${w.account}\n  ${w.url}`);
  show("AGENT ", s.agent);
  show("ESCROW", s.escrow);
} else {
  console.log("Usage: node scripts/testnet.js setup | status");
}
