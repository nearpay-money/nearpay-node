/** A scripted local HTTP server: each request is recorded and answered by the next queued responder. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

export type Responder = (req: Recorded, res: ServerResponse) => void;

export interface ScriptedServer {
  readonly url: string;
  readonly requests: Recorded[];
  /** Queue responders; when the queue is empty the fallback answers. */
  push(...r: Responder[]): void;
  close(): Promise<void>;
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Responder =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

export const empty =
  (status: number, headers: Record<string, string> = {}): Responder =>
  (_req, res) => {
    res.writeHead(status, headers);
    res.end();
  };

export const text =
  (status: number, body: string): Responder =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(body);
  };

/** Destroys the socket without answering (a network error for the client). */
export const hangUp: Responder = (_req, res) => {
  res.socket?.destroy();
};

/** Never answers (the client's timeout fires). */
export const stall: Responder = () => {};

export const envelope = (type: string, code: string, message = code, extra: Record<string, unknown> = {}) => ({
  error: {
    type,
    code,
    message,
    doc_url: `https://docs.nearpay.money/errors/${code}`,
    request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    ...extra,
  },
});

export async function scriptedServer(fallback: Responder = json(200, { ok: true })): Promise<ScriptedServer> {
  const queue: Responder[] = [];
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(rec);
      (queue.shift() ?? fallback)(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    push: (...r) => queue.push(...r),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
