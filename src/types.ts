/**
 * Object types the spec exports only as schemas, derived here (never hand-written).
 */
import type {
  CreatedPaymentIntent as CreatedPaymentIntentSchema,
  DeletedCustomer as DeletedCustomerSchema,
  EventResend as EventResendSchema,
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
