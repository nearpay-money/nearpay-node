/**
 * Create a test checkout session and follow its payment intent.
 *   NEARPAY_SECRET_KEY=sk_test_… NEARPAY_API_URL=https://api.nearpay.localhost node --experimental-strip-types examples/checkout.ts
 */
import { NearPay, NearPayError } from "../src/index.js";

const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY ?? "", {
  baseUrl: process.env.NEARPAY_API_URL ?? "https://api.nearpay.money",
  appInfo: "nearpay-node-example/0.1",
});

try {
  const session = await nearpay.checkout.sessions.create(
    { amount: 200, currency: "usd", success_url: "https://shop.example/thanks", description: "Coffee" },
    { idempotencyKey: `order-${Date.now()}` },
  );
  console.log("pay at", session.url);
  const intent = await nearpay.paymentIntents.retrieve(String(session.payment_intent));
  console.log(intent.status, intent.amount, intent.currency);
} catch (e) {
  if (e instanceof NearPayError) console.error(e.type, e.code, e.message, e.requestId);
  else throw e;
}
