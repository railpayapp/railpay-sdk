import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

import { verifyPayment } from "../src/index.js";

// The first x402 settlement to the RailPay treasury on Robinhood Chain (block 121421058), as the RPC returns it.
const TX = "0x988a0174792c1de16af8922b84324efd6f4fa6f2c7f0dd6eaebb5b16a9f641b0";
const PAYER = getAddress("0x2c92a59abf4a39b4db228fecb73e2ddaa900e611");
const TREASURY = getAddress("0xc74444dd7c6183b0f810487ef9dab8d7333a3709");
const FACILITATOR = getAddress("0x619538f76ba880a85e3db265694cdba0a66acc4d");
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NONCE = "0xb543c896e4d11b7c71344d2e5430a631fa7703cbb448487dd77060336ffdcb42";
const RPC = "https://rpc.test";

const receipt = {
  status: "0x1",
  blockNumber: "0x73cbd02",
  from: FACILITATOR.toLowerCase(),
  gasUsed: "0x191f7",
  logs: [
    {
      address: USDG,
      topics: [
        "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
        "0x0000000000000000000000002c92a59abf4a39b4db228fecb73e2ddaa900e611",
        NONCE,
      ],
      data: "0x",
      logIndex: "0x2b",
    },
    {
      address: USDG,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000002c92a59abf4a39b4db228fecb73e2ddaa900e611",
        "0x000000000000000000000000c74444dd7c6183b0f810487ef9dab8d7333a3709",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000007d0",
      logIndex: "0x2c",
    },
  ],
};

function rpc(answers: Record<string, unknown>) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[method] ?? null }));
  });
}

const chain = () => rpc({ eth_getTransactionReceipt: receipt, eth_getBlockByNumber: { timestamp: "0x6b0436f0" } });

describe("verifyPayment", () => {
  it("decodes a settled x402 payment from the receipt", async () => {
    const f = chain();
    const v = await verifyPayment(TX, { rpcUrl: RPC, fetch: f });
    expect(v).toMatchObject({
      ok: true,
      reason: null,
      block: 121421058,
      settled_at: "2026-11-23T12:52:00.000Z",
      payer: PAYER,
      pay_to: TREASURY,
      amount: "0.002",
      amount_raw: "2000",
      authorization: { nonce: NONCE },
      gas_payer: FACILITATOR,
      gas_used: 102903,
      checks: { succeeded: true, transfer: true, pay_to: null, amount: null, authorization: true },
    });
    expect(v.explorer).toBe(`https://robinhoodchain.blockscout.com/tx/${TX}`);
    expect(v.transfers).toHaveLength(1);
    // Only the chain is asked, never the RailPay API.
    expect(f.mock.calls.every(([url]) => url === RPC)).toBe(true);
  });

  it("checks the expected recipient and the exact amount", async () => {
    const good = await verifyPayment(TX, { rpcUrl: RPC, fetch: chain(), payTo: TREASURY.toLowerCase(), amount: "0.002" });
    expect(good.ok).toBe(true);
    expect(good.checks).toMatchObject({ pay_to: true, amount: true });

    const wrongTo = await verifyPayment(TX, { rpcUrl: RPC, fetch: chain(), payTo: PAYER });
    expect(wrongTo).toMatchObject({ ok: false, reason: "pay_to_mismatch" });

    const wrongAmount = await verifyPayment(TX, { rpcUrl: RPC, fetch: chain(), amount: 1000n });
    expect(wrongAmount).toMatchObject({ ok: false, reason: "amount_mismatch", checks: { amount: false } });
  });

  it("reports unknown, reverted and non-token transactions", async () => {
    expect(await verifyPayment(TX, { rpcUrl: RPC, fetch: rpc({}) })).toMatchObject({ ok: false, reason: "not_found", block: null });

    const reverted = rpc({ eth_getTransactionReceipt: { ...receipt, status: "0x0", logs: [] }, eth_getBlockByNumber: { timestamp: "0x1" } });
    expect(await verifyPayment(TX, { rpcUrl: RPC, fetch: reverted })).toMatchObject({ ok: false, reason: "reverted" });

    const other = rpc({ eth_getTransactionReceipt: { ...receipt, logs: [] }, eth_getBlockByNumber: { timestamp: "0x1" } });
    expect(await verifyPayment(TX, { rpcUrl: RPC, fetch: other })).toMatchObject({ ok: false, reason: "no_transfer", authorization: null });
  });

  it("rejects input that is not a transaction hash", async () => {
    await expect(verifyPayment("0x1234")).rejects.toThrow(TypeError);
    await expect(verifyPayment(TX, { payTo: "nope" })).rejects.toThrow(TypeError);
  });
});
