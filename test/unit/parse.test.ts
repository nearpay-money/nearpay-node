import { Event, getEvent, getRefund, listEvents, listRefunds, type Refund } from "@nearpay/spec";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { describeIssues, isUnknownTypeEvent, parseTolerantBody } from "../../src/http/parse.js";
import { NearPay, NearPayResponseValidationError, type ValidationIssueReport } from "../../src/index.js";
import { event, ids, page, refund } from "../support/fixtures.js";
import { type SpecMock, startSpecMock } from "../support/spec-mock.js";

const KEY = "sk_test_parse0123456789";
let mock: SpecMock;

beforeAll(async () => {
  mock = await startSpecMock();
});
afterAll(() => mock.close());
afterEach(() => mock.reset());

/** Raw (unvalidated) replies, to send what a newer or broken server would. */
const raw = (body: unknown, status = 200) => ({ $status: status, $body: body });

describe("tolerant response parsing", () => {
  it("keeps unknown open-enum values and lists them on lastResponse", async () => {
    const np = new NearPay(KEY, { baseUrl: mock.url, responseValidation: "strict" });
    mock.on(getRefund, () => raw({ ...refund(), status: "on_hold", source: "partner_api" }));
    const r = await np.refunds.retrieve(ids.re);
    expect(r.status as string).toBe("on_hold");
    expect(r.lastResponse?.unknownEnumValues).toEqual([
      { path: ["status"], value: "on_hold" },
      { path: ["source"], value: "partner_api" },
    ]);
    expect(r.lastResponse?.validationIssues).toEqual([]);
  });

  it("keeps unknown fields (loose objects) and applies nothing else", async () => {
    const np = new NearPay(KEY, { baseUrl: mock.url, responseValidation: "strict" });
    mock.on(getRefund, () => raw({ ...refund(), brand_new_field: { x: 1 } }));
    const r = (await np.refunds.retrieve(ids.re)) as Refund & { brand_new_field?: unknown };
    expect(r.brand_new_field).toEqual({ x: 1 });
  });

  it("accepts events of types this SDK does not know (single and inside a page)", async () => {
    const np = new NearPay(KEY, { baseUrl: mock.url, responseValidation: "strict" });
    const known = event("refund.succeeded", refund({ status: "succeeded" }));
    const future = { ...known, type: "invoice.paid", data: { object: { id: "in_1", object: "invoice" } } };
    mock.on(getEvent, () => raw(future));
    mock.on(listEvents, () => raw(page("/v1/events", [known, future])));
    const one = await np.events.retrieve(ids.evt);
    expect(one.type as string).toBe("invoice.paid");
    expect(one.lastResponse?.unknownEnumValues).toEqual([{ path: ["type"], value: "invoice.paid" }]);
    const list = await np.events.list();
    expect(list.data.map((e) => e.type as string)).toEqual(["refund.succeeded", "invoice.paid"]);
    expect(list.lastResponse?.unknownEnumValues).toEqual([{ path: ["data", 1, "type"], value: "invoice.paid" }]);
  });

  it("strict mode throws a NearPayResponseValidationError with the idempotency key", async () => {
    const np = new NearPay(KEY, { baseUrl: mock.url, responseValidation: "strict", maxRetries: 0 });
    mock.on(getRefund, () => raw({ ...refund(), object: "refund_v2", amount: 12 }));
    const e = await np.refunds.retrieve(ids.re).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NearPayResponseValidationError);
    const err = e as NearPayResponseValidationError;
    expect(err.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["object", "amount"]));
    expect(err.type).toBe("response_validation_error");
    expect(err.statusCode).toBe(200);
    expect(err.raw).toMatchObject({ object: "refund_v2" });
    expect(err.idempotencyKey).toBeUndefined();
  });

  it("strict mode reports a broken item of a page, and a broken page envelope", async () => {
    const np = new NearPay(KEY, { baseUrl: mock.url, responseValidation: "strict", maxRetries: 0 });
    const future = { ...event("ping", { object: "ping", webhook_endpoint: ids.we }), type: "x.y", created: "soon" };
    mock.on(listEvents, () => raw(page("/v1/events", [future])));
    const e = (await np.events.list().catch((x: unknown) => x)) as NearPayResponseValidationError;
    expect(e.issues[0]?.path).toEqual(["data", 0, "created"]);
    mock.on(listRefunds, () => raw({ ...page("/v1/refunds", [refund()]), has_more: "no" }));
    const e2 = (await np.refunds.list().catch((x: unknown) => x)) as NearPayResponseValidationError;
    expect(e2.issues[0]?.path).toEqual(["has_more"]);
    mock.on(listRefunds, () => raw({ ...page("/v1/refunds", [{ ...refund(), amount: 5 }]) }));
    const e3 = (await np.refunds.list().catch((x: unknown) => x)) as NearPayResponseValidationError;
    expect(e3.issues[0]?.path).toEqual(["data", 0, "amount"]);
  });

  it("tolerant mode (default) returns the body as received and reports it once per route", async () => {
    const reports: ValidationIssueReport[] = [];
    const np = new NearPay(KEY, { baseUrl: mock.url, onValidationIssue: (r) => reports.push(r) });
    mock.on(getRefund, () => raw({ ...refund(), amount: 12 }));
    const r = await np.refunds.retrieve(ids.re);
    expect(r.amount as unknown).toBe(12);
    expect(r.lastResponse?.validationIssues[0]?.path).toEqual(["amount"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ routeId: "getRefund", statusCode: 200 });

    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const quiet = new NearPay(KEY, { baseUrl: mock.url });
    await quiet.refunds.retrieve(ids.re);
    await quiet.refunds.retrieve(ids.re);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/getRefund does not match @nearpay\/spec/);
    warn.mockRestore();
  });

  it("off mode skips parsing entirely", async () => {
    const np = new NearPay(KEY, { baseUrl: mock.url, responseValidation: "off" });
    mock.on(getRefund, () => raw({ ...refund(), amount: 12 }));
    const r = await np.refunds.retrieve(ids.re);
    expect(r.lastResponse?.validationIssues).toEqual([]);
    expect(r.lastResponse?.unknownEnumValues).toEqual([]);
  });

  it("rejects an unknown validation mode", () => {
    expect(() => new NearPay(KEY, { responseValidation: "lenient" as "off" })).toThrow(/responseValidation/);
  });
});

describe("parse helpers", () => {
  it("isUnknownTypeEvent / describeIssues / non-object bodies", () => {
    expect(isUnknownTypeEvent({ object: "event", type: "refund.succeeded" })).toBe(false);
    expect(isUnknownTypeEvent({ object: "event", type: "brand.new" })).toBe(true);
    expect(isUnknownTypeEvent({ object: "refund", type: "x" })).toBe(false);
    expect(isUnknownTypeEvent(null)).toBe(false);
    const issues = [1, 2, 3, 4, 5].map((n) => ({ path: [`f${n}`], message: "bad", code: "custom" }));
    expect(describeIssues(issues)).toBe("f1: bad; f2: bad; f3: bad; and 2 more");
    expect(describeIssues([{ path: [], message: "bad", code: "custom" }])).toBe("(root): bad");
    expect(parseTolerantBody(Event, "text").ok).toBe(false);
    const broken = parseTolerantBody(Event, { object: "event", type: "brand.new", data: 1 });
    expect(broken.ok).toBe(false);
  });
});
