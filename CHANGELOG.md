# Changelog

## v0.3.0 · 2026-11-24

- New `verifyPayment(tx, { payTo?, amount? })`: checks a payment on Robinhood Chain without trusting RailPay. It reads the receipt and block from a JSON-RPC node (publicnode by default) and returns the payer, recipient, amount, the EIP-3009 authorization nonce, who paid the gas, the block and its time, plus `ok` and a `reason` when it fails (`not_found`, `reverted`, `no_transfer`, `pay_to_mismatch`, `amount_mismatch`). Works in Node and in the browser.
- README: "Verify a payment on chain", with the first settled x402 payment as the example.

## v0.2.0 · 2026-11-23

- `config()` now returns a typed `RailPayConfig` instead of `Record<string, unknown>`. Unknown fields are kept, so existing code keeps working.
- New `TreasuryReceipt` type for `config().settlements.treasury_receipts`: x402 payments settled on-chain to the RailPay treasury, with `tx`, `block` and `payer_is_team`.
- `config()` also exposes `gas_note` (x402 gas is paid by the facilitator, the relayer is only for agent-to-agent sends and withdrawals) and `token` ($RPAY address and its role in the product).
- README: how to check a settled payment, install from the v0.2.0 tarball.

## v0.1.0 · 2026-11-21

First release.

- `RailPay` client for the RailPay API on Robinhood Chain (chain id 4663): `me()`, `pay()`, `send()`, `config()`, `stats()`, `request()`.
- `withPayment(client)`: a `fetch` that answers an x402 v2 `402 Payment Required` from a RailPay agent wallet and retries with `PAYMENT-SIGNATURE`. `maxAmount` caps each payment on top of the agent's policy.
- `createPaywall()`: charge USDG for your own API. It returns the 402, checks the EIP-3009 authorization (recipient, amount, validity window, nonce, signature, balance), settles it through keyless x402 facilitators (Toll, then Primer) that pay the gas, and serves the response only after the exact USDG transfer is in the receipt.
- Helpers for units, x402 headers and Robinhood Chain constants (USDG, EIP-712 domain, facilitators, explorer).
- `stats()` needs an account key: network stats are for signed-in accounts.
