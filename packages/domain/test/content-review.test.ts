import assert from "node:assert/strict";
import test from "node:test";
import {
  applyContentReview,
  contentReviewRoles,
  evaluateContentReview,
  type ContentDraft,
  type ContentReviewDecision,
} from "../src/content.ts";
import { approvalRequirement } from "../src/policy.ts";
import type { ActionRequest } from "../src/types.ts";

const draft: ContentDraft = {
  id: "draft-1",
  organisationId: "org-1",
  channel: "instagram",
  body: "caption",
  citedClaimIds: ["claim-1"],
  status: "claim_validation",
  createdBy: "creator",
};

const decision = (overrides: Partial<ContentReviewDecision> = {}): ContentReviewDecision => ({
  draftId: draft.id,
  reviewerId: "reviewer",
  reviewerRoles: ["marketing_approver"],
  decision: "approved",
  decidedAt: new Date(),
  ...overrides,
});

test("an eligible, segregated reviewer may release content", () => {
  const outcome = evaluateContentReview(draft, decision());
  assert.equal(outcome.allowed, true, outcome.reason);
  assert.equal(applyContentReview(draft, decision()).status, "approved");
});

test("the creator of a draft can never review it", () => {
  const outcome = evaluateContentReview(draft, decision({ reviewerId: "creator" }));
  assert.equal(outcome.allowed, false);
  assert.match(outcome.reason, /cannot be reviewed by the actor who created it/);
  assert.throws(() => applyContentReview(draft, decision({ reviewerId: "creator" })));
});

test("roles outside marketing and owner cannot review", () => {
  for (const role of ["viewer", "analyst", "developer", "auditor", "operator"] as const) {
    const outcome = evaluateContentReview(draft, decision({ reviewerRoles: [role as never] }));
    assert.equal(outcome.allowed, false, `${role} was allowed to review.`);
  }
  for (const role of contentReviewRoles) {
    assert.equal(evaluateContentReview(draft, decision({ reviewerRoles: [role] })).allowed, true);
  }
});

test("content already decided cannot be reviewed again", () => {
  for (const status of ["approved", "published", "archived", "scheduled"] as const) {
    const outcome = evaluateContentReview({ ...draft, status }, decision());
    assert.equal(outcome.allowed, false, `${status} was reviewable.`);
  }
});

test("rejection archives rather than deletes", () => {
  assert.equal(applyContentReview(draft, decision({ decision: "rejected" })).status, "archived");
});

test("review roles stay aligned with the content.publish approval policy", () => {
  const request: ActionRequest = {
    id: "req-1",
    organisationId: "org-1",
    kind: "content.publish",
    environment: "development",
    actorId: "creator",
    payloadHash: "hash",
    risk: "medium",
  };
  const requirement = approvalRequirement(request);
  assert.equal(requirement.required, true);
  assert.deepEqual([...requirement.eligibleRoles].sort(), [...contentReviewRoles].sort());
});
