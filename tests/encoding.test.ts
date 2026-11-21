import { describe, expect, it } from "vitest";

import { b64json, fromUnits, toUnits, unb64json } from "../src/index.js";

describe("encoding", () => {
  it("round-trips UTF-8 JSON through base64", () => {
    const v = { x402Version: 2, note: "Settlement — ✓ 日本", n: [1, 2] };
    expect(unb64json(b64json(v))).toEqual(v);
  });

  it("matches Node's base64 for ASCII", () => {
    const v = { a: "b" };
    expect(b64json(v)).toBe(Buffer.from(JSON.stringify(v)).toString("base64"));
  });

  it("converts USDG decimals to base units", () => {
    expect(toUnits("1.5")).toBe(1_500_000n);
    expect(toUnits("0.001")).toBe(1_000n);
    expect(toUnits("2")).toBe(2_000_000n);
    expect(toUnits(0.25)).toBe(250_000n);
    expect(toUnits("0.000001")).toBe(1n);
  });

  it("rejects invalid amounts", () => {
    expect(() => toUnits("1.0000001")).toThrow(RangeError);
    expect(() => toUnits("-1")).toThrow(RangeError);
    expect(() => toUnits("1e3")).toThrow(RangeError);
    expect(() => toUnits("")).toThrow(RangeError);
  });

  it("formats base units", () => {
    expect(fromUnits(1_500_000n)).toBe("1.5");
    expect(fromUnits(1_000)).toBe("0.001");
    expect(fromUnits("2000000")).toBe("2");
    expect(fromUnits(0n)).toBe("0");
  });
});
