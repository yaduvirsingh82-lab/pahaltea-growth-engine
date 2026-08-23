import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderUnavailableError,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type ProviderAvailability,
} from "../provider.ts";

/**
 * Anthropic — the highest-quality option. Structured output uses strict tool
 * use with a forced tool choice, which validates the model's arguments against
 * the same JSON Schema the Ollama provider constrains against, so both
 * providers return the identical shape.
 *
 * Credentials are never read from a file in this repository. The SDK resolves
 * them from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
 * profile; construction is deferred so importing this module without any
 * credential configured is harmless.
 */
export interface AnthropicOptions {
  model?: string;
  client?: Anthropic;
}

export class AnthropicProvider implements GenerationProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly isOfflineStub = false;
  #client: Anthropic | undefined;

  constructor(options: AnthropicOptions = {}) {
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
    this.#client = options.client;
  }

  async available(): Promise<ProviderAvailability> {
    if (this.#client) return { available: true, detail: `Anthropic client supplied directly (${this.model}).` };
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      return { available: true, detail: `Anthropic credential found in the environment (${this.model}).` };
    }
    return {
      available: false,
      detail:
        "No Anthropic credential configured. Set ANTHROPIC_API_KEY, or run `ant auth login` and re-run — the SDK reads that profile automatically.",
    };
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const availability = await this.available();
    if (!availability.available) throw new ProviderUnavailableError(this.id, availability.detail);

    // Constructed lazily so an unconfigured environment fails at generate time
    // with the message above, not at import time.
    this.#client ??= new Anthropic();

    const response = await this.#client.messages.create({
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      tools: [
        {
          name: request.schemaName,
          description: "Return the generated Instagram concepts.",
          strict: true,
          input_schema: request.jsonSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: request.schemaName },
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      if (response.stop_reason === "refusal") {
        throw new Error(`Anthropic declined the request: ${response.stop_details?.explanation ?? "no explanation"}`);
      }
      throw new Error(`Anthropic returned no tool_use block (stop_reason: ${response.stop_reason}).`);
    }

    return {
      provider: this.id,
      model: response.model,
      raw: JSON.stringify(toolUse.input),
      parsed: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
