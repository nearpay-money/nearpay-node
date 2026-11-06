/**
 * Minimal webhook receiver (node:http, no framework): verify the raw body, then act on the event.
 *   NEARPAY_WEBHOOK_SECRET=whsec_… node --experimental-strip-types examples/webhook-server.ts
 */
import { createServer } from "node:http";
import { NearPaySignatureVerificationError, webhooks } from "../src/index.js";

const secret = process.env.NEARPAY_WEBHOOK_SECRET ?? "";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      // verify the bytes exactly as received; never JSON.parse + JSON.stringify before verifying
      const event = webhooks.constructEvent(Buffer.concat(chunks), req.headers["nearpay-signature"], secret);
      if (event.type === "payment_intent.succeeded") {
        // data.object.sequence orders updates of one object: ignore events older than the last applied one
        console.log("paid", event.data.object.id, event.data.object.amount_settled);
      }
      res.writeHead(200).end();
    } catch (e) {
      if (e instanceof NearPaySignatureVerificationError) res.writeHead(400).end(e.message);
      else res.writeHead(500).end();
    }
  });
}).listen(3000);
