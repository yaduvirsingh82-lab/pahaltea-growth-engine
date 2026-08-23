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
    // CPU-only inference is slow: a 3B model on this hardware generates around
    // 1.25 tokens/second, so a full concept batch can run well past ten minutes.
    // Override with OLLAMA_TIMEOUT_MS when a GPU makes this unnecessary.
    this.#timeoutMs = options.requestTimeoutMs ?? Number(process.env.OLLAMA_TIMEOUT_MS ?? 1_800_000);
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

    // Streaming is not optional here. A non-streaming call sends no response
    // headers until generation finishes, and Node's fetch aborts after five
    // minutes of silence ("fetch failed"). CPU-only inference on a small model
    // routinely runs past that, so we stream and assemble the JSON ourselves.
    const response = await fetch(`${this.#baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: true,
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

    if (!response.ok || !response.body) {
      throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }

    let raw = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let failure: string | undefined;

    // Ollama streams newline-delimited JSON; a chunk may split a line.
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;

        const event = JSON.parse(line) as {
          message?: { content?: string };
          error?: string;
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        if (event.error) failure = event.error;
        raw += event.message?.content ?? "";
        if (event.done) {
          inputTokens = event.prompt_eval_count;
          outputTokens = event.eval_count;
        }
      }
    }

    if (failure) throw new Error(`Ollama reported an error: ${failure}`);
    if (raw.trim() === "") throw new Error("Ollama returned an empty response.");

    return {
      provider: this.id,
      model: this.model,
      raw,
      parsed: parseJsonObject(raw),
      usage: { inputTokens, outputTokens },
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
