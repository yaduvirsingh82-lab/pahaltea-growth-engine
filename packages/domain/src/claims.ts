export type ClaimStatus = "draft" | "evidence_submitted" | "compliance_review" | "approved" | "rejected" | "retired";

export interface EvidenceRecord {
  id: string;
  sourceType: "packaging" | "supplier_record" | "certification" | "internal_record" | "other";
  reference: string;
  verifiedAt?: Date;
}

export interface ProductClaim {
  id: string;
  productId: string;
  wording: string;
  status: ClaimStatus;
  version: number;
  evidence: readonly EvidenceRecord[];
  approvedAt?: Date;
  approvedBy?: string;
}

export interface ClaimTransition {
  nextStatus: ClaimStatus;
  actorId: string;
  at: Date;
}

export function transitionClaim(claim: ProductClaim, transition: ClaimTransition): ProductClaim {
  if (!allowedTransitions[claim.status].includes(transition.nextStatus)) {
    throw new Error(`Cannot transition a claim from ${claim.status} to ${transition.nextStatus}.`);
  }
  if (transition.nextStatus === "compliance_review" && claim.evidence.length === 0) {
    throw new Error("Claims need evidence before compliance review.");
  }
  if (transition.nextStatus === "approved" && claim.evidence.length === 0) {
    throw new Error("Claims cannot be approved without evidence.");
  }

  return {
    ...claim,
    status: transition.nextStatus,
    version: claim.version + 1,
    approvedAt: transition.nextStatus === "approved" ? transition.at : claim.approvedAt,
    approvedBy: transition.nextStatus === "approved" ? transition.actorId : claim.approvedBy,
  };
}

export function isApprovedClaim(claim: ProductClaim): boolean {
  return claim.status === "approved" && claim.evidence.length > 0 && Boolean(claim.approvedAt && claim.approvedBy);
}

const allowedTransitions: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ["evidence_submitted", "rejected"],
  evidence_submitted: ["compliance_review", "draft", "rejected"],
  compliance_review: ["approved", "rejected", "evidence_submitted"],
  approved: ["retired"],
  rejected: ["draft"],
  retired: [],
};
