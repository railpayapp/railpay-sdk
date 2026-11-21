/** Robinhood Chain mainnet. */
export const CHAIN_ID = 4663;
/** CAIP-2 network id used in x402 v2 requirements. */
export const NETWORK = "eip155:4663";
/** USDG (Global Dollar) on Robinhood Chain. */
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const USDG_DECIMALS = 6;
/** EIP-712 domain name and version of the USDG contract (EIP-3009 signatures). */
export const USDG_EIP712 = { name: "Global Dollar", version: "1" } as const;

export const DEFAULT_BASE_URL = "https://dapp.railpay.app";
export const DEFAULT_RPC_URL = "https://robinhood-rpc.publicnode.com";
/**
 * Outside x402 facilitators that settle USDG on Robinhood Chain and pay the gas, tried in order.
 * They are third-party services; RailPay does not run them.
 */
export const DEFAULT_FACILITATORS: readonly string[] = ["https://x402.t0ll.xyz", "https://x402.primer.systems"];
/** Smallest x402 price in USDG base units (0.001 USDG), the floor the default facilitators settle. */
export const MIN_X402_AMOUNT = 1000n;

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;
