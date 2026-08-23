import { createHash } from "node:crypto";
import type { ApprovedClaimRecord } from "./retrieval.ts";
import { prohibitedRules } from "./prohibited.ts";
import { CAPTION_MAX_LENGTH, HOOK_MAX_LENGTH, contentObjectives, instagramFormats } from "./schema.ts";

/**
 * Bump the version whenever the wording below changes. It is persisted on every
 * generation run so a draft's provenance stays reconstructible.
 */
export const PROMPT_TEMPLATE_NAME = "instagram_concepts";
export const PROMPT_TEMPLATE_VERSION = 1;

export interface PromptOptions {
  count: number;
  format?: (typeof instagramFormats)[number];
  objective?: (typeof contentObjectives)[number];
  /** Free-text steer from the operator, e.g. a seasonal angle. Never a source of facts. */
  brief?: string;
}

/**
 * The brand and strategy context. Deliberately contains no product facts: every
 * factual statement must come from the retrieved claim list, which is passed
 * separately and cited by ID.
 */
export function buildSystemPrompt(): string {
  const categories = prohibitedRules
    .map((rule) => `- ${rule.category.replace(/_/g, " ")}: ${rule.reason}`)
    .join("\n");

  return `You are a direct-response Instagram strategist for Pahal Tea, an Indian tea brand restarting operations.

BUSINESS OBJECTIVE
The goal is not followers. The goal is to get a person to TRY Pahal Tea once, because repeat purchase is expected to follow product trial. Optimise every concept for first purchase: product discovery, curiosity, emotional connection to the tea story, strong visual storytelling, a reason to try now, and credible social proof.

ABSOLUTE RULE ON FACTS
You are given a list of APPROVED CLAIMS. Every factual assertion you make about the product must be supported by one of those claims, and you must list the supporting claim IDs in citedClaimIds. You may write emotive, sensory, and narrative language freely, but you may NOT introduce any new product fact from your own knowledge. If you cannot support a statement with an approved claim, do not make the statement.

PROHIBITED LANGUAGE
${categories}

Naming individual spices is prohibited. Refer to "spices" generally and point to the product packet for the exact composition.

TRIAL OFFERS
Do not invent a discount, coupon code, free shipping, or price that you have not been given. If no offer has been supplied, the trialOffer field must express a non-monetary reason to try now, such as small pack size, single-purchase simplicity, or a first-cup experience.

SOCIAL PROOF
Do not fabricate reviews, ratings, customer counts, or testimonials. The socialProofAngle field must describe how credibility could be conveyed honestly, for example by inviting first customers to share their cup, or by referencing the founder's stated experience if an approved claim covers it.

OUTPUT
Return only JSON matching the provided schema. Hooks must be at most ${HOOK_MAX_LENGTH} characters. Captions must be at most ${CAPTION_MAX_LENGTH} characters.`;
}

export function buildUserPrompt(claims: readonly ApprovedClaimRecord[], options: PromptOptions): string {
  // The identifier is presented bare and first. An "id=" style prefix invites a
  // model to copy the prefix into citedClaimIds, which then matches no claim.
  // A live qwen2.5:3b run did exactly that.
  const claimList = claims
    .map((claim) => `- ${claim.id}\n  ${claim.wording}`)
    .join("\n");

  const constraints: string[] = [`Produce exactly ${options.count} distinct concepts.`];
  if (options.format) constraints.push(`Every concept must use the ${options.format} format.`);
  else constraints.push(`Vary the format across: ${instagramFormats.join(", ")}.`);
  if (options.objective) constraints.push(`Every concept must pursue the ${options.objective} objective.`);
  else constraints.push(`Vary the objective across: ${contentObjectives.join(", ")}.`);
  if (options.brief) constraints.push(`Operator brief (styling guidance only, not a source of facts): ${options.brief}`);

  return `APPROVED CLAIMS — the only permitted source of product fact.
Each entry is a claim identifier on its own line, followed by that claim's wording.
Copy identifiers into citedClaimIds exactly as written: no prefix, no numbering, no other text.
${claimList}

CONSTRAINTS
${constraints.map((line) => `- ${line}`).join("\n")}

Write concepts that would make someone who has never heard of Pahal Tea buy one pack. Each concept needs a hook, a full caption, a visual brief for a designer, a call to action, a trial offer, a social proof angle, hashtags, the approved claim IDs it relies on, and a short rationale.`;
}

/** Identifies a request so identical work can be recognised across runs. */
export function requestHash(system: string, prompt: string, model: string): string {
  return createHash("sha256").update(`${model}\n${system}\n${prompt}`, "utf8").digest("hex");
}
