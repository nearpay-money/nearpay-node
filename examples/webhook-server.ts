/**
 * Minimal webhook receiver (node:http, no framework): verify the raw body, then act on the event.
 *   NEARPAY_WEBHOOK_SECRET=whsec_… [NEARPAY_PREVIOUS_WEBHOOK_SECRET=whsec_… NEARPAY_PREVIOUS_SECRET_EXPIRES_AT=<unix>] \
 *   node --experimental-strip-types examples/webhook-server.ts
 * During a secret rotation keep the previous secret until `previous_secret_expires_at`.
 */
import { createServer } from "node:http";
import { NearPaySignatureVerificationError, type WebhookSecret, webhooks } from "../src/index.js";

const previous = process.env.NEARPAY_PREVIOUS_WEBHOOK_SECRET;
const secret: WebhookSecret = previous
  ? [
      process.env.NEARPAY_WEBHOOK_SECRET ?? "",
      { secret: previous, expiresAt: Number(process.env.NEARPAY_PREVIOUS_SECRET_EXPIRES_AT ?? 0) },
    ]
  : (process.env.NEARPAY_WEBHOOK_SECRET ?? "");

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      // verify the bytes exactly as received; never JSON.parse + JSON.stringify before verifying
      const event = webhooks.constructEvent(Buffer.concat(chunks), req.headers["nearpay-signature"], secret);
      switch (event.type) {
        case "payment_intent.succeeded":
          // data.object.sequence orders updates of one object: ignore events older than the last applied one
          console.log("paid", event.data.object.id, event.data.object.amount_settled);
          break;
        case "refund.succeeded":
          console.log("refunded", event.data.object.id, event.data.object.amount_received);
          break;
        default:
          // new event types arrive without a new API version: acknowledge what you do not handle
          break;
      }
      res.writeHead(200).end();
    } catch (e) {
      if (e instanceof NearPaySignatureVerificationError) res.writeHead(400).end(e.message);
      else res.writeHead(500).end();
    }
  });
}).listen(3000);
