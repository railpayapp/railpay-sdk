import { describe, expect, it, vi } from "vitest";

import { NETWORK, RailPay, RailPayError, USDG, b64json, readPaymentRequired, withPayment, type PaymentRequired } from "../src/index.js";

const API = "https://api.test";
const RESOURCE = "https://seller.test/report";
const PAY_TO = "0x2222222222222222222222222222222222222222";

const required = (network = NETWORK, amount = "10000"): PaymentRequired => ({
  x402Version: 2,
  error: "payment_required",
  resource: { url: RESOURCE },
  accepts: [{ scheme: "exact", network, amount, asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" } }],
});

function setup(pr: PaymentRequired) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.text();
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url === `${API}/v1/agent/pay`) {
      return Response.json({ payment: "signed-payment", header: "PAYMENT-SIGNATURE", authorization: {}, valid_before: 0, amount: "0.01", spent_today: "0.01" });
    }
    if (req.url === RESOURCE) {
      if (req.headers.get("payment-signature") === "signed-payment") {
        return Response.json({ ok: true }, { headers: { "PAYMENT-RESPONSE": b64json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: NETWORK }) } });
      }
      return Response.json(pr, { status: 402, headers: { "PAYMENT-REQUIRED": b64json(pr) } });
    }
    return new Response("not found", { status: 404 });
  });
  const client = new RailPay({ apiKey: "rp_sk_test", baseUrl: API, fetch: f as unknown as typeof fetch });
  return { f, calls, client };
}

describe("withPayment", () => {
  it("pays a 402 and retries once with PAYMENT-SIGNATURE", async () => {
    const { f, client } = setup(required());
    const onPayment = vi.fn();
    const res = await withPayment(client, { fetch: f as unknown as typeof fetch, onPayment })(RESOURCE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const urls = f.mock.calls.map((c) => new Request(c[0] as RequestInfo, c[1] as RequestInit).url);
    expect(urls).toEqual([RESOURCE, `${API}/v1/agent/pay`, RESOURCE]);
    expect(onPayment).toHaveBeenCalledOnce();
    expect(onPayment.mock.calls[0]?.[0].amount).toBe(10000n);
  });

  it("sends the agent key and the decoded requirement to /v1/agent/pay", async () => {
    const { f, calls, client } = setup(required());
    await withPayment(client, { fetch: f as unknown as typeof fetch })(RESOURCE);
    const pay = calls.find((c) => c.url.endsWith("/v1/agent/pay"));
    expect(pay?.headers.get("authorization")).toBe("Bearer rp_sk_test");
    const sent = JSON.parse(pay?.body ?? "{}");
    expect(sent.payment_required.accepts[0].payTo).toBe(PAY_TO);
    expect(sent.resource).toBe(RESOURCE);
  });

  it("refuses to pay above maxAmount", async () => {
    const { f, calls, client } = setup(required(NETWORK, "10000"));
    const paying = withPayment(client, { fetch: f as unknown as typeof fetch, maxAmount: "0.005" });
    await expect(paying(RESOURCE)).rejects.toMatchObject({ code: "over_max_amount" });
    expect(calls.some((c) => c.url.endsWith("/v1/agent/pay"))).toBe(false);
  });

  it("returns the original 402 when no requirement is payable", async () => {
    const { f, calls, client } = setup(required("eip155:8453"));
    const res = await withPayment(client, { fetch: f as unknown as typeof fetch })(RESOURCE);
    expect(res.status).toBe(402);
    expect(calls.some((c) => c.url.endsWith("/v1/agent/pay"))).toBe(false);
  });

  it("resends the POST body on the paid retry", async () => {
    const { f, calls, client } = setup(required());
    const res = await withPayment(client, { fetch: f as unknown as typeof fetch })(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "ping" }),
    });
    expect(res.status).toBe(200);
    const hits = calls.filter((c) => c.url === RESOURCE);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.method)).toEqual(["POST", "POST"]);
    expect(hits.map((h) => h.body)).toEqual(['{"q":"ping"}', '{"q":"ping"}']);
  });

  it("passes non-402 responses through untouched", async () => {
    const f = vi.fn(async () => new Response("hello"));
    const client = new RailPay({ apiKey: "k", baseUrl: API, fetch: f as unknown as typeof fetch });
    const res = await withPayment(client, { fetch: f as unknown as typeof fetch })("https://free.test/");
    expect(await res.text()).toBe("hello");
    expect(f).toHaveBeenCalledOnce();
  });
});

describe("RailPay client", () => {
  it("maps API errors to RailPayError", async () => {
    const f = vi.fn(async () => Response.json({ error: "over_daily_cap", message: "Daily cap reached" }, { status: 403 }));
    const client = new RailPay({ apiKey: "k", baseUrl: API, fetch: f as unknown as typeof fetch });
    const e = await client.pay(required()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RailPayError);
    expect(e).toMatchObject({ status: 403, code: "over_daily_cap", message: "Daily cap reached" });
  });

  it("needs an agent key for agent methods", async () => {
    const client = new RailPay({ baseUrl: API, fetch: vi.fn() as unknown as typeof fetch });
    await expect(client.me()).rejects.toMatchObject({ code: "missing_api_key" });
  });

  it("reads the requirement from the body when the header is missing", async () => {
    const res = Response.json(required(), { status: 402 });
    expect((await readPaymentRequired(res))?.accepts[0]?.amount).toBe("10000");
  });
});
