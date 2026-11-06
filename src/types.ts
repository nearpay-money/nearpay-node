/**
 * Object types the spec exports only as schemas, derived here (never hand-written).
 * `sequence` (spec 0.1.5) needs nothing here: `CheckoutSession` and `AgentPayment` carry it from the spec.
 */
import type { WebhookDelivery as WebhookDeliverySchema } from "@nearpay/spec";
import type { z } from "zod";

/** One event's delivery to one endpoint (`whd_…`), from `webhookEndpoints.listDeliveries`. */
export type WebhookDelivery = z.output<typeof WebhookDeliverySchema>;
