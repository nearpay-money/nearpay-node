/**
 * Print live test-mode events (what `nearpay listen` does, without forwarding). Stop with Ctrl-C.
 *   NEARPAY_SECRET_KEY=sk_test_… NEARPAY_API_URL=https://api.nearpay.localhost node --experimental-strip-types examples/listen.ts invoice.paid
 */
import { NearPay } from "../src/index.js";

const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY ?? "", {
  baseUrl: process.env.NEARPAY_API_URL ?? "https://api.nearpay.money",
});
const types = process.argv.slice(2);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const stream = nearpay.events.stream(types.length ? { types } : {}, {
  signal: stop.signal,
  onReady: (r) => console.log(`listening (${r.types.join(",")}) until ${new Date(r.expires_at * 1000).toISOString()}`),
  onReset: (r) => console.warn(`could not resume after ${r.cursor} (${String(r.reason)}); live only`),
  onReconnect: (r) => console.warn(`reconnecting in ${r.delayMs} ms${r.error ? `: ${r.error.message}` : ""}`),
});
for await (const event of stream) {
  const object = event.data.object as { id?: string };
  console.log(String(event.created), event.type, String(event.id), object.id ?? "");
}
