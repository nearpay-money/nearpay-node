/**
 * Bill a test customer: product → price → tax rate → draft invoice → finalize → send → PDF.
 *   NEARPAY_SECRET_KEY=sk_test_… NEARPAY_API_URL=https://api.nearpay.localhost node --experimental-strip-types examples/invoice.ts
 */
import { writeFile } from "node:fs/promises";
import { NearPay, NearPayError } from "../src/index.js";

const nearpay = new NearPay(process.env.NEARPAY_SECRET_KEY ?? "", {
  baseUrl: process.env.NEARPAY_API_URL ?? "https://api.nearpay.money",
  appInfo: "nearpay-node-example/0.3",
});

try {
  const customer = await nearpay.customers.create({ email: "ada@example.com", name: "Ada Lovelace" });
  const product = await nearpay.products.create({ name: "Onboarding workshop" });
  const price = await nearpay.prices.create({ product: product.id, unit_amount: 25000, currency: "usd" });
  const vat = await nearpay.taxRates.create({ display_name: "VAT", percentage: "19", inclusive: false, country: "DE" });
  const draft = await nearpay.invoices.create({
    customer: customer.id,
    lines: [{ price: price.id }],
    default_tax_rates: [vat.id],
    days_until_due: 14,
    metadata: { order_id: "42" },
  });
  const invoice = await nearpay.invoices.finalize(draft.id);
  console.log(invoice.number, "total", invoice.total, invoice.currency, "due", invoice.due_date);
  await nearpay.invoices.send(invoice.id); // emails the hosted invoice link to the customer
  const pdf = await nearpay.invoices.pdf(invoice.id);
  await writeFile(pdf.filename ?? `${invoice.id}.pdf`, pdf);
  console.log("hosted invoice (share only with the customer):", invoice.hosted_invoice_url);
} catch (e) {
  if (e instanceof NearPayError) console.error(e.type, e.code, e.message, e.requestId);
  else throw e;
}
