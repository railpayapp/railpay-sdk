import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, pad, parseAbi, recoverTypedDataAddress, toEventSelector, type Hex } from "viem";

import { CHAIN_ID, DEFAULT_FACILITATORS, DEFAULT_RPC_URL, MIN_X402_AMOUNT, NETWORK, USDG, USDG_EIP712 } from "./constants.js";
import { b64json, fromUnits, toUnits, unb64json } from "./encoding.js";
import type { AuthorizationFields, PaymentRequired, PaymentRequirements, ResourceInfo, SettleResponse } from "./x402.js";

// ---------- payment store ----------

/** Where an authorization stands on this server. */
export type StoredPayment = { status: "settling" | "pending" | "settled"; resource: string; tx?: string };

/**
 * Remembers which authorizations were settled and served, so one payment unlocks one response.
 * `memoryStore()` lives in one process. With several instances (serverless, more than one replica) pass a shared
 * store (Redis, D1, a database table) whose `claim` is an atomic insert-if-absent.
 */
export interface PaymentStore {
  /** Insert if the key is absent. Returns false if it already exists. Must be atomic. */
  claim(key: string, value: StoredPayment): Promise<boolean>;
  get(key: string): Promise<StoredPayment | undefined>;
  set(key: string, value: StoredPayment): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryStore(): PaymentStore {
  const m = new Map<string, StoredPayment>();
  return {
    async claim(key, value) {
      if (m.has(key)) return false;
      m.set(key, value);
      return true;
    },
    async get(key) {
      return m.get(key);
    },
    async set(key, value) {
      m.set(key, value);
    },
    async delete(key) {
      m.delete(key);
    },
  };
}

// ---------- chain reads (plain JSON-RPC over the injectable fetch) ----------

const ERC20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const AUTHORIZATION_USED_TOPIC = toEventSelector("AuthorizationUsed(address,bytes32)");
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

type Log = { address: string; topics: string[]; data: string; transactionHash?: string };
type Receipt = { status: string; logs: Log[] };

function chain(f: typeof fetch, url: string) {
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message ?? "rpc error"}`);
    return j.result as T;
  }
  const read = async (functionName: "balanceOf" | "authorizationState", args: readonly unknown[]) => {
    const data = encodeFunctionData({ abi: ERC20, functionName, args } as never);
    const out = await call<Hex>("eth_call", [{ to: USDG, data }, "latest"]);
    return decodeFunctionResult({ abi: ERC20, functionName, data: out } as never) as unknown;
  };
  return {
    balanceOf: async (owner: string) => (await read("balanceOf", [owner])) as bigint,
    authorizationUsed: async (authorizer: string, nonce: Hex) => (await read("authorizationState", [authorizer, nonce])) as boolean,
    blockNumber: async () => Number(BigInt(await call<string>("eth_blockNumber", []))),
    receipt: (hash: string) => call<Receipt | null>("eth_getTransactionReceipt", [hash]),
    authorizationTx: async (authorizer: string, nonce: Hex, fromBlock: number) => {
      const logs = await call<Log[]>("eth_getLogs", [
        {
          address: USDG,
          topics: [AUTHORIZATION_USED_TOPIC, pad(authorizer.toLowerCase() as Hex), nonce],
          fromBlock: `0x${Math.max(0, fromBlock - 5).toString(16)}`,
          toBlock: "latest",
        },
      ]);
      return logs[0]?.transactionHash?.toLowerCase() ?? null;
    },
  };
}

// ---------- paywall ----------

export type PaywallOptions = {
  /** Wallet that receives the USDG. */
  payTo: string;
  /** Price per request: USDG decimal string ("0.01") or base units (bigint). At least 0.001 USDG. */
  price: string | bigint;
  description?: string;
  mimeType?: string;
  /** x402 facilitators that settle and pay the gas, tried in order. Default: Toll, then Primer. */
  facilitators?: readonly string[];
  /** Robinhood Chain JSON-RPC used to verify payments. Default: publicnode. */
  rpcUrl?: string;
  /** Default: memoryStore() (one process only). */
  store?: PaymentStore;
  fetch?: typeof fetch;
  /** How long to wait for the settlement receipt before answering settlement_pending. Default 12000. */
  receiptWaitMs?: number;
  /** Clock in milliseconds (tests). */
  now?: () => number;
};

const TIMEOUT_SECONDS = 300;
const EXPOSE = "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE";

type Authorization = { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
type Parsed = { version: unknown; scheme?: string; network?: string; asset?: string; signature: Hex; auth: Authorization };

/** PAYMENT-SIGNATURE (x402 v2; X-PAYMENT accepted too) = base64 JSON with payload.signature + payload.authorization. */
function parsePayment(header: string): Parsed | null {
  let j: { x402Version?: unknown; scheme?: string; network?: string; accepted?: PaymentRequirements; payload?: { signature?: unknown; authorization?: Record<string, unknown> } };
  try {
    j = unb64json(header);
  } catch {
    return null;
  }
  const a = j?.payload?.authorization;
  const sig = String(j?.payload?.signature ?? "");
  if (!a || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  const big = (v: unknown) => ((typeof v === "string" || typeof v === "number") && /^\d{1,30}$/.test(String(v)) ? BigInt(v) : null);
  const value = big(a.value);
  const validAfter = big(a.validAfter);
  const validBefore = big(a.validBefore);
  const from = String(a.from ?? "");
  const to = String(a.to ?? "");
  const nonce = String(a.nonce ?? "");
  if (!isAddress(from) || !isAddress(to) || value === null || validAfter === null || validBefore === null || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  return {
    version: j.x402Version,
    scheme: j.accepted?.scheme ?? j.scheme,
    network: j.accepted?.network ?? j.network,
    asset: j.accepted?.asset,
    signature: sig as Hex,
    auth: { from: getAddress(from), to: getAddress(to), value, validAfter, validBefore, nonce: nonce.toLowerCase() as Hex },
  };
}

const authStrings = (a: Authorization): AuthorizationFields => ({
  from: a.from,
  to: a.to,
  value: a.value.toString(),
  validAfter: a.validAfter.toString(),
  validBefore: a.validBefore.toString(),
  nonce: a.nonce,
});

class SettlementPending extends Error {
  constructor(readonly hash: string) {
    super(`settlement broadcast, not confirmed yet: ${hash}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An x402 v2 paywall that charges USDG on Robinhood Chain (scheme `exact`, EIP-3009).
 *
 * `handle(request, serve)`: without a payment it answers 402 with the requirement (PAYMENT-REQUIRED header and
 * body). With PAYMENT-SIGNATURE it verifies the authorization, settles it through a facilitator (which pays the gas),
 * reads the USDG transfer back from the chain, then calls `serve()` and adds PAYMENT-RESPONSE.
 * Works with any framework built on the Fetch API: Hono, Cloudflare Workers, Bun, Deno, Next.js route handlers.
 */
export function createPaywall(options: PaywallOptions) {
  const price = typeof options.price === "bigint" ? options.price : toUnits(options.price);
  if (price < MIN_X402_AMOUNT) throw new RangeError(`The lowest price is ${fromUnits(MIN_X402_AMOUNT)} USDG, the smallest payment x402 facilitators settle`);
  if (!isAddress(options.payTo)) throw new TypeError("payTo must be a 0x address");
  const payTo = getAddress(options.payTo);
  const facilitators = (options.facilitators ?? DEFAULT_FACILITATORS).map((s) => s.trim().replace(/\/+$/, "")).filter((s) => /^https?:\/\/\S+$/.test(s));
  const store = options.store ?? memoryStore();
  const f: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const rpc = chain(f, options.rpcUrl ?? DEFAULT_RPC_URL);
  const waitMs = options.receiptWaitMs ?? 12_000;
  const nowSec = () => Math.floor((options.now ?? Date.now)() / 1000);

  const accept: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: price.toString(),
    asset: USDG,
    payTo,
    maxTimeoutSeconds: TIMEOUT_SECONDS,
    extra: { name: USDG_EIP712.name, version: USDG_EIP712.version },
  };
  const resourceOf = (url: string): ResourceInfo => {
    const u = new URL(url);
    return { url: `${u.origin}${u.pathname}`, description: options.description ?? "Paid resource", mimeType: options.mimeType ?? "application/json" };
  };

  /** The x402 v2 PaymentRequired object for a resource URL. */
  function requirements(url: string): PaymentRequired {
    return { x402Version: 2, resource: resourceOf(url), accepts: [accept] };
  }

  /** The exact USDG transfer payer → payTo in this transaction? null = no receipt yet. */
  async function transferIn(hash: string, payer: string, wait: number): Promise<boolean | null> {
    const until = Date.now() + wait;
    for (;;) {
      const r = await rpc.receipt(hash).catch(() => null);
      if (r) {
        if (r.status !== "0x1") return false;
        const from = pad(payer.toLowerCase() as Hex);
        const to = pad(payTo.toLowerCase() as Hex);
        return r.logs.some(
          (l) =>
            l.address.toLowerCase() === USDG.toLowerCase() &&
            l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
            l.topics[1]?.toLowerCase() === from &&
            l.topics[2]?.toLowerCase() === to &&
            BigInt(l.data) === price,
        );
      }
      const left = until - Date.now();
      if (left <= 0) return null;
      await sleep(Math.min(1000, left));
    }
  }

  /**
   * Facilitators in order. A `success` is only a candidate: the caller reads the transfer back from the chain.
   * Before trying the next one the chain is checked, so an authorization that already landed is taken as settled.
   */
  async function viaFacilitators(a: Authorization, paymentPayload: unknown): Promise<string | null> {
    const start = await rpc.blockNumber().catch(() => 0);
    for (const base of facilitators) {
      let r: Partial<SettleResponse> | null = null;
      try {
        const res = await f(`${base}/settle`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: accept }),
          signal: AbortSignal.timeout(40_000),
        });
        r = (await res.json().catch(() => null)) as Partial<SettleResponse> | null;
      } catch {
        r = null;
      }
      const tx = typeof r?.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(r.transaction) ? r.transaction.toLowerCase() : null;
      if (r?.success && tx) return tx;
      if (tx && r?.errorReason === "settlement_pending") throw new SettlementPending(tx);
      if (await rpc.authorizationUsed(a.from, a.nonce).catch(() => false)) {
        for (let i = 0; i < 3; i++) {
          const h = await rpc.authorizationTx(a.from, a.nonce, start).catch(() => null);
          if (h) return h;
          await sleep(1500);
        }
        throw new Error("authorization was used on-chain but its transaction was not found yet");
      }
    }
    return null;
  }

  async function handle(request: Request, serve: () => Response | Promise<Response>): Promise<Response> {
    const resource = resourceOf(request.url);
    const deny = (error: string, message: string, headers: Record<string, string> = {}) => {
      const pr = { x402Version: 2, error, message, resource, accepts: [accept] };
      return new Response(JSON.stringify(pr), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64json(pr), "access-control-expose-headers": EXPOSE, ...headers },
      });
    };

    const header = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
    if (!header) return deny("payment_required", "Pay with the PAYMENT-SIGNATURE header: x402 v2, scheme exact, an EIP-3009 authorization for USDG on Robinhood Chain");
    const p = parsePayment(header);
    if (!p) return deny("invalid_payload", "PAYMENT-SIGNATURE must be base64 JSON with payload.signature and payload.authorization");
    if (p.version !== 2 && p.version !== 1) return deny("invalid_x402_version", "Use x402Version 2");
    if (p.scheme !== undefined && p.scheme !== "exact") return deny("invalid_scheme", 'Only the "exact" scheme is accepted');
    if (p.network !== undefined && p.network !== NETWORK) return deny("invalid_network", `Network must be ${NETWORK} (Robinhood Chain)`);
    if (p.asset !== undefined && p.asset.toLowerCase() !== USDG.toLowerCase()) return deny("invalid_payment_requirements", `Asset must be USDG (${USDG})`);

    const a = p.auth;
    const payer = a.from.toLowerCase();
    const key = `${payer}:${a.nonce}`;
    const prior = await store.get(key);
    let hash: string;

    if (prior) {
      // Only a retry of a settlement that was still confirming can be served, once.
      if (prior.status !== "pending" || !prior.tx || prior.resource !== resource.url) return deny("invalid_payload", "This authorization was already used");
      if (!(await transferIn(prior.tx, payer, 3000))) return deny("settlement_pending", "Settlement is still confirming. Retry shortly.");
      if (!(await store.claim(`${key}#served`, { status: "settled", resource: resource.url, tx: prior.tx }))) return deny("invalid_payload", "This authorization was already used");
      await store.set(key, { status: "settled", resource: resource.url, tx: prior.tx });
      hash = prior.tx;
    } else {
      const t = nowSec();
      if (a.to.toLowerCase() !== payTo.toLowerCase()) return deny("invalid_exact_evm_payload_recipient_mismatch", `authorization.to must be ${payTo}`);
      if (a.value !== price) return deny("invalid_exact_evm_payload_authorization_value_mismatch", `authorization.value must be exactly ${price}`);
      if (a.validAfter > BigInt(t)) return deny("invalid_exact_evm_payload_authorization_valid_after", "The authorization is not valid yet");
      if (a.validBefore < BigInt(t + 6)) return deny("invalid_exact_evm_payload_authorization_valid_before", "The authorization has expired");
      const signer = await recoverTypedDataAddress({
        domain: { name: USDG_EIP712.name, version: USDG_EIP712.version, chainId: CHAIN_ID, verifyingContract: USDG },
        types: TYPES,
        primaryType: "TransferWithAuthorization",
        message: a,
        signature: p.signature,
      }).catch(() => null);
      if (signer?.toLowerCase() !== payer) return deny("invalid_exact_evm_payload_signature", "The signature does not recover to authorization.from");
      let used: boolean;
      let balance: bigint;
      try {
        [used, balance] = await Promise.all([rpc.authorizationUsed(a.from, a.nonce), rpc.balanceOf(a.from)]);
      } catch {
        return deny("unexpected_verify_error", "Could not read Robinhood Chain to verify the payment. Retry shortly.");
      }
      if (used) return deny("invalid_payload", "This authorization nonce was already used on-chain");
      if (balance < a.value) return deny("insufficient_funds", "The payer holds less USDG than the price");
      if (!(await store.claim(key, { status: "settling", resource: resource.url }))) return deny("invalid_payload", "This authorization is already being settled");

      const payload = { x402Version: 2, resource, accepted: accept, payload: { signature: p.signature, authorization: authStrings(a) } };
      let settled: string | null;
      try {
        settled = await viaFacilitators(a, payload);
      } catch (e) {
        if (e instanceof SettlementPending) {
          await store.set(key, { status: "pending", resource: resource.url, tx: e.hash });
          return deny("settlement_pending", "Settlement was broadcast and is still confirming. Retry with the same payment shortly.", {
            "PAYMENT-RESPONSE": b64json({ success: false, errorReason: "settlement_pending", transaction: e.hash, network: NETWORK, payer }),
          });
        }
        settled = null;
      }
      if (!settled) {
        await store.delete(key);
        return deny("unexpected_settle_error", "No x402 facilitator could settle this payment right now. Retry shortly.");
      }
      // Serve only once the exact USDG transfer is on-chain, whoever submitted it.
      if (!(await transferIn(settled, payer, waitMs))) {
        await store.set(key, { status: "pending", resource: resource.url, tx: settled });
        return deny("settlement_pending", "Settlement was broadcast and is still confirming. Retry with the same payment shortly.", {
          "PAYMENT-RESPONSE": b64json({ success: false, errorReason: "settlement_pending", transaction: settled, network: NETWORK, payer }),
        });
      }
      await store.claim(`${key}#served`, { status: "settled", resource: resource.url, tx: settled });
      await store.set(key, { status: "settled", resource: resource.url, tx: settled });
      hash = settled;
    }

    const res = await serve();
    const out = new Response(res.body, res);
    const pr = b64json({ success: true, transaction: hash, network: NETWORK, payer });
    out.headers.set("PAYMENT-RESPONSE", pr);
    out.headers.set("X-PAYMENT-RESPONSE", pr);
    out.headers.set("access-control-expose-headers", EXPOSE);
    return out;
  }

  return { price, payTo, requirements, handle };
}

export type Paywall = ReturnType<typeof createPaywall>;
