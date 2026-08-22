export const roles = [
  "owner",
  "compliance_approver",
  "marketing_approver",
  "operator",
  "developer",
  "auditor",
  "viewer",
] as const;

export type Role = (typeof roles)[number];
export type Environment = "development" | "staging" | "production";

export type ActionKind =
  | "claim.create"
  | "claim.publish"
  | "content.publish"
  | "campaign.create"
  | "campaign.change"
  | "campaign.spend_increase"
  | "public_response.complaint_or_crisis"
  | "deployment.production"
  | "credential.rotate"
  | "data.delete"
  | "integration.write";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface Actor {
  id: string;
  organisationId: string;
  roles: readonly Role[];
}

export interface ActionRequest {
  id: string;
  organisationId: string;
  kind: ActionKind;
  environment: Environment;
  actorId: string;
  payloadHash: string;
  risk: RiskLevel;
  approvedClaimIds?: readonly string[];
  unsupportedClaimDetected?: boolean;
  isMajorCampaignChange?: boolean;
  spendIncreasePercent?: number;
  spendIncreaseAmount?: number;
  irreversible?: boolean;
}

export interface ApprovalRequirement {
  required: boolean;
  minimumApprovals: number;
  eligibleRoles: readonly Role[];
  reason: string;
}

export interface ApprovalDecision {
  requestId: string;
  approverId: string;
  approverRoles: readonly Role[];
  payloadHash: string;
  decision: "approved" | "rejected";
  decidedAt: Date;
}

export interface ApprovalPolicy {
  productionSpendIncreasePercent: number;
  productionSpendIncreaseAmount: number;
}
