export const instagramFormats = ["feed_post", "reel", "story"] as const;
export type InstagramFormat = (typeof instagramFormats)[number];

/**
 * Objectives follow the stated business strategy: the goal is first trial, not
 * follower count. Every concept must declare which lever it is pulling.
 */
export const contentObjectives = [
  "product_discovery",
  "curiosity",
  "emotional_connection",
  "trial",
  "social_proof",
  "repeat_purchase",
  "retargeting",
] as const;
export type ContentObjective = (typeof contentObjectives)[number];

export interface InstagramConcept {
  conceptName: string;
  format: InstagramFormat;
  objective: ContentObjective;
  hook: string;
  caption: string;
  visualBrief: string;
  cta: string;
  trialOffer: string;
  socialProofAngle: string;
  hashtags: string[];
  citedClaimIds: string[];
  rationale: string;
}

export interface ConceptBatch {
  concepts: InstagramConcept[];
}

export const CAPTION_MAX_LENGTH = 2200;
export const HOOK_MAX_LENGTH = 120;
export const MAX_HASHTAGS = 30;

/** Shared by every provider: the Ollama format field and the Anthropic strict tool schema. */
export const conceptBatchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["concepts"],
  properties: {
    concepts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "conceptName",
          "format",
          "objective",
          "hook",
          "caption",
          "visualBrief",
          "cta",
          "trialOffer",
          "socialProofAngle",
          "hashtags",
          "citedClaimIds",
          "rationale",
        ],
        properties: {
          conceptName: { type: "string", description: "Short internal name for this concept." },
          format: { type: "string", enum: [...instagramFormats] },
          objective: { type: "string", enum: [...contentObjectives] },
          hook: {
            type: "string",
            description: `Scroll-stopping opening line, at most ${HOOK_MAX_LENGTH} characters.`,
          },
          caption: {
            type: "string",
            description: `Full Instagram caption, at most ${CAPTION_MAX_LENGTH} characters.`,
          },
          visualBrief: {
            type: "string",
            description:
              "Art direction for the creative layer: subject, composition, lighting, mood, on-image text.",
          },
          cta: { type: "string", description: "One clear call to action driving a first purchase." },
          trialOffer: {
            type: "string",
            description:
              "The specific low-friction reason to try Pahal Tea once. Must not invent a discount that does not exist.",
          },
          socialProofAngle: {
            type: "string",
            description:
              "How credibility is conveyed without fabricating reviews, ratings, counts, or testimonials.",
          },
          hashtags: {
            type: "array",
            maxItems: MAX_HASHTAGS,
            items: { type: "string" },
          },
          citedClaimIds: {
            type: "array",
            minItems: 1,
            description: "IDs of approved claims supporting every factual assertion in this concept.",
            items: { type: "string" },
          },
          rationale: { type: "string", description: "Why this concept should drive first trial." },
        },
      },
    },
  },
} as const;

export interface SchemaViolation {
  path: string;
  message: string;
}

/**
 * Structural validation of provider output. Deliberately hand-written rather
 * than pulled from a schema library: providers differ in how well they honour a
 * schema, and a malformed batch must fail loudly rather than persist partially.
 */
export function parseConceptBatch(value: unknown): { batch?: ConceptBatch; violations: SchemaViolation[] } {
  const violations: SchemaViolation[] = [];
  if (!isRecord(value)) return { violations: [{ path: "$", message: "Response is not an object." }] };

  const rawConcepts = value.concepts;
  if (!Array.isArray(rawConcepts) || rawConcepts.length === 0) {
    return { violations: [{ path: "$.concepts", message: "Response must contain a non-empty concepts array." }] };
  }

  const concepts: InstagramConcept[] = [];
  rawConcepts.forEach((entry, index) => {
    const path = `$.concepts[${index}]`;
    if (!isRecord(entry)) {
      violations.push({ path, message: "Concept is not an object." });
      return;
    }

    const conceptName = requireText(entry, "conceptName", path, violations);
    const hook = requireText(entry, "hook", path, violations);
    const caption = requireText(entry, "caption", path, violations);
    const visualBrief = requireText(entry, "visualBrief", path, violations);
    const cta = requireText(entry, "cta", path, violations);
    const trialOffer = requireText(entry, "trialOffer", path, violations);
    const socialProofAngle = requireText(entry, "socialProofAngle", path, violations);
    const rationale = requireText(entry, "rationale", path, violations);

    const format = requireEnum(entry, "format", instagramFormats, path, violations);
    const objective = requireEnum(entry, "objective", contentObjectives, path, violations);
    const hashtags = requireStringArray(entry, "hashtags", path, violations, 0);
    const citedClaimIds = requireStringArray(entry, "citedClaimIds", path, violations, 1);

    if (hook && hook.length > HOOK_MAX_LENGTH) {
      violations.push({ path: `${path}.hook`, message: `Hook exceeds ${HOOK_MAX_LENGTH} characters.` });
    }
    if (caption && caption.length > CAPTION_MAX_LENGTH) {
      violations.push({ path: `${path}.caption`, message: `Caption exceeds ${CAPTION_MAX_LENGTH} characters.` });
    }
    if (hashtags && hashtags.length > MAX_HASHTAGS) {
      violations.push({ path: `${path}.hashtags`, message: `More than ${MAX_HASHTAGS} hashtags.` });
    }

    if (
      conceptName && hook && caption && visualBrief && cta && trialOffer && socialProofAngle && rationale &&
      format && objective && hashtags && citedClaimIds
    ) {
      concepts.push({
        conceptName,
        format,
        objective,
        hook,
        caption,
        visualBrief,
        cta,
        trialOffer,
        socialProofAngle,
        hashtags,
        citedClaimIds,
        rationale,
      });
    }
  });

  return violations.length > 0 ? { violations } : { batch: { concepts }, violations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(
  entry: Record<string, unknown>,
  field: string,
  path: string,
  violations: SchemaViolation[],
): string | undefined {
  const value = entry[field];
  if (typeof value !== "string" || value.trim() === "") {
    violations.push({ path: `${path}.${field}`, message: "Must be a non-empty string." });
    return undefined;
  }
  return value.trim();
}

function requireEnum<T extends readonly string[]>(
  entry: Record<string, unknown>,
  field: string,
  allowed: T,
  path: string,
  violations: SchemaViolation[],
): T[number] | undefined {
  const value = entry[field];
  if (typeof value !== "string" || !allowed.includes(value)) {
    violations.push({ path: `${path}.${field}`, message: `Must be one of: ${allowed.join(", ")}.` });
    return undefined;
  }
  return value;
}

function requireStringArray(
  entry: Record<string, unknown>,
  field: string,
  path: string,
  violations: SchemaViolation[],
  minItems: number,
): string[] | undefined {
  const value = entry[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    violations.push({ path: `${path}.${field}`, message: "Must be an array of strings." });
    return undefined;
  }
  const cleaned = (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
  if (cleaned.length < minItems) {
    violations.push({
      path: `${path}.${field}`,
      message: `Must contain at least ${minItems} entr${minItems === 1 ? "y" : "ies"}.`,
    });
    return undefined;
  }
  return cleaned;
}
