import { NETWORK, USDG } from "./constants.js";
import { unb64json } from "./encoding.js";

/** One way to pay, from an x402 `accepts` list. */
export type PaymentRequirements = {
  scheme: string;
  network: string;
  /** Price in base units (x402 v2). */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; assetTransferMethod?: string; [key: string]: unknown };
  /** x402 v1 name for the price. */
  maxAmountRequired?: string;
  resource?: string;
};

export type ResourceInfo = { url: string; description?: string; mimeType?: string };

/** The 402 answer: PAYMENT-REQUIRED header (base64 JSON) and body. */
export type PaymentRequired = {
  x402Version: number;
  error?: string;
  message?: string;
  resource?: ResourceInfo;
  accepts: PaymentRequirements[];
};

/** EIP-3009 TransferWithAuthorization fields, as decimal / hex strings. */
export type AuthorizationFields = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

/** What goes (base64) in the PAYMENT-SIGNATURE header of the retry. */
export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: AuthorizationFields };
};

/** PAYMENT-RESPONSE header, and a facilitator's /settle answer. */
export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction: string;
  network: string;
  payer?: string | null;
};

/** True for requirements a RailPay agent can pay: exact scheme, Robinhood Chain, USDG, EIP-3009. */
export function isRailPayPayable(req: PaymentRequirements | undefined | null): req is PaymentRequirements {
  return (
    !!req &&
    req.scheme === "exact" &&
    req.network === NETWORK &&
    typeof req.asset === "string" &&
    req.asset.toLowerCase() === USDG.toLowerCase() &&
    (!req.extra?.assetTransferMethod || req.extra.assetTransferMethod === "eip3009")
  );
}

/** Price of a requirement in base units (v2 `amount`, or v1 `maxAmountRequired`). */
export function requirementAmount(req: PaymentRequirements): bigint {
  const raw = req.amount ?? req.maxAmountRequired ?? "";
  if (!/^\d{1,30}$/.test(raw)) throw new RangeError(`Invalid requirement amount: ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

/** Read the payment requirement from a 402 response: the PAYMENT-REQUIRED header, else the JSON body. */
export async function readPaymentRequired(res: Response): Promise<PaymentRequired | null> {
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      const pr = unb64json<PaymentRequired>(header);
      if (Array.isArray(pr?.accepts)) return pr;
    } catch {
      // fall through to the body
    }
  }
  try {
    const body = (await res.clone().json()) as PaymentRequired;
    return Array.isArray(body?.accepts) ? body : null;
  } catch {
    return null;
  }
}

/** Decode the PAYMENT-RESPONSE (or X-PAYMENT-RESPONSE) header of a paid response. */
export function readPaymentResponse(res: Response): SettleResponse | null {
  const header = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!header) return null;
  try {
    return unb64json<SettleResponse>(header);
  } catch {
    return null;
  }
}
