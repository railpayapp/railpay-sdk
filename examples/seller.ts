// Charge 0.01 USDG per request on any Fetch API runtime: Cloudflare Workers, Bun, Deno.
// With Hono: app.get("/report", (c) => paywall.handle(c.req.raw, () => c.json(report())))
import { createPaywall } from "railpay-sdk";

const paywall = createPaywall({
  payTo: "0x000000000000000000000000000000000000dEaD", // your wallet
  price: "0.01",
  description: "Daily market report",
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/report") return new Response("Not found", { status: 404 });
    return paywall.handle(request, () => Response.json({ report: "…", at: new Date().toISOString() }));
  },
};
