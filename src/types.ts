/**
 * Object types the spec exports only as schemas, derived here (never hand-written).
 */
import type {
  CreatedPaymentIntent as CreatedPaymentIntentSchema,
  DeletedCustomer as DeletedCustomerSchema,
  DeletedInvoice as DeletedInvoiceSchema,
  EventResend as EventResendSchema,
  InvoiceLineItem as InvoiceLineItemSchema,
  SubscriptionItem as SubscriptionItemSchema,
  TestHelperPayment as TestHelperPaymentSchema,
  WebhookDelivery as WebhookDeliverySchema,
  WebhookEndpoint as WebhookEndpointSchema,
} from "@nearpay/spec";
import type { z } from "zod";

/** One event's delivery to one endpoint (`whd_…`), from `webhookEndpoints.listDeliveries`. */
export type WebhookDelivery = z.output<typeof WebhookDeliverySchema>;
/** A webhook endpoint (`we_…`); `secret` only on create and `rotateSecret`. */
export type WebhookEndpoint = z.output<typeof WebhookEndpointSchema>;
/** `paymentIntents.create` result: the intent with the headless session's `client_secret` (returned once). */
export type CreatedPaymentIntent = z.output<typeof CreatedPaymentIntentSchema>;
/** `customers.del` result. */
export type DeletedCustomer = z.output<typeof DeletedCustomerSchema>;
/** `events.resend` result: the deliveries queued. */
export type EventResend = z.output<typeof EventResendSchema>;
/** `invoices.del` result (drafts only). */
export type DeletedInvoice = z.output<typeof DeletedInvoiceSchema>;
/** One line of an invoice (`il_…`). */
export type InvoiceLineItem = z.output<typeof InvoiceLineItemSchema>;
/** One recurring price of a subscription (`si_…`). */
export type SubscriptionItem = z.output<typeof SubscriptionItemSchema>;
/** `testHelpers.checkoutSessions.pay` result: the sandbox payment it started (events follow). */
export type TestHelperPayment = z.output<typeof TestHelperPaymentSchema>;
