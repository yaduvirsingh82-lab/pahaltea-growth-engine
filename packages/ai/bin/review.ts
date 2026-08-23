import { loadConfig } from "../../../apps/api/src/config.ts";
import { createPool } from "../../db/src/client.ts";
import { ORGANISATION_ID } from "../../db/src/seed/catalogue.ts";
import { roles as allRoles } from "../../domain/src/types.ts";
import type { Role } from "../../domain/src/types.ts";
import { getDraft, listDrafts, reviewDraft } from "../src/review.ts";

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Review generated Instagram content drafts.

Usage: npm run content:review -- [options]

  (no options)               List drafts newest first
  --status <s>               Filter the list by status
  --show <draft-id>          Print one draft in full with its validation checks
  --approve <draft-id>       Approve a draft (requires --reviewer and --role)
  --reject <draft-id>        Reject a draft (requires --reviewer and --role)
  --reviewer <uuid>          The approving actor. Must not be the draft creator.
  --role <role>              ${allRoles.join(" | ")}
  --note "<text>"            Review note stored with the decision

Approval records an approval_requests/approval_decisions pair bound to the
draft's payload hash. It does NOT publish: publishing is not implemented and
remains blocked by policy.`);
  process.exit(0);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const showId = value("--show");
  const approveId = value("--approve");
  const rejectId = value("--reject");

  if (approveId || rejectId) {
    const reviewer = value("--reviewer");
    const role = value("--role");
    if (!reviewer || !role) {
      console.error("Both --reviewer <uuid> and --role <role> are required to record a decision.");
      process.exit(2);
    }
    if (!allRoles.includes(role as Role)) {
      console.error(`--role must be one of: ${allRoles.join(", ")}`);
      process.exit(2);
    }

    const result = await reviewDraft(pool, {
      draftId: (approveId ?? rejectId)!,
      reviewerId: reviewer,
      reviewerRoles: [role as Role],
      decision: approveId ? "approved" : "rejected",
      note: value("--note"),
      environment: config.environment,
    });

    console.log(result.applied ? `OK  ${result.reason} Status is now ${result.status}.` : `REFUSED  ${result.reason}`);
    if (result.applied && approveId) {
      console.log("\nApproved for release. Publishing is not implemented; nothing has been sent to Instagram.");
    }
    process.exitCode = result.applied ? 0 : 1;
  } else if (showId) {
    const draft = await getDraft(pool, showId);
    if (!draft) {
      console.error(`No draft with id ${showId}.`);
      process.exit(1);
    }

    console.log(`${draft.conceptName}   [${draft.status}]`);
    console.log(`${draft.format} · ${draft.objective} · via ${draft.provider}${draft.isOfflineStub ? " (OFFLINE PLACEHOLDER)" : ""}`);
    console.log(`\nHOOK\n  ${draft.hook}`);
    console.log(`\nCAPTION\n${indent(draft.caption)}`);
    console.log(`\nVISUAL BRIEF\n${indent(draft.visualBrief)}`);
    console.log(`\nCTA\n  ${draft.cta}`);
    console.log(`\nTRIAL OFFER\n  ${draft.trialOffer}`);
    console.log(`\nSOCIAL PROOF ANGLE\n  ${draft.socialProofAngle}`);
    console.log(`\nHASHTAGS\n  ${draft.hashtags.join(" ")}`);
    console.log(`\nRATIONALE\n${indent(draft.rationale)}`);
    console.log(`\nCITED APPROVED CLAIMS`);
    for (const claim of draft.citedClaims) console.log(`  - ${claim.wording}`);
    console.log(`\nVALIDATION`);
    for (const check of draft.checks) console.log(`  ${check.passed ? "pass" : "FAIL"}  ${check.name}: ${check.detail}`);
    if (draft.reviewedBy) console.log(`\nReviewed by ${draft.reviewedBy}${draft.reviewNote ? `: ${draft.reviewNote}` : ""}`);
  } else {
    const drafts = await listDrafts(pool, value("--organisation") ?? ORGANISATION_ID, { status: value("--status") });
    if (drafts.length === 0) {
      console.log("No drafts. Generate some with: npm run content:generate");
    } else {
      for (const draft of drafts) {
        const flags = [
          draft.isOfflineStub ? "OFFLINE" : "",
          draft.failedChecks.length > 0 ? `FAILED:${draft.failedChecks.join(",")}` : "",
        ].filter(Boolean).join(" ");
        console.log(`${draft.id}  ${draft.status.padEnd(17)} ${draft.format.padEnd(10)} ${draft.conceptName}`);
        console.log(`  ${draft.hook}`);
        if (flags) console.log(`  ${flags}`);
      }
      console.log(`\n${drafts.length} draft(s). Inspect one with: npm run content:review -- --show <id>`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
