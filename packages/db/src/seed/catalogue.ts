import type { ClaimStatus } from "../../../domain/src/claims.ts";
import { uuidV5 } from "../uuid.ts";

/**
 * The approved product-truth catalogue transcribed from the "Source of truth
 * for product claims" section of AGENTS.md. Nothing here may be invented,
 * broadened, or rephrased into marketing language: this file is a transcription
 * of owner-authored fact, and generated copy cites these rows by ID.
 */

export const ORGANISATION_NAME = "Pahal Tea";
export const HERO_PRODUCT_NAME = "Masala Tea";

export const ORGANISATION_ID = uuidV5("organisation:pahal-tea");
export const HERO_PRODUCT_ID = uuidV5("product:pahal-tea:masala-tea");

/**
 * Placeholder identity for the brand owner who authored AGENTS.md. There is no
 * users table yet; when identity lands, this ID must be reconciled with the
 * real owner account rather than left as an orphan.
 */
export const BRAND_OWNER_ACTOR_ID = uuidV5("actor:pahal-tea:brand-owner");

export type EvidenceSourceType = "packaging" | "supplier_record" | "certification" | "internal_record" | "other";

export interface SeedEvidence {
  key: string;
  sourceType: EvidenceSourceType;
  reference: string;
}

export interface SeedClaim {
  key: string;
  wording: string;
  status: ClaimStatus;
  evidenceKeys: readonly string[];
  /** Present only when a claim is deliberately withheld from approved status. */
  withheldReason?: string;
}

export const seedEvidence: readonly SeedEvidence[] = [
  {
    key: "owner-catalogue",
    sourceType: "internal_record",
    reference: "AGENTS.md — Source of truth for product claims (owner-authored approved catalogue)",
  },
  {
    key: "retail-packet",
    sourceType: "packaging",
    reference: "Pahal Tea Masala Tea 200g retail packet — printed ingredient and composition panel",
  },
];

const ownerCatalogue = ["owner-catalogue"] as const;
const packetAndCatalogue = ["owner-catalogue", "retail-packet"] as const;

export const seedClaims: readonly SeedClaim[] = [
  { key: "origin-assam", wording: "Origin/garden: Assam", status: "approved", evidenceKeys: ownerCatalogue },
  { key: "grade-amchong", wording: "Tea grade/type: Amchong", status: "approved", evidenceKeys: ownerCatalogue },
  { key: "ingredients", wording: "Ingredients: Tea & Spices", status: "approved", evidenceKeys: packetAndCatalogue },
  {
    key: "spice-composition-packet",
    wording: "Exact spice composition: refer to product packet",
    status: "approved",
    evidenceKeys: packetAndCatalogue,
  },
  { key: "spice-sourcing", wording: "Spice sourcing: reliable sources", status: "approved", evidenceKeys: ownerCatalogue },
  {
    key: "no-additives",
    wording: "No added flavours, colours, preservatives, or additives",
    status: "approved",
    evidenceKeys: packetAndCatalogue,
  },
  {
    key: "garden-fresh",
    wording: "Garden Fresh: directly from where the tea is grown",
    status: "approved",
    evidenceKeys: ownerCatalogue,
  },
  {
    key: "ethically-grown",
    wording:
      "Ethically Grown: farming best practices as per Tea Board of India or trustee certification requirements",
    status: "compliance_review",
    evidenceKeys: ownerCatalogue,
    // docs/ARCHITECTURE.md §17 decision 1 records this as an unresolved owner
    // decision, so seeding it as approved would pre-empt a stated gate.
    withheldReason:
      "Owner decision 1 in docs/ARCHITECTURE.md is unresolved: the meaning and evidence behind 'Ethically Grown', and whether it may be used publicly, are not yet approved.",
  },
  {
    key: "blended-with-expertise",
    wording:
      "Blended with Expertise: composition of spices, grades of tea, and best flush of production",
    status: "approved",
    evidenceKeys: ownerCatalogue,
  },
  {
    key: "founder-experience",
    wording: "Tea/blending experience: founder's experience in tea",
    status: "approved",
    evidenceKeys: ownerCatalogue,
  },
  {
    key: "hero-sku-pack",
    wording: "Hero SKU: Masala Tea; current pack: 200g",
    status: "approved",
    evidenceKeys: packetAndCatalogue,
  },
];

export function evidenceId(key: string): string {
  return uuidV5(`evidence:pahal-tea:${key}`);
}

export function claimId(key: string): string {
  return uuidV5(`claim:pahal-tea:masala-tea:${key}`);
}
