import { paymentIntent } from "@nearpay-internal/testing";
import { listAssets, listEvents, listPaymentIntents, listWebhookEndpointDeliveries } from "@nearpay-money/spec";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { AUTO_PAGING_MAX, NearPay, NearPayApiError, type PaymentIntent } from "../../src/index.js";
import { delivery, event, idN, ids, page, USDC_NEAR } from "../support/fixtures.js";
import { MockApiError, type SpecMock, startSpecMock } from "../support/spec-mock.js";

const KEY = "sk_test_pagination0123456789";
let mock: SpecMock;
let np: NearPay;

/** 7 intents, newest first; pages honour limit / starting_after / ending_before like the API. */
const all = Array.from({ length: 7 }, (_, i) => paymentIntent({ id: idN("pi", i) as `pi_${string}` }));
function serve(q: { limit?: number; starting_after?: string; ending_before?: string }) {
  const limit = q.limit ?? 10;
  if (q.ending_before) {
    const end = all.findIndex((p) => p.id === q.ending_before);
    const start = Math.max(0, end - limit);
    return page("/v1/payment_intents", all.slice(start, end), start > 0);
  }
  const from = q.starting_after ? all.findIndex((p) => p.id === q.starting_after) + 1 : 0;
  return page("/v1/payment_intents", all.slice(from, from + limit), from + limit < all.length);
}

beforeAll(async () => {
  mock = await startSpecMock();
  np = new NearPay(KEY, { baseUrl: mock.url, maxRetries: 0, responseValidation: "strict" });
});
afterAll(() => mock.close());
afterEach(() => {
  expect(mock.violations).toEqual([]);
  mock.reset();
});

describe("auto-pagination", () => {
  it("awaiting a list gives one page; iterating walks every page with starting_after, keeping filters", async () => {
    mock.on(listPaymentIntents, (r) => serve(r.query));
    const first = await np.paymentIntents.list({ limit: 3, status: "succeeded", metadata: { order: "1" } });
    expect(first.data).toHaveLength(3);
    expect(first.has_more).toBe(true);
    mock.calls.splice(0);
    const seen: string[] = [];
    for await (const pi of np.paymentIntents.list({ limit: 3, status: "succeeded", metadata: { order: "1" } })) {
      expectTypeOf(pi).toEqualTypeOf<PaymentIntent>();
      seen.push(pi.id);
    }
    expect(seen).toEqual(all.map((p) => p.id));
    const queries = mock.callsTo(listPaymentIntents).map((c) => c.query as Record<string, unknown>);
    expect(queries).toHaveLength(3);
    expect(queries[1]).toMatchObject({
      limit: 3,
      status: "succeeded",
      starting_after: all[2]?.id,
      "metadata[order]": "1",
    });
    expect(queries[2]).toMatchObject({ starting_after: all[5]?.id });
  });

  it("autoPagingToArray stops at the limit without fetching further pages", async () => {
    mock.on(listPaymentIntents, (r) => serve(r.query));
    const got = await np.paymentIntents.list({ limit: 2 }).autoPagingToArray({ limit: 3 });
    expect(got.map((p) => p.id)).toEqual(all.slice(0, 3).map((p) => p.id));
    expect(mock.callsTo(listPaymentIntents)).toHaveLength(2);
    await expect(np.paymentIntents.list().autoPagingToArray({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(np.paymentIntents.list().autoPagingToArray({ limit: AUTO_PAGING_MAX + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(np.paymentIntents.list().autoPagingToArray(undefined as unknown as { limit: number })).rejects.toThrow(
      RangeError,
    );
  });

  it("autoPagingEach stops when the callback returns false (async callbacks awaited)", async () => {
    mock.on(listPaymentIntents, (r) => serve(r.query));
    const seen: string[] = [];
    await np.paymentIntents.list({ limit: 2 }).autoPagingEach(async (pi) => {
      seen.push(pi.id);
      return seen.length < 3;
    });
    expect(seen).toHaveLength(3);
  });

  it("paginates backwards from ending_before", async () => {
    mock.on(listPaymentIntents, (r) => serve(r.query));
    const ids2 = await np.paymentIntents.list({ limit: 2, ending_before: all[6]?.id }).autoPagingToArray({ limit: 10 });
    expect(ids2.map((p) => p.id)).toEqual([all[4], all[5], all[2], all[3], all[0], all[1]].map((p) => p?.id));
    const last = mock.callsTo(listPaymentIntents).at(-1)?.query as Record<string, unknown>;
    expect(last.starting_after).toBeUndefined();
    expect(last.ending_before).toBe(all[2]?.id);
  });

  it("paginates lists with a path parameter (deliveries) and single-page lists without cursors (assets)", async () => {
    mock.on(listWebhookEndpointDeliveries, (r) =>
      r.query.starting_after
        ? page(`/v1/webhook_endpoints/${ids.we}/deliveries`, [delivery({ id: idN("whd", 2) })])
        : page(`/v1/webhook_endpoints/${ids.we}/deliveries`, [delivery({ id: idN("whd", 1) })], true),
    );
    const d = await np.webhookEndpoints.listDeliveries(ids.we, { limit: 1 }).autoPagingToArray({ limit: 5 });
    expect(d.map((x) => x.id)).toEqual([idN("whd", 1), idN("whd", 2)]);
    expect(mock.callsTo(listWebhookEndpointDeliveries).map((c) => c.params)).toEqual([{ id: ids.we }, { id: ids.we }]);
    mock.on(listAssets, () => ({
      object: "list" as const,
      data: [
        {
          asset_id: USDC_NEAR,
          object: "asset" as const,
          chain: "near:mainnet",
          symbol: "USDC",
          decimals: 6,
          family: "USDC",
          is_usd_stable: true,
        },
      ],
      has_more: false as const,
      url: "/v1/assets" as const,
    }));
    const assets: string[] = [];
    for await (const a of np.assets.list()) assets.push(a.symbol);
    expect(assets).toEqual(["USDC"]);
  });

  it("stops on an empty page that claims has_more, and surfaces errors of later pages", async () => {
    mock.on(listEvents, () => page("/v1/events", [], true));
    expect(await np.events.list().autoPagingToArray({ limit: 5 })).toEqual([]);
    let n = 0;
    mock.on(listEvents, () => {
      n++;
      if (n > 1) throw new MockApiError("api_error");
      return page("/v1/events", [event("ping", { object: "ping", webhook_endpoint: ids.we })], true);
    });
    await expect(np.events.list().autoPagingToArray({ limit: 5 })).rejects.toBeInstanceOf(NearPayApiError);
  });

  it("stops when an item has no id to continue from", async () => {
    const fetchPage = async () => ({ object: "list" as const, data: [{ name: "x" }], has_more: true });
    const { listPromise } = await import("../../src/resources/pagination.js");
    expect(await listPromise(fetchPage, undefined, true).autoPagingToArray({ limit: 5 })).toHaveLength(1);
  });
});
