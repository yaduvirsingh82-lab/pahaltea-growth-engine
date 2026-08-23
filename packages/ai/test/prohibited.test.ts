import assert from "node:assert/strict";
import test from "node:test";
import { prohibitedRules, scanConceptText, scanField } from "../src/prohibited.ts";

test("flags health and wellness claims", () => {
  const matches = scanField("caption", "A daily cup that boosts immunity and aids digestion.");
  const categories = matches.map((match) => match.category);
  assert.ok(categories.includes("health_or_wellness"), JSON.stringify(matches));
});

test("flags certification, award, comparative and sustainability language", () => {
  const cases: [string, string][] = [
    ["certification", "Our certified organic garden."],
    ["award", "The award-winning masala tea."],
    ["comparative", "Better than any supermarket chai."],
    ["sustainability", "Grown with sustainable, eco-friendly practices."],
  ];
  for (const [expected, text] of cases) {
    const matches = scanField("caption", text);
    assert.ok(
      matches.some((match) => match.category === expected),
      `Expected ${expected} for: ${text} — got ${JSON.stringify(matches.map((m) => m.category))}`,
    );
  }
});

test("flags named spices because exact composition belongs on the packet", () => {
  const matches = scanField("caption", "Cardamom, ginger and a hint of clove.");
  const terms = matches.filter((match) => match.category === "spice_composition").map((match) => match.term);
  assert.ok(terms.includes("cardamom"), JSON.stringify(terms));
  assert.ok(terms.includes("ginger"), JSON.stringify(terms));
});

test("flags provenance beyond the approved Assam and Amchong wording", () => {
  assert.equal(scanField("caption", "Hand-picked in Darjeeling.").length > 0, true);
  // Approved provenance must not trip the scan.
  assert.deepEqual(scanField("caption", "Grown in Assam, Amchong grade."), []);
});

test("flags fabricated social proof", () => {
  const matches = scanField("caption", "Loved by thousands of customers, rated 5 stars.");
  assert.ok(matches.some((match) => match.category === "fabricated_social_proof"));
});

test("approved claim wording exempts a term the catalogue itself uses", () => {
  const wording = "Ethically Grown: farming best practices as per Tea Board of India or trustee certification requirements";

  const withoutExemption = scanField("caption", `We follow ${wording}.`);
  assert.ok(withoutExemption.some((match) => match.term === "certification"));

  const withExemption = scanField("caption", `We follow ${wording}.`, { approvedWordings: [wording] });
  assert.equal(withExemption.some((match) => match.term === "certification"), false);
});

test("does not flag clean copy built only from approved facts", () => {
  const clean = scanConceptText({
    hook: "The cup that tastes like the morning it came from.",
    caption: "Tea and spices from Assam. No added flavours, colours, preservatives, or additives.",
    cta: "Order a pack and tell us what your first cup tasted like.",
    hashtags: ["#pahaltea", "#chai"],
  });
  assert.deepEqual(clean, []);
});

test("matches on word boundaries, not substrings", () => {
  // "iso" must not fire inside an unrelated word.
  assert.deepEqual(scanField("caption", "An isolated garden in the hills.").filter((m) => m.term === "iso"), []);
  assert.ok(scanField("caption", "ISO 9001 assured.").some((match) => match.term === "iso"));
});

test("every rule carries a category and a reason", () => {
  for (const rule of prohibitedRules) {
    assert.ok(rule.terms.length > 0, `${rule.category} has no terms.`);
    assert.ok(rule.reason.length > 10, `${rule.category} has no usable reason.`);
  }
});
