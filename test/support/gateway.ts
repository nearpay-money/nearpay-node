/**
 * A minimal stand-in for the gateway (Traefik + identity ForwardAuth): it maps `Authorization: Bearer
 * sk_test_…` to an internal token for a secret-key principal and forwards each request to the
 * spec-driven mock of the service that owns the route (`mockPeer` from `@nearpay-internal/testing`),
 * so the SDK is exercised against the real request validation and response checks of the service
 * bootstrap.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type AnyRoute, PUBLIC_ROUTES, pathMatcher, type ServiceName } from "@nearpay/spec";
import { type MockPeer, mintTestToken, mockPeer } from "@nearpay-internal/testing";

export const ACCOUNT = "acct_01jbz9k3m4n5p6q7r8s9t0v1w2";
export const KEY_ID = "key_01jbz9k3m4n5p6q7r8s9t0v1w2";

export interface Gateway {
  readonly url: string;
  readonly peers: Readonly<Record<string, MockPeer>>;
  peer(service: ServiceName): MockPeer;
  stop(): Promise<void>;
}

const matchers = PUBLIC_ROUTES.map((r) => ({ route: r, re: pathMatcher(r.path) }));

export function matchRoute(method: string, path: string): AnyRoute | undefined {
  return matchers.find((m) => m.route.method === method && m.re.test(path))?.route;
}

export async function startGateway(services: readonly ServiceName[]): Promise<Gateway> {
  const peers: Record<string, MockPeer> = {};
  for (const s of services) peers[s] = await mockPeer({ service: s, routes: PUBLIC_ROUTES });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://gateway");
      const route = matchRoute(req.method ?? "GET", url.pathname);
      const peer = route ? peers[route.service] : undefined;
      if (!route || !peer) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no route" }));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host" || k === "authorization" || k === "connection" || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer sk_test_")) {
        headers["x-nearpay-token"] = await mintTestToken({
          sub: KEY_ID,
          acct: ACCOUNT,
          lm: false,
          ptype: "secret_key",
          scp: [],
        });
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${peer.url}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "DELETE" ? undefined : body,
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== "content-length" && k !== "transfer-encoding" && k !== "connection") out[k] = v;
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, out);
      res.end(buf);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    peers,
    peer(service) {
      const p = peers[service];
      if (!p) throw new Error(`no mock for ${service}`);
      return p;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const p of Object.values(peers)) await p.stop();
    },
  };
}
