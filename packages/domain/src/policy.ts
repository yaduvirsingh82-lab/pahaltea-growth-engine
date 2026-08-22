import type {
  ActionKind,
  ActionRequest,
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequirement,
  Role,
} from "./types.ts";

const ownerOnly: readonly Role[] = ["owner"];
const marketingOrOwner: readonly Role[] = ["marketing_approver", "owner"];
const complianceOrOwner: readonly Role[] = ["compliance_approver", "owner"];

const sideEffectActions = new Set<ActionKind>([
  "content.publish",
  "campaign.create",
  "campaign.change",
  "campaign.spend_increase",
  "public_response.complaint_or_crisis",
  "deployment.production",
  "credential.rotate",
  "data.delete",
  "integration.write",
]);

export const defaultApprovalPolicy: ApprovalPolicy = {
  productionSpendIncreasePercent: 0,
  productionSpendIncreaseAmount: 0,
};

export function isExternalWrite(request: ActionRequest): boolean {
  return sideEffectActions.has(request.kind);
}

export function approvalRequirement(
  request: ActionRequest,
  policy: ApprovalPolicy = defaultApprovalPolicy,
): ApprovalRequirement {
  if (request.unsupportedClaimDetected) {
    return required(1, complianceOrOwner, "Unsupported claims can never be executed.");
  }

  if (request.kind === "claim.create" || request.kind === "claim.publish") {
    return required(1, complianceOrOwner, "Product claims require compliance approval.");
  }

  if (request.kind === "public_response.complaint_or_crisis") {
    return required(1, ownerOnly, "Complaint or crisis responses require owner approval.");
  }

  if (
    request.kind === "deployment.production" ||
    request.kind === "credential.rotate" ||
    request.kind === "data.delete" ||
    request.irreversible
  ) {
    return required(1, ownerOnly, "Production or irreversible actions require owner approval.");
  }

  if (request.kind === "campaign.spend_increase") {
    const exceedsPolicy =
      (request.spendIncreasePercent ?? 0) > policy.productionSpendIncreasePercent ||
      (request.spendIncreaseAmount ?? 0) > policy.productionSpendIncreaseAmount;
    return exceedsPolicy
      ? required(2, ["owner", "marketing_approver"], "Spend increase exceeds configured limits.")
      : required(1, marketingOrOwner, "Campaign spend changes require marketing approval.");
  }

  if (request.kind === "campaign.change" || request.isMajorCampaignChange) {
    return required(1, marketingOrOwner, "Campaign changes require marketing approval.");
  }

  if (request.kind === "campaign.create" || request.kind === "content.publish" || request.kind === "integration.write") {
    return required(1, marketingOrOwner, "External writes require marketing approval.");
  }

  return { required: false, minimumApprovals: 0, eligibleRoles: [], reason: "Analysis-only action." };
}

export function canExecute(
  request: ActionRequest,
  decisions: readonly ApprovalDecision[],
  policy: ApprovalPolicy = defaultApprovalPolicy,
): { allowed: boolean; reason: string } {
  if (request.environment === "production" && isExternalWrite(request)) {
    return { allowed: false, reason: "Production external writes are disabled by foundation policy." };
  }
  if (request.unsupportedClaimDetected) {
    return { allowed: false, reason: "Unsupported claims cannot be executed." };
  }

  const requirement = approvalRequirement(request, policy);
  if (!requirement.required) return { allowed: true, reason: "No approval required for analysis-only action." };

  const accepted = decisions.filter(
    (decision) =>
      decision.requestId === request.id &&
      decision.decision === "approved" &&
      decision.payloadHash === request.payloadHash &&
      decision.approverId !== request.actorId &&
      decision.approverRoles.some((role) => requirement.eligibleRoles.includes(role)),
  );

  const distinctApprovers = new Set(accepted.map((decision) => decision.approverId));
  return distinctApprovers.size >= requirement.minimumApprovals
    ? { allowed: true, reason: "Required approval is present and bound to this payload." }
    : { allowed: false, reason: "Valid, segregated approval is required before execution." };
}

function required(minimumApprovals: number, eligibleRoles: readonly Role[], reason: string): ApprovalRequirement {
  return { required: true, minimumApprovals, eligibleRoles, reason };
}
