import { RailPay, RailPayError, type SignedPayment } from "./client.js";
import { fromUnits, toUnits } from "./encoding.js";
import { isRailPayPayable, readPaymentRequired, requirementAmount, type PaymentRequirements } from "./x402.js";

export type PaymentEvent = {
  url: string;
  requirement: PaymentRequirements;
  /** Base units. */
  amount: bigint;
  payment: SignedPayment;
};

export type PayingFetchOptions = {
  fetch?: typeof fetch;
  /** Refuse to pay more than this per request: USDG decimal string ("0.05") or base units (bigint). */
  maxAmount?: string | bigint;
  /** Called after a payment is signed, before the retry. */
  onPayment?: (event: PaymentEvent) => void;
};

/**
 * Wrap fetch so a 402 is paid with the agent's RailPay wallet and retried once with PAYMENT-SIGNATURE.
 * Only `exact` / eip155:4663 / USDG requirements are paid; otherwise the original 402 is returned.
 * The agent's policy (per-request max, daily cap, allowlists) is enforced by RailPay on top of `maxAmount`.
 */
export function withPayment(client: RailPay, options: PayingFetchOptions = {}) {
  const base = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const max = options.maxAmount === undefined ? undefined : typeof options.maxAmount === "bigint" ? options.maxAmount : toUnits(options.maxAmount);

  return async function payingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const first = new Request(input, init);
    // A request body can be read once: keep a copy for the paid retry.
    const body = first.body ? await first.arrayBuffer() : undefined;
    const build = (extra?: Record<string, string>) => {
      const headers = new Headers(first.headers);
      for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
      return new Request(first.url, { method: first.method, headers, body, redirect: first.redirect, signal: first.signal });
    };

    const res = await base(build());
    if (res.status !== 402) return res;
    const pr = await readPaymentRequired(res);
    const req = pr?.accepts.find(isRailPayPayable);
    if (!pr || !req) return res;

    const amount = requirementAmount(req);
    if (max !== undefined && amount > max) {
      throw new RailPayError(0, "over_max_amount", `The resource asks ${fromUnits(amount)} USDG, above the limit of ${fromUnits(max)} USDG`);
    }
    const payment = await client.pay({ ...pr, resource: pr.resource ?? { url: first.url } }, first.url);
    options.onPayment?.({ url: first.url, requirement: req, amount, payment });
    return base(build({ "PAYMENT-SIGNATURE": payment.payment }));
  };
}
