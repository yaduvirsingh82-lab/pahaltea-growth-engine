/**
 * Deterministic prohibited-language scan.
 *
 * AGENTS.md forbids inventing or implying certifications, awards, health or
 * wellness benefits, exact spice compositions, provenance beyond the approved
 * wording, comparative claims, and sustainability claims. A model cannot be
 * trusted to police itself on this, so the check runs after generation and
 * before anything is persisted as reviewable.
 *
 * This is a blunt instrument on purpose. A false positive costs a regenerated
 * concept; a false negative costs a consumer-protection or platform-policy
 * breach.
 */

export type ProhibitedCategory =
  | "health_or_wellness"
  | "certification"
  | "award"
  | "comparative"
  | "sustainability"
  | "spice_composition"
  | "unapproved_provenance"
  | "fabricated_social_proof";

export interface ProhibitedRule {
  category: ProhibitedCategory;
  /** Matched case-insensitively on word boundaries. */
  terms: readonly string[];
  reason: string;
}

export const prohibitedRules: readonly ProhibitedRule[] = [
  {
    category: "health_or_wellness",
    terms: [
      "immunity", "immune", "detox", "detoxify", "antioxidant", "antioxidants", "cure", "cures", "curing",
      "heal", "heals", "healing", "medicinal", "therapeutic", "remedy", "wellness benefit", "health benefit",
      "metabolism", "weight loss", "slimming", "fat burning", "digestion", "digestive", "gut health",
      "anti-inflammatory", "inflammation", "cholesterol", "blood sugar", "diabetes", "stress relief",
      "relieves stress", "reduces stress", "anxiety", "energy boost", "boosts energy", "detoxifying",
      "good for you", "healthy", "nutritious", "vitamin", "vitamins", "mineral rich",
    ],
    reason: "Health or wellness benefits are prohibited: no approved evidence supports them.",
  },
  {
    category: "certification",
    terms: [
      "certified", "certification", "iso", "usda", "fssai approved", "organic certified", "certified organic",
      "fair trade", "fairtrade", "rainforest alliance", "gmp", "haccp", "lab tested", "clinically proven",
      "clinically tested", "accredited",
    ],
    reason: "Certification claims are prohibited: no certification evidence is approved.",
  },
  {
    category: "award",
    terms: [
      "award winning", "award-winning", "prize winning", "best tea", "no.1", "no. 1", "number one",
      "#1", "top rated", "top-rated", "bestselling", "best selling", "best-selling", "voted",
    ],
    reason: "Award, ranking, or bestseller claims are prohibited: none are evidenced.",
  },
  {
    category: "comparative",
    terms: [
      "better than", "best in", "superior to", "unlike other", "unlike any other", "beats", "outperforms",
      "the finest", "finest tea", "purest", "highest quality", "unmatched", "second to none", "world class",
      "world-class",
    ],
    reason: "Comparative or superlative claims about other brands are prohibited.",
  },
  {
    category: "sustainability",
    terms: [
      "sustainable", "sustainably", "sustainability", "eco-friendly", "eco friendly", "carbon neutral",
      "carbon-neutral", "zero waste", "zero-waste", "environmentally friendly", "green practices",
      "plastic free", "plastic-free", "biodegradable", "compostable",
    ],
    reason: "Sustainability claims are prohibited: none are evidenced or approved.",
  },
  {
    category: "spice_composition",
    terms: [
      "cardamom", "elaichi", "cinnamon", "dalchini", "ginger", "adrak", "clove", "cloves", "laung",
      "black pepper", "peppercorn", "kali mirch", "fennel", "saunf", "star anise", "nutmeg", "jaiphal",
      "mace", "bay leaf", "tulsi", "lemongrass",
    ],
    reason:
      "Naming individual spices discloses an exact composition that AGENTS.md reserves to the product packet.",
  },
  {
    category: "unapproved_provenance",
    terms: [
      "darjeeling", "nilgiri", "ceylon", "kangra", "munnar", "himalayan", "single estate", "single-estate",
      "high grown", "high-grown", "hand picked", "hand-picked", "handpicked", "hand plucked", "artisanal",
      "small batch", "small-batch", "farm to cup", "farm-to-cup", "direct trade",
    ],
    // Deliberately does not restate the approved origin: this string is
    // interpolated into the system prompt, and product facts belong in the
    // retrieved claim list, not in a prompt template.
    reason:
      "Provenance beyond what the approved claim list states is prohibited.",
  },
  {
    category: "fabricated_social_proof",
    terms: [
      "customers say", "customers love", "thousands of", "millions of", "5-star", "five star", "five-star",
      "rated 4", "rated 5", "reviews say", "loved by", "trusted by", "join thousands", "our customers rave",
      "testimonial",
    ],
    reason:
      "Social proof must not assert reviews, ratings, or customer counts that no ingested data supports.",
  },
];

export interface ProhibitedMatch {
  category: ProhibitedCategory;
  term: string;
  field: string;
  reason: string;
  excerpt: string;
}

export interface ProhibitedScanOptions {
  /**
   * Wordings of the approved claims cited by this content. A prohibited term is
   * exempt when it appears inside approved claim wording, so approved language
   * is never flagged as if the model invented it.
   */
  approvedWordings?: readonly string[];
}

/** Scans one named field. */
export function scanField(
  field: string,
  text: string,
  options: ProhibitedScanOptions = {},
): ProhibitedMatch[] {
  const exempt = (options.approvedWordings ?? []).map((wording) => wording.toLowerCase());
  const matches: ProhibitedMatch[] = [];

  for (const rule of prohibitedRules) {
    for (const term of rule.terms) {
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(term)})(?=$|[^\\p{L}\\p{N}])`, "iu");
      const found = pattern.exec(text);
      if (!found) continue;
      if (exempt.some((wording) => wording.includes(term.toLowerCase()))) continue;

      const index = found.index + found[1].length;
      matches.push({
        category: rule.category,
        term,
        field,
        reason: rule.reason,
        excerpt: excerptAround(text, index, term.length),
      });
    }
  }
  return matches;
}

/** Scans every free-text field of a concept. */
export function scanConceptText(
  fields: Readonly<Record<string, string | readonly string[]>>,
  options: ProhibitedScanOptions = {},
): ProhibitedMatch[] {
  const matches: ProhibitedMatch[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const text = Array.isArray(value) ? value.join(" ") : String(value);
    matches.push(...scanField(field, text, options));
  }
  return matches;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
