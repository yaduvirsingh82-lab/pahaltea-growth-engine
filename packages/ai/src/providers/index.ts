import type { GenerationProvider } from "../provider.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OfflineTemplateProvider } from "./offline.ts";
import { OllamaProvider } from "./ollama.ts";

export { AnthropicProvider } from "./anthropic.ts";
export { OfflineTemplateProvider } from "./offline.ts";
export { OllamaProvider } from "./ollama.ts";

export const providerIds = ["ollama", "anthropic", "offline-template"] as const;
export type ProviderId = (typeof providerIds)[number];

export function createProvider(id: string): GenerationProvider {
  switch (id) {
    case "ollama":
      return new OllamaProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "offline-template":
      return new OfflineTemplateProvider();
    default:
      throw new Error(`Unknown content provider "${id}". Known providers: ${providerIds.join(", ")}.`);
  }
}

/**
 * Resolution order favours the free, local, open-source option: an explicitly
 * configured provider wins, otherwise Ollama is used when it is actually
 * reachable with the configured model, otherwise Anthropic when a credential
 * exists, otherwise the offline generator.
 *
 * The offline generator is never selected automatically outside development —
 * a production run must fail loudly rather than emit placeholder copy.
 */
export interface ResolvedProvider {
  provider: GenerationProvider;
  reason: string;
  considered: { id: string; detail: string }[];
}

export async function resolveProvider(options: {
  requested?: string;
  environment: string;
}): Promise<ResolvedProvider> {
  const considered: { id: string; detail: string }[] = [];

  if (options.requested) {
    const provider = createProvider(options.requested);
    const availability = await provider.available();
    if (!availability.available) {
      throw new Error(`Requested provider "${options.requested}" is unavailable: ${availability.detail}`);
    }
    if (provider.isOfflineStub && options.environment === "production") {
      throw new Error("The offline generator cannot be used in production; its output is placeholder copy.");
    }
    return { provider, reason: `Explicitly requested: ${availability.detail}`, considered };
  }

  for (const id of ["ollama", "anthropic"] as const) {
    const provider = createProvider(id);
    const availability = await provider.available();
    considered.push({ id, detail: availability.detail });
    if (availability.available) {
      return { provider, reason: availability.detail, considered };
    }
  }

  if (options.environment === "production") {
    throw new Error(
      `No real content provider is available in production. Tried:\n${considered
        .map((entry) => `  - ${entry.id}: ${entry.detail}`)
        .join("\n")}`,
    );
  }

  const provider = new OfflineTemplateProvider();
  return {
    provider,
    reason: "No model provider available; falling back to the deterministic offline generator (placeholder copy).",
    considered,
  };
}
