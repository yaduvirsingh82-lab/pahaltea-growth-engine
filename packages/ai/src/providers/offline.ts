import { createHash } from "node:crypto";
import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  ProviderAvailability,
} from "../provider.ts";

/**
 * A deterministic, template-based generator for tests and offline development.
 *
 * This is NOT a model and does not pretend to be one. It composes concepts from
 * fixed copy skeletons and the approved claim IDs it reads out of the prompt,
 * so the pipeline — retrieval, schema parsing, claim-citation validation,
 * prohibited-term scanning, persistence, review — can be exercised end to end
 * with no network, no credential, and no cost.
 *
 * Every run it produces is persisted with `is_offline_stub = true`, and the
 * generation orchestrator refuses to use it when APP_ENV is production. Its
 * output is placeholder copy suitable for verifying machinery, never for
 * publishing.
 */
export class OfflineTemplateProvider implements GenerationProvider {
  readonly id = "offline-template";
  readonly model = "deterministic-templates-v1";
  readonly isOfflineStub = true;

  async available(): Promise<ProviderAvailability> {
    return { available: true, detail: "Deterministic offline generator. Produces placeholder copy, not model output." };
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const claimIds = extractClaimIds(request.prompt);
    if (claimIds.length === 0) {
      throw new Error("The offline generator found no approved claim IDs in the prompt.");
    }

    const count = extractCount(request.prompt);
    const seed = createHash("sha256").update(request.prompt, "utf8").digest();

    const concepts = Array.from({ length: count }, (_, index) => {
      const angle = angles[(seed[index % seed.length] + index) % angles.length];
      // Cite a rotating, deterministic subset so different concepts lean on
      // different approved facts, as a real batch would.
      const cited = [
        claimIds[index % claimIds.length],
        claimIds[(index + 1) % claimIds.length],
      ].filter((value, position, all) => all.indexOf(value) === position);

      return {
        conceptName: `${angle.name} ${index + 1}`,
        format: angle.format,
        objective: angle.objective,
        hook: angle.hook,
        caption: `${angle.hook}\n\n${angle.body}\n\n${angle.cta}`,
        visualBrief: angle.visualBrief,
        cta: angle.cta,
        trialOffer: angle.trialOffer,
        socialProofAngle: angle.socialProofAngle,
        hashtags: ["#pahaltea", "#masalatea", "#assamtea", "#chai"],
        citedClaimIds: cited,
        rationale: angle.rationale,
      };
    });

    const payload = { concepts };
    return {
      provider: this.id,
      model: this.model,
      raw: JSON.stringify(payload),
      parsed: payload,
      usage: {},
    };
  }
}

interface Angle {
  name: string;
  format: "feed_post" | "reel" | "story";
  objective: "product_discovery" | "curiosity" | "emotional_connection" | "trial" | "social_proof" | "repeat_purchase" | "retargeting";
  hook: string;
  body: string;
  visualBrief: string;
  cta: string;
  trialOffer: string;
  socialProofAngle: string;
  rationale: string;
}

/**
 * Copy skeletons are written to stay inside the approved catalogue: they name
 * no spice, assert no benefit, and claim no certification or ranking.
 */
const angles: readonly Angle[] = [
  {
    name: "first-cup",
    format: "feed_post",
    objective: "emotional_connection",
    hook: "The cup that tastes like the morning it came from.",
    body: "Tea and spices from Assam, blended and packed so the first cup you pour is the one we meant you to have.",
    visualBrief:
      "Overhead shot of a filled cup on a worn wooden table, steam catching low morning light, muted earth palette, no on-image text.",
    cta: "Order a pack and tell us what your first cup tasted like.",
    trialOffer: "A single 200g pack is enough to decide. No subscription, no commitment.",
    socialProofAngle: "Invite the first customers to post their own cup, building proof from real buyers rather than claiming any.",
    rationale: "Leads with sensory memory rather than product specification, which lowers resistance to a first purchase.",
  },
  {
    name: "garden-to-cup",
    format: "reel",
    objective: "product_discovery",
    hook: "Most chai travels a long way before it reaches you. This one takes a shorter road.",
    body: "Grown in Assam, blended with tea and spices, and sent out garden fresh — directly from where the tea is grown.",
    visualBrief:
      "Three quick cuts: hands over loose tea, the pack being sealed, a cup being poured. Handheld, natural light, warm grade.",
    cta: "Try one pack and taste the difference a shorter road makes.",
    trialOffer: "Start with the 200g pack — the smallest way to find out.",
    socialProofAngle: "Show the process openly so credibility comes from visible making, not from asserted popularity.",
    rationale: "Product discovery through provenance the approved catalogue actually supports.",
  },
  {
    name: "what-is-inside",
    format: "story",
    objective: "curiosity",
    hook: "Two ingredients on the label. That is the whole list.",
    body: "Tea and spices. No added flavours, no colours, no preservatives, no additives. For the exact spice composition, read the packet.",
    visualBrief:
      "Tight macro on the printed ingredient panel, shallow depth of field, single light source, honest and unstyled.",
    cta: "Swipe up to read the label for yourself.",
    trialOffer: "One pack, one decision. Try it before you commit to anything larger.",
    socialProofAngle: "Let the printed label do the persuading instead of quoting customers we have not surveyed.",
    rationale: "Curiosity plus transparency converts sceptical first-time buyers.",
  },
  {
    name: "blenders-hand",
    format: "feed_post",
    objective: "trial",
    hook: "Anyone can mix tea and spices. Getting the proportion right takes practice.",
    body: "Blended with expertise: the composition of spices, the grades of tea, and the best flush of production, drawn from our founder's experience in tea.",
    visualBrief:
      "Hands adjusting a blend on a steel tray, top-down, cool grey surface against warm tea tones, quiet and precise mood.",
    cta: "Buy one pack and judge the proportion yourself.",
    trialOffer: "A 200g pack is roughly a month of mornings. Enough to form an opinion.",
    socialProofAngle: "Ground credibility in the founder's stated experience, which the approved catalogue covers.",
    rationale: "Directly targets trial by framing purchase as a low-cost judgement rather than a commitment.",
  },
  {
    name: "second-pack",
    format: "feed_post",
    objective: "repeat_purchase",
    hook: "You finished the first pack faster than you expected.",
    body: "Amchong grade tea and spices from Assam, blended the same way every time, so the second pack tastes like the first.",
    visualBrief:
      "An almost-empty pack beside a full one, soft side light, domestic kitchen context, unfussy composition.",
    cta: "Reorder before the last cup.",
    trialOffer: "Same 200g pack, same blend, no surprises.",
    socialProofAngle: "Speak to consistency, which a returning buyer can verify themselves, instead of citing ratings.",
    rationale: "Consistency is the argument that turns one trial into a repeat order.",
  },
];

function extractClaimIds(prompt: string): string[] {
  // Matches the bare identifiers the prompt lists, one per line.
  return [...prompt.matchAll(/^- ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/gim)]
    .map((match) => match[1]);
}

function extractCount(prompt: string): number {
  const match = /Produce exactly (\d+) distinct concepts/.exec(prompt);
  const parsed = match ? Number(match[1]) : 3;
  return Math.min(Math.max(parsed, 1), 20);
}
