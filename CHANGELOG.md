# Changelog

## v0.1.0 · 2026-11-21

First release.

- `RailPay` client for the RailPay API on Robinhood Chain (chain id 4663): `me()`, `pay()`, `send()`, `config()`, `stats()`, `request()`.
- `withPayment(client)`: a `fetch` that answers an x402 v2 `402 Payment Required` from a RailPay agent wallet and retries with `PAYMENT-SIGNATURE`. `maxAmount` caps each payment on top of the agent's policy.
- `createPaywall()`: charge USDG for your own API. It returns the 402, checks the EIP-3009 authorization (recipient, amount, validity window, nonce, signature, balance), settles it through keyless x402 facilitators (Toll, then Primer) that pay the gas, and serves the response only after the exact USDG transfer is in the receipt.
- Helpers for units, x402 headers and Robinhood Chain constants (USDG, EIP-712 domain, facilitators, explorer).
- `stats()` needs an account key: network stats are for signed-in accounts.
