// An agent that pays for x402 resources with its RailPay wallet.
// Run: RAILPAY_AGENT_KEY=rp_sk_… npx tsx examples/agent.ts
import { RailPay, fromUnits, readPaymentResponse, withPayment } from "railpay-sdk";

const apiKey = process.env.RAILPAY_AGENT_KEY;
if (!apiKey) throw new Error("Set RAILPAY_AGENT_KEY (create an agent and a key in the RailPay dapp)");

const railpay = new RailPay({ apiKey });

const me = await railpay.me();
console.log(`${me.name} ${me.address}: ${fromUnits(me.balance)} USDG, spent today ${fromUnits(me.spent_today)} USDG`);

// Pays any 402 that asks for USDG on Robinhood Chain, never more than 0.01 USDG per request.
const paidFetch = withPayment(railpay, {
  maxAmount: "0.01",
  onPayment: ({ url, amount }) => console.log(`paying ${fromUnits(amount)} USDG for ${url}`),
});

const res = await paidFetch("https://dapp.railpay.app/x402/time");
console.log(res.status, await res.text());

const receipt = readPaymentResponse(res);
if (receipt?.success) console.log(`settled: https://robinhoodchain.blockscout.com/tx/${receipt.transaction}`);
