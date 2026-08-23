import { createHmac } from "node:crypto";
import type { MetaConfig } from "./config.ts";

/**
 * Minimal Graph API client. Deliberately not a generated SDK: the engine touches
 * a handful of endpoints, and a thin client keeps the request surface auditable.
 */

export class MetaApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  /** Graph transport/throttle errors are worth retrying; a bad request is not. */
  readonly retryable: boolean;

  constructor(status: number, body: unknown, endpoint: string) {
    const error = extractError(body);
    super(`Meta Graph ${endpoint} failed (HTTP ${status}${error.code ? `, code ${error.code}` : ""}): ${error.message}`);
    this.name = "MetaApiError";
    this.status = status;
    this.code = error.code;
    this.subcode = error.subcode;
    this.type = error.type;
    this.fbtraceId = error.fbtraceId;
    // 4 = app rate limit, 17 = user rate limit, 32 = page rate limit,
    // 613 = custom-rate limit, 2 = transient Graph outage.
    this.retryable = status >= 500 || [1, 2, 4, 17, 32, 613].includes(error.code ?? -1);
  }
}

export interface GraphRequest {
  path: string;
  method?: "GET" | "POST";
  params?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export class MetaGraphClient {
  readonly #config: MetaConfig;

  constructor(config: MetaConfig) {
    this.#config = config;
  }

  get config(): MetaConfig {
    return this.#config;
  }

  async request<T>(request: GraphRequest): Promise<T> {
    const token = this.#config.accessToken;
    if (!token) throw new Error("META_ACCESS_TOKEN is not configured; no Graph request can be made.");

    const protocol = this.#config.graphProtocol ?? "https";
    const url = new URL(`${protocol}://${this.#config.graphHost}/${this.#config.apiVersion}/${request.path.replace(/^\//, "")}`);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.params ?? {})) {
      if (value !== undefined) params.set(key, value);
    }
    params.set("access_token", token);

    // appsecret_proof binds the call to the app secret, so a stolen token alone
    // cannot be replayed from elsewhere. Meta recommends it for server calls.
    if (this.#config.appSecret) {
      params.set("appsecret_proof", createHmac("sha256", this.#config.appSecret).update(token).digest("hex"));
    }

    const method = request.method ?? "GET";
    let response: Response;
    try {
      response = await fetch(method === "GET" ? `${url}?${params}` : url.toString(), {
        method,
        signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
        ...(method === "POST"
          ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: params.toString() }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MetaApiError(0, { error: { message: `network failure: ${message}`, code: 2 } }, request.path);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new MetaApiError(response.status, { error: { message: text.slice(0, 300) } }, request.path);
    }

    if (!response.ok || (body as { error?: unknown }).error) {
      throw new MetaApiError(response.status, body, request.path);
    }
    return body as T;
  }
}

/** Redacts anything token-shaped before a value reaches a log or the database. */
export function redactToken(value: string): string {
  return value.replace(/\b(EAA|IGQ)[A-Za-z0-9_-]{10,}\b/g, "$1<redacted>");
}

function extractError(body: unknown): {
  message: string;
  code?: number;
  subcode?: number;
  type?: string;
  fbtraceId?: string;
} {
  const error = (body as { error?: Record<string, unknown> })?.error;
  if (!error) return { message: "no error body returned" };
  return {
    message: redactToken(String(error.message ?? "unknown error")),
    code: typeof error.code === "number" ? error.code : undefined,
    subcode: typeof error.error_subcode === "number" ? error.error_subcode : undefined,
    type: typeof error.type === "string" ? error.type : undefined,
    fbtraceId: typeof error.fbtrace_id === "string" ? error.fbtrace_id : undefined,
  };
}
