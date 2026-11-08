/**
 * Resource clients generated from the `@nearpay/spec` route tables (lld/sdks-and-tools.md §1): each
 * leaf of a resource tree is a spec route, and `bindResources` turns it into a typed method whose
 * arguments and result are derived from the route's zod schemas — no contract type is written here.
 *
 * Method shape: `(pathParam?, bodyOrQuery?, options?)`, e.g. `checkout.sessions.create(params, {idempotencyKey})`,
 * `paymentIntents.retrieve("pi_…")`, `events.list({limit: 20})`. List methods return a `ListPromise`:
 * await it for one page, or iterate it (`for await (const pi of nearpay.paymentIntents.list())`) to
 * walk every page with cursor pagination.
 */
import type { AnyRoute, RouteDefinition, RouteResponse } from "@nearpay/spec";
import { z } from "zod";
import { type EventStreamOptions, type EventStreamParams, openEventStream } from "../events/stream.js";
import { listItemSchema } from "../http/parse.js";
import type { RequestOptions, ResponseMeta, Transport } from "../http/transport.js";
import { type ListPage, type ListPromise, listPromise } from "./pagination.js";

/** Request body type of a route (zod input: defaulted fields are optional). */
export type RouteBodyInput<R> =
  R extends RouteDefinition<infer _P, infer _Q, infer B, infer _R>
    ? B extends z.ZodType
      ? z.input<B>
      : undefined
    : never;

/** Removes index signatures (`metadata[key]` catch-alls) and keeps the declared keys. */
type KnownKeys<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
type BracketBase<K> = K extends `${infer B}[${string}]` ? B : never;
type BracketGroup<T, B extends string> = { [K in keyof T as K extends `${B}[${infer O}]` ? O : never]?: T[K] };
/** `created[gte]` / `amount[lt]` keys also accepted grouped: `created: {gte}`, `amount: {lt}`. */
type GroupedRanges<T> = { [B in BracketBase<keyof T> & string]?: BracketGroup<T, B> };
/** `metadata[key]=value` filters (ADR-0018) as an object, on queries built with `withMetadataFilter`. */
type MetadataFilter<O> = string extends keyof O ? { metadata?: Readonly<Record<string, string>> } : unknown;
type QueryOf<O> = Partial<KnownKeys<O>> & GroupedRanges<KnownKeys<O>> & MetadataFilter<O>;

/**
 * Query type of a route: every key optional (the API applies defaults such as `limit=10`); range
 * filters flat (`"created[gte]": t`) or grouped (`created: {gte: t}`); `metadata: {key: value}`
 * where the route accepts metadata filters.
 */
export type RouteQueryInput<R> =
  R extends RouteDefinition<infer _P, infer Q, infer _B, infer _R>
    ? Q extends z.ZodType
      ? QueryOf<z.output<Q>>
      : undefined
    : never;

/** Whether the route has a `{param}` in its path. */
export type RouteHasPathParam<R> =
  R extends RouteDefinition<infer P, infer _Q, infer _B, infer _R> ? (P extends z.ZodType ? true : false) : never;

/** Result of a route call: the response object, with `lastResponse` metadata on objects. */
export type RouteResult<R> =
  RouteResponse<R> extends object ? RouteResponse<R> & { readonly lastResponse?: ResponseMeta } : RouteResponse<R>;

/** Item type of a list route (`never` for other routes). */
export type RouteListItem<R> = RouteResponse<R> extends { object: "list"; data: readonly (infer I)[] } ? I : never;

/** What a method returns: a `ListPromise` for list routes, a `Promise` otherwise. */
export type RouteReturn<R> = [RouteListItem<R>] extends [never]
  ? Promise<RouteResult<R>>
  : ListPromise<RouteResult<R>, RouteListItem<R>>;

type InputArgs<R> =
  RouteBodyInput<R> extends undefined
    ? RouteQueryInput<R> extends undefined
      ? []
      : [query?: RouteQueryInput<R>]
    : // biome-ignore lint/complexity/noBannedTypes: `{}` here means "a body with no required field"
      {} extends RouteBodyInput<R>
      ? [body?: RouteBodyInput<R>]
      : [body: RouteBodyInput<R>];

type ParamArgs<R> = RouteHasPathParam<R> extends true ? [id: string] : [];

/** A typed method for one spec route. */
export type RouteMethod<R> = (...args: [...ParamArgs<R>, ...InputArgs<R>, options?: RequestOptions]) => RouteReturn<R>;

/** A nested map whose leaves are spec routes. */
export interface ResourceTree {
  readonly [name: string]: AnyRoute | ResourceTree;
}

/** The bound counterpart of a resource tree. */
export type BoundResources<T> = {
  readonly [K in keyof T]: T[K] extends AnyRoute ? RouteMethod<T[K]> : BoundResources<T[K]>;
};

const PARAM_RE = /\{([a-z_]+)\}/g;

export function isRoute(v: unknown): v is AnyRoute {
  return typeof v === "object" && v !== null && "method" in v && "path" in v && "auth" in v;
}

/** Path parameter names of a route, in order (SDK routes have at most one). */
export function pathParamNames(route: Pick<AnyRoute, "path">): string[] {
  return [...route.path.matchAll(PARAM_RE)].map((m) => m[1] as string);
}

/** Whether a route answers with a `{object: "list", data, has_more}` page. */
export function isListRoute(route: Pick<AnyRoute, "response">): boolean {
  return route.response !== null && listItemSchema(route.response) !== undefined;
}

/** Whether a list route takes `starting_after` / `ending_before` cursors. */
export function isCursorRoute(route: Pick<AnyRoute, "query">): boolean {
  const q = route.query;
  return q instanceof z.ZodObject && "starting_after" in q.shape && "ending_before" in q.shape;
}

/**
 * Binds one route to the transport. SSE routes (`stream`, spec 0.3.0 `streamEvents`) bind to an
 * `EventStream` opener `(params?, options?)`; binary routes resolve with bytes (see `Transport`).
 */
export function bindRoute(transport: Transport, route: AnyRoute): (...args: unknown[]) => unknown {
  if (route.stream) {
    if (pathParamNames(route).length > 0)
      throw new Error(`${route.id}: streams with path parameters are not supported`);
    const open = (params?: EventStreamParams, options?: EventStreamOptions) =>
      openEventStream(transport, route, params, options);
    Object.defineProperty(open, "name", { value: route.id });
    return open as (...args: unknown[]) => unknown;
  }
  const names = pathParamNames(route);
  if (names.length > 1) throw new Error(`${route.id}: routes with more than one path parameter are not supported`);
  const takesInput = route.body !== undefined || route.query !== undefined;
  const list = isListRoute(route);
  const cursor = isCursorRoute(route);
  const method = (...args: unknown[]) => {
    let i = 0;
    let params: Record<string, string> | undefined;
    const name = names[0];
    if (name !== undefined) {
      const value = args[i++];
      if (typeof value !== "string" || value.length === 0) {
        return Promise.reject(new TypeError(`${route.id}: ${name} must be a non-empty string`));
      }
      params = { [name]: value };
    }
    const input = takesInput ? args[i++] : undefined;
    const options = args[i] as RequestOptions | undefined;
    const query = route.query !== undefined ? (input as Record<string, unknown> | undefined) : undefined;
    const call = (q: Record<string, unknown> | undefined) =>
      transport.request(route, { params, body: route.body !== undefined ? input : undefined, query: q }, options);
    if (!list) return call(query);
    return listPromise(call as (q: Record<string, unknown> | undefined) => Promise<ListPage<unknown>>, query, cursor);
  };
  Object.defineProperty(method, "name", { value: route.id });
  return method;
}

/** Binds every route of a resource tree. */
export function bindResources<T extends ResourceTree>(transport: Transport, tree: T): BoundResources<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tree)) {
    out[k] = isRoute(v) ? bindRoute(transport, v) : bindResources(transport, v as ResourceTree);
  }
  return Object.freeze(out) as BoundResources<T>;
}

/** Every route of a tree with its dotted method path (`checkout.sessions.create`). */
export function routesOf(tree: ResourceTree, prefix = ""): { path: string; route: AnyRoute }[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    isRoute(v) ? [{ path: `${prefix}${k}`, route: v }] : routesOf(v as ResourceTree, `${prefix}${k}.`),
  );
}
