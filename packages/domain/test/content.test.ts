import assert from "node:assert/strict";
import test from "node:test";
import { moveContentToReview, validateContentClaims, type ContentDraft } from "../src/content.ts";
import { transitionClaim, type ProductClaim } from "../src/claims.ts";

const claim: ProductClaim = {
  id: "claim-1",
  productId: "product-1",
  wording: "Approved wording held in the catalogue.",
  status: "compliance_review",
  version: 3,
  evidence: [{ id: "evidence-1", sourceType: "packaging", reference: "package-record" }],
};

const draft: ContentDraft = {
  id: "content-1",
  organisationId: "org-1",
  channel: "instagram",
  body: "Draft body.",
  citedClaimIds: ["claim-1"],
  status: "draft",
  createdBy: "author-1",
};

test("requires evidence before a claim can enter review", () => {
  assert.throws(() => transitionClaim({ ...claim, status: "evidence_submitted", evidence: [] }, { nextStatus: "compliance_review", actorId: "author", at: new Date() }));
});

test("allows only approved and evidenced claims into content review", () => {
  const approved = transitionClaim(claim, { nextStatus: "approved", actorId: "compliance-1", at: new Date() });
  assert.equal(validateContentClaims(draft, [approved]).valid, true);
  assert.equal(moveContentToReview(draft, [approved]).status, "review");
});

test("blocks drafts with no cited claims or a retired claim", () => {
  assert.equal(validateContentClaims({ ...draft, citedClaimIds: [] }, [claim]).valid, false);
  assert.throws(() => moveContentToReview(draft, [claim]));
});
