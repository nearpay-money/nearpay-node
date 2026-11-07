/**
 * Refund a succeeded payment and sign its leg with the merchant's own NEAR key (non-custodial:
 * NearPay only relays what you sign). Test mode: `testHelpers.refunds.simulateDeposit` instead.
 *   NEARPAY_SECRET_KEY=sk_test_… PAYMENT_INTENT=pi_… node --experimental-strip-types examples/refund.ts
 */
import { type NearKeyPairLike, NearPay, NearPayError, NearPayRefundSigningError } from "../src/index.js";

const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY ?? "", {
  baseUrl: process.env.NEARPAY_API_URL ?? "https://api.nearpay.money",
});
// e.g. `KeyPair.fromString(process.env.NEAR_PRIVATE_KEY)` from near-api-js / @near-js/crypto
declare const merchantKeyPair: NearKeyPairLike;

try {
  const refund = await nearpay.refunds.create(
    { payment_intent: process.env.PAYMENT_INTENT ?? "", reason: "requested_by_customer" },
    { idempotencyKey: `refund-${process.env.PAYMENT_INTENT}` },
  );
  if (refund.next_action) console.log("about to sign:", refund.next_action.display);
  if (!nearpay.livemode) {
    await nearpay.testHelpers.refunds.simulateDeposit(refund.id);
  } else {
    const signer = nearpay.refunds.signers.nearKeyPair(merchantKeyPair);
    const pending = await nearpay.refunds.signers.signAndSubmit(refund.id, signer);
    console.log(pending.status); // "pending" until payer-side evidence → refund.succeeded webhook
  }
} catch (e) {
  if (e instanceof NearPayRefundSigningError) console.error("not signed:", e.code, e.message, e.txHash ?? "");
  else if (e instanceof NearPayError) console.error(e.type, e.code, e.message, e.requestId);
  else throw e;
}
