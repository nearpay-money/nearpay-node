/**
 * Auto-pagination (api-conventions §2: `limit`, `starting_after`, `ending_before`; pages newest
 * first). A list method returns a `ListPromise`: awaiting it gives the first page; iterating it
 * walks every page, requesting the next one only when the current one is consumed.
 *
 * - Forward (default): the next page starts after the last item of the current one.
 * - Backward (the first call passed `ending_before` and no `starting_after`): the next page ends
 *   before the first item of the current one; items are yielded in page order.
 * - Filters and `limit` of the first call are kept for every page.
 */

/** A page of a list route. */
export interface ListPage<T> {
  readonly object: "list";
  readonly data: readonly T[];
  readonly has_more: boolean;
}

export interface AutoPagingOptions {
  /** Most items to collect (required: protects you from loading an unbounded list into memory). */
  readonly limit: number;
}

/** A promise of the first page that is also an async iterator over every item of every page. */
export interface ListPromise<Page, Item> extends Promise<Page>, AsyncIterable<Item> {
  /** Collects items across pages, up to `limit` (at most 10 000). */
  autoPagingToArray(options: AutoPagingOptions): Promise<Item[]>;
  /** Calls `fn` for every item across pages; return `false` from `fn` to stop early. */
  autoPagingEach(fn: (item: Item) => unknown): Promise<void>;
}

export const AUTO_PAGING_MAX = 10_000;

function idOf(item: unknown): string | undefined {
  const id = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Wraps the first page request of a list call. `fetchPage` repeats the call with another query;
 * `cursor` says whether the route takes cursors (a list without them is a single page).
 */
export function listPromise<Item>(
  fetchPage: (query: Record<string, unknown> | undefined) => Promise<ListPage<Item>>,
  query: Record<string, unknown> | undefined,
  cursor: boolean,
): ListPromise<ListPage<Item>, Item> {
  const first = fetchPage(query);
  const backward = query?.ending_before !== undefined && query?.starting_after === undefined;

  async function* iterate(): AsyncGenerator<Item, void, undefined> {
    let page = await first;
    for (;;) {
      for (const item of page.data) yield item;
      if (!cursor || !page.has_more || page.data.length === 0) return;
      const edge = backward ? page.data[0] : page.data[page.data.length - 1];
      const id = idOf(edge);
      if (id === undefined) return;
      const { starting_after: _s, ending_before: _e, ...rest } = query ?? {};
      page = await fetchPage(backward ? { ...rest, ending_before: id } : { ...rest, starting_after: id });
    }
  }

  const extra = {
    [Symbol.asyncIterator]: iterate,
    async autoPagingToArray(options: AutoPagingOptions): Promise<Item[]> {
      const limit = options?.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > AUTO_PAGING_MAX) {
        throw new RangeError(`autoPagingToArray: limit must be an integer between 1 and ${AUTO_PAGING_MAX}`);
      }
      const out: Item[] = [];
      for await (const item of iterate()) {
        out.push(item);
        if (out.length >= limit) break;
      }
      return out;
    },
    async autoPagingEach(fn: (item: Item) => unknown): Promise<void> {
      for await (const item of iterate()) {
        if ((await fn(item)) === false) break;
      }
    },
  };
  return Object.assign(first, extra) as ListPromise<ListPage<Item>, Item>;
}
