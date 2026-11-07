/**
 * Restricted keys (`rk_…`): which scope each SDK method needs, from the routes' `auth` lists
 * (`restricted_key:<scope>`). Create restricted keys in the dashboard (API keys are managed with a
 * dashboard session and step-up only, so the SDK does not manage keys).
 */
import type { AnyRoute } from "@nearpay/spec";
import { restrictedScopeOf } from "../http/transport.js";
import { routesOf } from "./bind.js";
import { RESOURCES, type Resources } from "./routes.js";

type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends AnyRoute ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Dotted path of an SDK method, e.g. `"refunds.create"`. */
export type MethodPath = Paths<Resources>;

/** How a method may be called with a restricted key. */
export interface MethodAccess {
  /** The scope an `rk_…` key needs; `null` when only secret keys (or anonymous) may call it. */
  readonly scope: string | null;
  /** Called without a key (`webhookSigningKeys.list`, `assets.list`, `x402.supported`). */
  readonly anonymous: boolean;
}

const ACCESS: ReadonlyMap<string, MethodAccess> = new Map(
  routesOf(RESOURCES).map(({ path, route }) => [
    path,
    { scope: restrictedScopeOf(route) ?? null, anonymous: route.auth.every((a) => a === "anonymous") },
  ]),
);

/** The restricted-key scope of a method: `restrictedKeyScope("refunds.create")` → `"refunds.write"`. */
export function restrictedKeyScope(method: MethodPath): string | null {
  const a = ACCESS.get(method);
  if (!a) throw new TypeError(`unknown NearPay method ${method}`);
  return a.scope;
}

/** Every method with its access rule (for building a least-privilege restricted key). */
export function methodAccess(): ReadonlyMap<string, MethodAccess> {
  return ACCESS;
}

/** The scopes a restricted key needs to call all of `methods`. */
export function scopesFor(methods: readonly MethodPath[]): string[] {
  const out = new Set<string>();
  for (const m of methods) {
    const s = restrictedKeyScope(m);
    if (s === null && !ACCESS.get(m)?.anonymous) throw new TypeError(`${m} needs a secret key (sk_…)`);
    if (s) out.add(s);
  }
  return [...out].sort();
}
