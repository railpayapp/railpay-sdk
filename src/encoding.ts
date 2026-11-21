import { USDG_DECIMALS } from "./constants.js";

/** Base64 of the UTF-8 JSON of a value (the encoding x402 uses in headers). */
export function b64json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode {@link b64json}. Throws on invalid base64 or JSON. */
export function unb64json<T = unknown>(value: string): T {
  const bin = atob(value.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** "1.5" → 1500000n (USDG base units). Accepts a non-negative decimal with at most `decimals` places. */
export function toUnits(amount: string | number, decimals = USDG_DECIMALS): bigint {
  const s = typeof amount === "number" ? String(amount) : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`Not a decimal amount: ${JSON.stringify(amount)}`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`At most ${decimals} decimals: ${s}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 1500000n → "1.5". */
export function fromUnits(units: bigint | number | string, decimals = USDG_DECIMALS): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
