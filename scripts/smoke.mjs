// Read-only check against the live RailPay network. Spends nothing, needs no key.
// Usage: pnpm build && pnpm smoke [baseUrl]
import { DEFAULT_BASE_URL, RailPay, fromUnits, isRailPayPayable, readPaymentRequired, requirementAmount } from "../dist/index.js";

const base = process.argv[2] ?? DEFAULT_BASE_URL;
const client = new RailPay({ baseUrl: base });

const config = await client.config();
console.log("config:", JSON.stringify({ network: config.network, chain_id: config.chain_id, facilitators: config.facilitators, relayer_status: config.relayer_status }));

const stats = await fetch(`${base}/v1/stats`);
if (stats.status !== 401) throw new Error(`expected /v1/stats to need an account key, got ${stats.status}`);
console.log("stats: account key required (401 without one)");

const res = await fetch(`${base}/x402/time`);
if (res.status !== 402) throw new Error(`expected 402 from /x402/time, got ${res.status}`);
const pr = await readPaymentRequired(res);
const req = pr?.accepts.find(isRailPayPayable);
if (!req) throw new Error("no RailPay-payable requirement in the 402");
console.log(`402 ok: ${fromUnits(requirementAmount(req))} USDG to ${req.payTo} on ${req.network}`);
console.log("smoke ok");
