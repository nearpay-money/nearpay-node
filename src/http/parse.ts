/**
 * Tolerant response parsing (lld/sdks-and-tools.md §1, foundations §3, api-conventions §5).
 *
 * Every response is parsed with the route's spec schema through `safeParseTolerant`: an unknown
 * value of an **open** enum (a new status, a new error code) is accepted and kept verbatim, and so
 * is an event whose `type` this SDK's spec version does not know yet (new event types ship without
 * a new API version) — it is checked against the type-agnostic `EventEnvelopeLoose` instead.
 * Closed enums, literals, missing fields and wrong types are contract violations.
 *
 * What happens on a violation is the client's `responseValidation` mode:
 * - `"tolerant"` (default): the body is returned as received and the issues are reported
 *   (`lastResponse.validationIssues`, `onValidationIssue`). A 2xx from a write already changed
 *   state on the server, so throwing here would invite a duplicate retry with a new key.
 * - `"strict"`: a `NearPayResponseValidationError` is thrown (it carries the `idempotencyKey`;
 *   retry with it to get the stored response instead of a second write).
 * - `"off"`: no parsing at all (0.1.x behaviour).
 */
import { EventEnvelopeLoose, safeParseTolerant, type UnknownEnumValue, WEBHOOK_TYPES } from "@nearpay-money/spec";
import { z } from "zod";

export type ResponseValidation = "tolerant" | "strict" | "off";

/** A field that does not match the spec (path within the parsed body, and why). */
export interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code: string;
}

export type ParseOutcome =
  | { readonly ok: true; readonly data: unknown; readonly unknown: readonly UnknownEnumValue[] }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

function issuesOf(error: z.ZodError, prefix: readonly PropertyKey[] = []): ValidationIssue[] {
  return error.issues.map((i) => ({ path: [...prefix, ...i.path], message: i.message, code: i.code }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An event object whose `type` is not one of the webhook types of this spec version. */
export function isUnknownTypeEvent(v: unknown): boolean {
  return isRecord(v) && v.object === "event" && typeof v.type === "string" && !Object.hasOwn(WEBHOOK_TYPES, v.type);
}

function parseItem(schema: z.ZodType, value: unknown, path: readonly PropertyKey[]): ParseOutcome {
  if (isUnknownTypeEvent(value)) {
    const r = EventEnvelopeLoose.safeParse(value);
    return r.success
      ? { ok: true, data: r.data, unknown: [{ path: [...path, "type"], value: (value as { type: string }).type }] }
      : { ok: false, issues: issuesOf(r.error, path) };
  }
  const r = safeParseTolerant(schema, value);
  return r.success
    ? { ok: true, data: r.data, unknown: r.unknown.map((u) => ({ path: [...path, ...u.path], value: u.value })) }
    : { ok: false, issues: issuesOf(r.error, path) };
}

/** The item schema of a `listOf(...)` response, if `schema` is one. */
export function listItemSchema(schema: z.ZodType): z.ZodType | undefined {
  if (!(schema instanceof z.ZodObject)) return undefined;
  const shape = schema.shape as Record<string, z.ZodType>;
  const object = shape.object;
  const data = shape.data;
  if (!(object instanceof z.ZodLiteral) || !object.values.has("list")) return undefined;
  return data instanceof z.ZodArray ? (data.element as z.ZodType) : undefined;
}

/**
 * Parses `body` with `schema`, tolerating unknown open-enum values and unknown event types
 * (also inside list pages). Never throws; never mutates `body`.
 */
export function parseTolerantBody(schema: z.ZodType, body: unknown): ParseOutcome {
  const whole = parseItem(schema, body, []);
  if (whole.ok) return whole;
  // A page may hold events of types this SDK does not know: check the envelope, then each item.
  const item = listItemSchema(schema);
  if (!item || !isRecord(body) || !Array.isArray(body.data)) return whole;
  const envelope = safeParseTolerant(schema, { ...body, data: [] });
  if (!envelope.success) return { ok: false, issues: issuesOf(envelope.error) };
  const data: unknown[] = [];
  const unknown: UnknownEnumValue[] = [...envelope.unknown];
  const issues: ValidationIssue[] = [];
  body.data.forEach((v, i) => {
    const r = parseItem(item, v, ["data", i]);
    if (r.ok) {
      data.push(r.data);
      unknown.push(...r.unknown);
    } else issues.push(...r.issues);
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: { ...(envelope.data as Record<string, unknown>), data }, unknown };
}

/** Formats issues for messages and warnings (first three). */
export function describeIssues(issues: readonly ValidationIssue[]): string {
  const shown = issues
    .slice(0, 3)
    .map((i) => `${i.path.length ? i.path.map(String).join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  return issues.length > 3 ? `${shown}; and ${issues.length - 3} more` : shown;
}
