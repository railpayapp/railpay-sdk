import { getAddress, isAddress, toEventSelector } from "viem";

import { DEFAULT_RPC_URL, USDG, USDG_DECIMALS, txUrl } from "./constants.js";
import { fromUnits, toUnits } from "./encoding.js";

const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const AUTHORIZATION_USED_TOPIC = toEventSelector("AuthorizationUsed(address,bytes32)");

export type VerifyOptions = {
  /** Expected recipient. When set, `ok` needs a transfer to this address. */
  payTo?: string;
  /** Expected amount: USDG decimal string ("0.002") or base units (bigint). Exact match, like the x402 `exact` scheme. */
  amount?: string | bigint;
  /** Token contract. Default: USDG on Robinhood Chain. */
  asset?: string;
  /** Robinhood Chain JSON-RPC. Default: publicnode. RailPay's own API is never called. */
  rpcUrl?: string;
  fetch?: typeof fetch;
};

export type VerifyReason = "not_found" | "reverted" | "no_transfer" | "pay_to_mismatch" | "amount_mismatch";

export type PaymentTransfer = { from: string; to: string; amount: string; amount_raw: string; log_index: number };

/** What the chain says about one payment transaction. */
export type VerifiedPayment = {
  /** The transaction succeeded, it moved the token, and every expectation you passed matched. */
  ok: boolean;
  reason: VerifyReason | null;
  tx: string;
  block: number | null;
  /** ISO time of the block. */
  settled_at: string | null;
  asset: string;
  payer: string | null;
  pay_to: string | null;
  /** Decimal string, e.g. "0.002". */
  amount: string | null;
  amount_raw: string | null;
  /** Set when the payer's EIP-3009 authorization was used in this transaction (how x402 `exact` settles). */
  authorization: { nonce: string } | null;
  /** The account that sent the transaction and paid the gas. For x402 this is the facilitator, not the payer. */
  gas_payer: string | null;
  gas_used: number | null;
  explorer: string;
  /** Every transfer of the token in the transaction. */
  transfers: PaymentTransfer[];
  /** `null` when you did not pass that expectation. */
  checks: { succeeded: boolean; transfer: boolean; pay_to: boolean | null; amount: boolean | null; authorization: boolean };
};

type Log = { address: string; topics: string[]; data: string; logIndex: string };
type Receipt = { status: string; blockNumber: string; from: string; gasUsed: string; logs: Log[] };

const word = (topic: string) => getAddress(`0x${topic.slice(-40)}`);

/**
 * Check a payment on Robinhood Chain without trusting RailPay: reads the receipt and block straight from a
 * JSON-RPC node and decodes the token transfer and the EIP-3009 authorization. Works in Node and in the browser.
 */
export async function verifyPayment(tx: string, options: VerifyOptions = {}): Promise<VerifiedPayment> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new TypeError("tx must be a 32-byte hex transaction hash");
  if (options.payTo !== undefined && !isAddress(options.payTo)) throw new TypeError("payTo must be an address");
  const hash = tx.toLowerCase();
  const asset = getAddress(options.asset ?? USDG);
  const f = options.fetch ?? fetch;
  const url = options.rpcUrl ?? DEFAULT_RPC_URL;
  const want = options.amount === undefined ? null : typeof options.amount === "bigint" ? options.amount : toUnits(options.amount);

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

  const empty: VerifiedPayment = {
    ok: false,
    reason: "not_found",
    tx: hash,
    block: null,
    settled_at: null,
    asset,
    payer: null,
    pay_to: null,
    amount: null,
    amount_raw: null,
    authorization: null,
    gas_payer: null,
    gas_used: null,
    explorer: txUrl(hash),
    transfers: [],
    checks: { succeeded: false, transfer: false, pay_to: options.payTo ? false : null, amount: want === null ? null : false, authorization: false },
  };

  const receipt = await call<Receipt | null>("eth_getTransactionReceipt", [hash]);
  if (!receipt) return empty;

  const blockHex = receipt.blockNumber;
  const block = await call<{ timestamp: string } | null>("eth_getBlockByNumber", [blockHex, false]);
  const succeeded = receipt.status === "0x1";
  const mine = receipt.logs.filter((l) => l.address.toLowerCase() === asset.toLowerCase());

  const transfers: PaymentTransfer[] = mine
    .flatMap((l) => {
      const [topic, from, to] = l.topics;
      if (topic?.toLowerCase() !== TRANSFER_TOPIC || !from || !to || l.topics.length !== 3) return [];
      const raw = BigInt(l.data === "0x" ? 0 : l.data);
      return { from: word(from), to: word(to), amount: fromUnits(raw, USDG_DECIMALS), amount_raw: raw.toString(), log_index: Number(BigInt(l.logIndex)) };
    });

  const payTo = options.payTo ? getAddress(options.payTo) : null;
  const main = (payTo ? transfers.find((t) => t.to === payTo) : undefined) ?? transfers[0] ?? null;

  const usedNonce = main
    ? mine.flatMap((l) => {
        const [topic, authorizer, nonce] = l.topics;
        return topic?.toLowerCase() === AUTHORIZATION_USED_TOPIC && authorizer && nonce && word(authorizer) === main.from ? [nonce.toLowerCase()] : [];
      })[0]
    : undefined;

  const checks = {
    succeeded,
    transfer: succeeded && main !== null,
    pay_to: payTo ? main?.to === payTo : null,
    amount: want === null ? null : main !== null && BigInt(main.amount_raw) === want,
    authorization: usedNonce !== undefined,
  };

  const reason: VerifyReason | null = !succeeded
    ? "reverted"
    : !main
      ? "no_transfer"
      : checks.pay_to === false
        ? "pay_to_mismatch"
        : checks.amount === false
          ? "amount_mismatch"
          : null;

  return {
    ok: reason === null,
    reason,
    tx: hash,
    block: Number(BigInt(blockHex)),
    settled_at: block ? new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() : null,
    asset,
    payer: main?.from ?? null,
    pay_to: main?.to ?? null,
    amount: main?.amount ?? null,
    amount_raw: main?.amount_raw ?? null,
    authorization: usedNonce ? { nonce: usedNonce } : null,
    gas_payer: getAddress(receipt.from),
    gas_used: Number(BigInt(receipt.gasUsed)),
    explorer: txUrl(hash),
    transfers,
    checks,
  };
}
