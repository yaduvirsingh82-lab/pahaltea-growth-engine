import {
  parseJsonObject,
  ProviderUnavailableError,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type ProviderAvailability,
} from "../provider.ts";

/**
 * Ollama — the open-source, locally hosted option. No API key, no per-token
 * cost, no data leaving the machine. Structured output uses Ollama's `format`
 * field, which accepts a JSON Schema and constrains decoding.
 *
 * Start it with: docker compose --profile ollama up -d ollama
 */
export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  requestTimeoutMs?: number;
}

export class OllamaProvider implements GenerationProvider {
  readonly id = "ollama";
  readonly model: string;
  readonly isOfflineStub = false;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5:3b-instruct";
    // Small models on CPU are slow; a generous default avoids spurious failures.
    this.#timeoutMs = options.requestTimeoutMs ?? Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000);
  }

  async available(): Promise<ProviderAvailability> {
    let tags: { models?: { name?: string }[] };
    try {
      const response = await fetch(`${this.#baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        return { available: false, detail: `Ollama responded ${response.status} at ${this.#baseUrl}.` };
      }
      tags = (await response.json()) as { models?: { name?: string }[] };
    } catch (error) {
      return {
        available: false,
        detail: `Cannot reach Ollama at ${this.#baseUrl} (${describe(error)}). Start it with: docker compose --profile ollama up -d ollama`,
      };
    }

    const installed = (tags.models ?? []).map((entry) => entry.name ?? "");
    if (!installed.some((name) => name === this.model || name.startsWith(`${this.model}:`))) {
      return {
        available: false,
        detail: `Ollama is running but model "${this.model}" is not pulled. Run: docker compose --profile ollama exec ollama ollama pull ${this.model}`,
      };
    }
    return { available: true, detail: `Ollama at ${this.#baseUrl} with model ${this.model}.` };
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const availability = await this.available();
    if (!availability.available) throw new ProviderUnavailableError(this.id, availability.detail);

    const response = await fetch(`${this.#baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        // Ollama constrains decoding to this JSON Schema.
        format: request.jsonSchema,
        options: {
          temperature: request.temperature ?? 0.8,
          num_predict: request.maxOutputTokens,
        },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }

    const body = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const raw = body.message?.content ?? "";
    if (raw.trim() === "") throw new Error("Ollama returned an empty response.");

    return {
      provider: this.id,
      model: this.model,
      raw,
      parsed: parseJsonObject(raw),
      usage: { inputTokens: body.prompt_eval_count, outputTokens: body.eval_count },
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
