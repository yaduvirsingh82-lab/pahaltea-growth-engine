import assert from "node:assert/strict";
import test from "node:test";
import { canExecute, defaultApprovalPolicy } from "../src/policy.ts";
import type { ActionRequest, ApprovalDecision } from "../src/types.ts";

const base: ActionRequest = {
  id: "request-1",
  organisationId: "org-1",
  kind: "content.publish",
  environment: "staging",
  actorId: "maker-1",
  payloadHash: "payload-a",
  risk: "medium",
};

const approval: ApprovalDecision = {
  requestId: "request-1",
  approverId: "reviewer-1",
  approverRoles: ["marketing_approver"],
  payloadHash: "payload-a",
  decision: "approved",
  decidedAt: new Date(),
};

test("requires segregated marketing approval for content publishing", () => {
  assert.equal(canExecute(base, []).allowed, false);
  assert.equal(canExecute(base, [approval]).allowed, true);
});

test("rejects approval by the action maker", () => {
  assert.equal(canExecute(base, [{ ...approval, approverId: "maker-1" }]).allowed, false);
});

test("rejects an approval for a different payload", () => {
  assert.equal(canExecute(base, [{ ...approval, payloadHash: "other" }]).allowed, false);
});

test("never executes an unsupported claim", () => {
  assert.equal(canExecute({ ...base, unsupportedClaimDetected: true }, [approval]).allowed, false);
});

test("requires two distinct approvers for spend above the configured limit", () => {
  const request = { ...base, kind: "campaign.spend_increase" as const, spendIncreaseAmount: 1 };
  const one = { ...approval, approverRoles: ["owner"] as const };
  const two = { ...approval, approverId: "reviewer-2", approverRoles: ["marketing_approver"] as const };
  assert.equal(canExecute(request, [one], defaultApprovalPolicy).allowed, false);
  assert.equal(canExecute(request, [one, two], defaultApprovalPolicy).allowed, true);
});

test("hard-stops all production external writes", () => {
  assert.equal(canExecute({ ...base, environment: "production" }, [approval]).allowed, false);
});
