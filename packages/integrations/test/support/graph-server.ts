import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
}

export interface GraphRoute {
  /** Matched against the path after the API version, e.g. "123/media". */
  path: string;
  method?: "GET" | "POST";
  status?: number;
  body: unknown;
}

/**
 * A real HTTP server standing in for the Graph API.
 *
 * Tests exercise the actual client over actual HTTP — URL construction, form
 * encoding, appsecret_proof, status handling and error mapping — rather than
 * asserting against a mocked fetch that could drift from reality.
 */
export class FakeGraphServer {
  readonly #server: Server;
  readonly requests: RecordedRequest[] = [];
  #routes: GraphRoute[] = [];
  #port = 0;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeGraphServer> {
    let instance: FakeGraphServer;
    const server = createServer((req, res) => instance.#handle(req, res));
    instance = new FakeGraphServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    instance.#port = (server.address() as AddressInfo).port;
    return instance;
  }

  get host(): string {
    return `127.0.0.1:${this.#port}`;
  }

  route(...routes: GraphRoute[]): this {
    this.#routes.push(...routes);
    return this;
  }

  reset(): void {
    this.#routes = [];
    this.requests.length = 0;
  }

  lastRequest(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }

  requestsFor(pathFragment: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path.includes(pathFragment));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}`);
    // Strip the /vNN.N/ prefix so routes are declared without the version.
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");

    let body = "";
    for await (const chunk of req) body += chunk;

    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) params[key] = value;
    if (body) for (const [key, value] of new URLSearchParams(body)) params[key] = value;

    this.requests.push({ method: req.method ?? "GET", path, params });

    const route = this.#routes.find(
      (candidate) => candidate.path === path && (candidate.method ?? "GET") === (req.method ?? "GET"),
    );

    res.setHeader("content-type", "application/json");
    if (!route) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${path}`, code: 803 } }));
      return;
    }
    res.statusCode = route.status ?? 200;
    res.end(JSON.stringify(route.body));
  }
}
