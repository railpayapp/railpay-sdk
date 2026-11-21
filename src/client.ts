import { DEFAULT_BASE_URL } from "./constants.js";
import type { AuthorizationFields, PaymentRequired } from "./x402.js";

/** An error answer from the RailPay API (`{ error, message }`), or a local refusal (status 0). */
export class RailPayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RailPayError";
  }
}

export type Policy = {
  /** Base units. */
  per_request_max: number;
  /** Base units. */
  daily_cap: number;
  allowed_hosts: string[];
  allowed_pay_to: string[];
  allow_a2a: boolean;
  paused: boolean;
};

export type Agent = {
  id: string;
  name: string;
  address: string;
  created_at: number;
  /** USDG held by the agent wallet, in base units (read from the chain). */
  balance: number;
  /** ETH held by the agent wallet, as a decimal string. */
  eth: string;
  /** Spent or held today, in base units. */
  spent_today: number;
  policy: Policy;
};

/** A signed x402 payment, ready for the PAYMENT-SIGNATURE header of the retry. */
export type SignedPayment = {
  payment: string;
  header: "PAYMENT-SIGNATURE";
  authorization: AuthorizationFields;
  valid_before: number;
  amount: string;
  spent_today: string;
};

export type SendResult = { tx_hash: string; tx_url: string; amount: string; pending?: boolean };

export type RailPayOptions = {
  /** API key (`rp_sk_…`). An agent key for the agent methods; an account key for `stats()`. `config()` is public. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

/** Client for the RailPay API. */
export class RailPay {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: RailPayOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Low-level call. Throws {@link RailPayError} on a non-2xx answer. */
  async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; message?: string };
      throw new RailPayError(res.status, e.error ?? `http_${res.status}`, e.message ?? (text.slice(0, 200) || res.statusText));
    }
    return json as T;
  }

  #needKey() {
    if (!this.#apiKey) throw new RailPayError(0, "missing_api_key", "Pass an agent key (rp_sk_…) as apiKey");
  }

  /** The calling agent: balance, policy and today's spend. Agent key. */
  async me(): Promise<Agent> {
    this.#needKey();
    return (await this.request<{ agent: Agent }>("GET", "/v1/agent/me")).agent;
  }

  /**
   * Sign an EIP-3009 USDG authorization for a 402 requirement, inside the agent's policy. Agent key.
   * Put `payment` in the PAYMENT-SIGNATURE header of the retry. The seller (or its facilitator) settles it.
   */
  async pay(paymentRequired: PaymentRequired, resourceUrl?: string): Promise<SignedPayment> {
    this.#needKey();
    return this.request<SignedPayment>("POST", "/v1/agent/pay", { payment_required: paymentRequired, resource: resourceUrl });
  }

  /** Agent-to-agent USDG payment (needs `allow_a2a`; the paying agent wallet pays the gas in ETH). Agent key. */
  async send(input: { to: string; amount: string; memo?: string }): Promise<SendResult> {
    this.#needKey();
    return this.request<SendResult>("POST", "/v1/agent/send", input);
  }

  /** Network settings: chain, USDG, facilitators, x402 settings. Public. */
  async config(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/config");
  }

  /** Network stats: every recorded payment, outside vs team. Needs an account key (signed-in accounts only). */
  async stats(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/stats");
  }
}
