import { scanConceptText, type ProhibitedMatch } from "./prohibited.ts";
import type { ApprovedClaimRecord } from "./retrieval.ts";
import { CAPTION_MAX_LENGTH, HOOK_MAX_LENGTH, MAX_HASHTAGS, type InstagramConcept } from "./schema.ts";

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConceptValidation {
  valid: boolean;
  checks: ValidationCheck[];
  prohibited: ProhibitedMatch[];
}

/**
 * Every generated concept passes through all four checks. They are recorded
 * individually against the draft so a reviewer sees exactly which gate failed
 * rather than a single opaque verdict.
 */
export function validateConcept(
  concept: InstagramConcept,
  approvedClaims: readonly ApprovedClaimRecord[],
): ConceptValidation {
  const approvedById = new Map(approvedClaims.map((claim) => [claim.id, claim]));
  const checks: ValidationCheck[] = [];

  const unknown = concept.citedClaimIds.filter((id) => !approvedById.has(id));
  checks.push({
    name: "claim_citation",
    passed: concept.citedClaimIds.length > 0 && unknown.length === 0,
    detail:
      concept.citedClaimIds.length === 0
        ? "The concept cites no approved claim."
        : unknown.length > 0
          ? `Cites claims that are not approved with evidence: ${unknown.join(", ")}.`
          : `Cites ${concept.citedClaimIds.length} approved claim(s).`,
  });

  // Only wording the concept actually cites may exempt a prohibited term, so a
  // model cannot launder banned language by citing an unrelated claim.
  const citedWordings = concept.citedClaimIds
    .map((id) => approvedById.get(id)?.wording)
    .filter((wording): wording is string => typeof wording === "string");

  const prohibited = scanConceptText(
    {
      hook: concept.hook,
      caption: concept.caption,
      visualBrief: concept.visualBrief,
      cta: concept.cta,
      trialOffer: concept.trialOffer,
      socialProofAngle: concept.socialProofAngle,
      hashtags: concept.hashtags,
    },
    { approvedWordings: citedWordings },
  );

  checks.push({
    name: "prohibited_terms",
    passed: prohibited.length === 0,
    detail:
      prohibited.length === 0
        ? "No prohibited language found."
        : prohibited
            .map((match) => `${match.field}: "${match.term}" (${match.category}) — ${match.excerpt}`)
            .join(" | "),
  });

  const lengthProblems: string[] = [];
  if (concept.hook.length > HOOK_MAX_LENGTH) lengthProblems.push(`hook ${concept.hook.length}/${HOOK_MAX_LENGTH}`);
  if (concept.caption.length > CAPTION_MAX_LENGTH) {
    lengthProblems.push(`caption ${concept.caption.length}/${CAPTION_MAX_LENGTH}`);
  }
  if (concept.hashtags.length > MAX_HASHTAGS) {
    lengthProblems.push(`hashtags ${concept.hashtags.length}/${MAX_HASHTAGS}`);
  }
  checks.push({
    name: "channel_limits",
    passed: lengthProblems.length === 0,
    detail: lengthProblems.length === 0 ? "Within Instagram limits." : `Exceeds: ${lengthProblems.join(", ")}.`,
  });

  // The business objective is first trial, so a concept with no reason to buy
  // now is incomplete even when it is factually clean.
  const hasTrialLever = concept.trialOffer.trim().length > 0 && concept.cta.trim().length > 0;
  checks.push({
    name: "trial_lever",
    passed: hasTrialLever,
    detail: hasTrialLever ? "Has a call to action and a trial offer." : "Missing a call to action or trial offer.",
  });

  return { valid: checks.every((check) => check.passed), checks, prohibited };
}
