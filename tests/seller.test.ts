import { encodeAbiParameters, pad, toEventSelector, toFunctionSelector, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID, NETWORK, USDG, b64json, createPaywall, unb64json, type PaymentRequired, type SettleResponse } from "../src/index.js";

const RPC = "https://rpc.test";
const FAC_A = "https://facilitator-a.test";
const FAC_B = "https://facilitator-b.test";
const URL_ = "https://seller.test/report";
const PRICE = 10_000n; // 0.01 USDG

const BALANCE_OF = toFunctionSelector("balanceOf(address)");
const AUTH_STATE = toFunctionSelector("authorizationState(address,bytes32)");
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");

type Receipt = { status: string; logs: { address: string; topics: string[]; data: string }[] } | null;
type FacAnswer = Partial<SettleResponse> | "unreachable";

let payer: PrivateKeyAccount;
let payTo: PrivateKeyAccount;
let chain: { balance: bigint; used: boolean; receipts: Map<string, Receipt> };
let facilitator: Record<string, FacAnswer>;
let settleCalls: { url: string; body: { x402Version: number; paymentPayload: { payload: { authorization: { to: string } } }; paymentRequirements: { amount: string } } }[];

const TX1 = `0x${"11".repeat(32)}`;
const TX2 = `0x${"22".repeat(32)}`;

function transferReceipt(from: string, to: string, value: bigint): Receipt {
  return {
    status: "0x1",
    logs: [{ address: USDG, topics: [TRANSFER, pad(from.toLowerCase() as Hex), pad(to.toLowerCase() as Hex)], data: pad(toHex(value)) }],
  };
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = JSON.parse(String(init?.body ?? "null"));
  if (url === RPC) {
    const { method, params } = body as { method: string; params: unknown[] };
    const result = (() => {
      if (method === "eth_blockNumber") return "0x64";
      if (method === "eth_getTransactionReceipt") return chain.receipts.get(String(params[0])) ?? null;
      if (method === "eth_getLogs") return [];
      if (method === "eth_call") {
        const data = (params[0] as { data: string }).data;
        if (data.startsWith(BALANCE_OF)) return encodeAbiParameters([{ type: "uint256" }], [chain.balance]);
        if (data.startsWith(AUTH_STATE)) return encodeAbiParameters([{ type: "bool" }], [chain.used]);
      }
      throw new Error(`unmocked rpc ${method}`);
    })();
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  }
  for (const base of [FAC_A, FAC_B]) {
    if (url === `${base}/settle`) {
      settleCalls.push({ url, body });
      const a = facilitator[base];
      if (!a || a === "unreachable") throw new TypeError("fetch failed");
      return Response.json(a);
    }
  }
  throw new Error(`unmocked fetch ${url}`);
});

const paywall = () =>
  createPaywall({ payTo: payTo.address, price: "0.01", description: "Report", facilitators: [FAC_A, FAC_B], rpcUrl: RPC, fetch: mockFetch as unknown as typeof fetch, receiptWaitMs: 0 });

async function payment(o: { signer?: PrivateKeyAccount; to?: string; value?: bigint; validBefore?: bigint; nonce?: Hex } = {}) {
  const t = BigInt(Math.floor(Date.now() / 1000));
  const message = {
    from: payer.address,
    to: (o.to ?? payTo.address) as Hex,
    value: o.value ?? PRICE,
    validAfter: t - 60n,
    validBefore: o.validBefore ?? t + 240n,
    nonce: o.nonce ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex),
  };
  const signature = await (o.signer ?? payer).signTypedData({
    domain: { name: "Global Dollar", version: "1", chainId: CHAIN_ID, verifyingContract: USDG },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message,
  });
  const authorization = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return b64json({
    x402Version: 2,
    accepted: { scheme: "exact", network: NETWORK, amount: PRICE.toString(), asset: USDG, payTo: payTo.address },
    payload: { signature, authorization },
  });
}

const request = (header?: string) => new Request(URL_, { headers: header ? { "PAYMENT-SIGNATURE": header } : {} });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  payer = privateKeyToAccount(generatePrivateKey());
  payTo = privateKeyToAccount(generatePrivateKey());
  chain = { balance: 1_000_000n, used: false, receipts: new Map() };
  facilitator = {};
  settleCalls = [];
  mockFetch.mockClear();
});

describe("createPaywall", () => {
  it("refuses prices below 0.001 USDG and bad payTo", () => {
    expect(() => createPaywall({ payTo: payTo.address, price: "0.0005" })).toThrow(RangeError);
    expect(() => createPaywall({ payTo: "nope", price: "0.01" })).toThrow(TypeError);
  });

  it("answers 402 with the requirement in PAYMENT-REQUIRED", async () => {
    const serve = vi.fn(() => Response.json({ ok: true }));
    const res = await paywall().handle(request(), serve);
    expect(res.status).toBe(402);
    const pr = unb64json<PaymentRequired>(res.headers.get("payment-required") ?? "");
    expect(pr.x402Version).toBe(2);
    expect(pr.resource?.url).toBe(URL_);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, amount: "10000", asset: USDG, payTo: payTo.address, extra: { name: "Global Dollar", version: "1" } });
    expect(res.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
    expect(serve).not.toHaveBeenCalled();
  });

  it("rejects garbage and authorizations that do not match", async () => {
    const pw = paywall();
    const serve = vi.fn(() => Response.json({ ok: true }));
    const other = privateKeyToAccount(generatePrivateKey());
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(await errorOf(await pw.handle(request("not-base64!"), serve))).toBe("invalid_payload");
    expect(await errorOf(await pw.handle(request(await payment({ to: other.address })), serve))).toBe("invalid_exact_evm_payload_recipient_mismatch");
    expect(await errorOf(await pw.handle(request(await payment({ value: 9_999n })), serve))).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
    expect(await errorOf(await pw.handle(request(await payment({ validBefore: now + 2n })), serve))).toBe("invalid_exact_evm_payload_authorization_valid_before");
    expect(await errorOf(await pw.handle(request(await payment({ signer: other })), serve))).toBe("invalid_exact_evm_payload_signature");
    expect(serve).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(0);
  });

  it("rejects a payer without enough USDG, and a nonce already used on-chain", async () => {
    const pw = paywall();
    const serve = vi.fn(() => Response.json({ ok: true }));
    chain.balance = 9_999n;
    expect(await errorOf(await pw.handle(request(await payment()), serve))).toBe("insufficient_funds");
    chain.balance = 1_000_000n;
    chain.used = true;
    expect(await errorOf(await pw.handle(request(await payment()), serve))).toBe("invalid_payload");
    expect(settleCalls).toHaveLength(0);
  });

  it("settles through the first facilitator, checks the chain, serves once", async () => {
    const pw = paywall();
    const serve = vi.fn(() => Response.json({ content: "secret" }));
    facilitator[FAC_A] = { success: true, transaction: TX1, network: NETWORK };
    chain.receipts.set(TX1, transferReceipt(payer.address, payTo.address, PRICE));
    const header = await payment();

    const res = await pw.handle(request(header), serve);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "secret" });
    expect(unb64json(res.headers.get("payment-response") ?? "")).toEqual({ success: true, transaction: TX1, network: NETWORK, payer: payer.address.toLowerCase() });
    expect(res.headers.get("x-payment-response")).toBe(res.headers.get("payment-response"));
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.body.x402Version).toBe(2);
    expect(settleCalls[0]?.body.paymentRequirements.amount).toBe("10000");
    expect(settleCalls[0]?.body.paymentPayload.payload.authorization.to).toBe(payTo.address);

    const replay = await pw.handle(request(header), serve);
    expect(replay.status).toBe(402);
    expect(await errorOf(replay)).toBe("invalid_payload");
    expect(serve).toHaveBeenCalledOnce();
  });

  it("fails over to the next facilitator", async () => {
    const pw = paywall();
    facilitator[FAC_A] = "unreachable";
    facilitator[FAC_B] = { success: true, transaction: TX2, network: NETWORK };
    chain.receipts.set(TX2, transferReceipt(payer.address, payTo.address, PRICE));
    const res = await pw.handle(request(await payment()), () => Response.json({ ok: true }));
    expect(res.status).toBe(200);
    expect(settleCalls.map((c) => c.url)).toEqual([`${FAC_A}/settle`, `${FAC_B}/settle`]);
  });

  it("answers unexpected_settle_error when no facilitator settles, and releases the claim", async () => {
    const pw = paywall();
    const serve = vi.fn(() => Response.json({ ok: true }));
    facilitator[FAC_A] = { success: false, errorReason: "gas_day_budget_exhausted", transaction: "" };
    facilitator[FAC_B] = "unreachable";
    const header = await payment();
    const res = await pw.handle(request(header), serve);
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toBe("unexpected_settle_error");

    facilitator[FAC_A] = { success: true, transaction: TX1, network: NETWORK };
    chain.receipts.set(TX1, transferReceipt(payer.address, payTo.address, PRICE));
    const retry = await pw.handle(request(header), serve);
    expect(retry.status).toBe(200);
    expect(serve).toHaveBeenCalledOnce();
  });

  it("does not trust a facilitator's success without the on-chain transfer", async () => {
    const pw = paywall();
    const serve = vi.fn(() => Response.json({ ok: true }));
    facilitator[FAC_A] = { success: true, transaction: TX1, network: NETWORK };
    const header = await payment();

    const first = await pw.handle(request(header), serve);
    expect(first.status).toBe(402);
    expect(await errorOf(first)).toBe("settlement_pending");
    expect(unb64json<SettleResponse>(first.headers.get("payment-response") ?? "").transaction).toBe(TX1);
    expect(serve).not.toHaveBeenCalled();

    chain.receipts.set(TX1, transferReceipt(payer.address, payTo.address, PRICE));
    const second = await pw.handle(request(header), serve);
    expect(second.status).toBe(200);
    const third = await pw.handle(request(header), serve);
    expect(await errorOf(third)).toBe("invalid_payload");
    expect(serve).toHaveBeenCalledOnce();
    expect(settleCalls).toHaveLength(1);
  });

  it("keeps a facilitator's settlement_pending as pending", async () => {
    const pw = paywall();
    facilitator[FAC_A] = { success: false, errorReason: "settlement_pending", transaction: TX1, network: NETWORK };
    const res = await pw.handle(request(await payment()), () => Response.json({ ok: true }));
    expect(await errorOf(res)).toBe("settlement_pending");
    expect(settleCalls).toHaveLength(1);
  });

  it("does not serve when the receipt holds a different transfer", async () => {
    const pw = paywall();
    const serve = vi.fn(() => Response.json({ ok: true }));
    facilitator[FAC_A] = { success: true, transaction: TX1, network: NETWORK };
    chain.receipts.set(TX1, transferReceipt(payer.address, payTo.address, PRICE - 1n));
    const res = await pw.handle(request(await payment()), serve);
    expect(await errorOf(res)).toBe("settlement_pending");
    expect(serve).not.toHaveBeenCalled();
  });
});
