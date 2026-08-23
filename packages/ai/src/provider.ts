/**
 * The only surface the content pipeline knows about. Business logic never
 * imports a concrete provider: swapping Ollama for Anthropic, or either for the
 * offline generator, changes configuration, not the generation or validation
 * code.
 */
export interface GenerationRequest {
  system: string;
  prompt: string;
  /** JSON Schema the response must satisfy. Providers enforce it natively where they can. */
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
  maxOutputTokens: number;
  temperature?: number;
}

export interface GenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported cost when available. Never estimated locally. */
  costUsd?: number;
}

export interface GenerationResult {
  provider: string;
  model: string;
  /** Raw provider text, retained so a draft can be audited against what the model actually returned. */
  raw: string;
  parsed: unknown;
  usage: GenerationUsage;
}

export interface ProviderAvailability {
  available: boolean;
  /** Human-readable reason, shown verbatim by the CLI. Never swallowed. */
  detail: string;
}

export interface GenerationProvider {
  readonly id: string;
  readonly model: string;
  /**
   * True only for the deterministic offline generator. Persisted onto every
   * generation run so offline output can never be mistaken for model output.
   */
  readonly isOfflineStub: boolean;
  available(): Promise<ProviderAvailability>;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export class ProviderUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string, detail: string) {
    super(`Provider "${providerId}" is not available: ${detail}`);
    this.name = "ProviderUnavailableError";
    this.providerId = providerId;
  }
}

/** Extracts the first JSON object from provider text that wrapped it in prose or fences. */
export function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`Provider did not return JSON. First 200 characters: ${trimmed.slice(0, 200)}`);
    }
    return JSON.parse(withoutFence.slice(start, end + 1));
  }
}
