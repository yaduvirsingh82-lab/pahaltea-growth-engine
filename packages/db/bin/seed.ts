import { loadConfig } from "../../../apps/api/src/config.ts";
import { createPool } from "../src/client.ts";
import { seedClaimCatalogue } from "../src/seed/run.ts";
import { seedClaims } from "../src/seed/catalogue.ts";

const config = loadConfig();

if (config.environment === "production" && !process.argv.includes("--allow-production")) {
  console.error("Refusing to seed production without --allow-production and a recorded approval.");
  process.exit(2);
}

const pool = createPool(config.databaseUrl);
try {
  const summary = await seedClaimCatalogue(pool);
  console.log(`Organisation ${summary.organisationId}`);
  console.log(`Product      ${summary.productId}`);
  console.log(`Evidence     ${summary.evidenceWritten} record(s)`);
  console.log(`Claims       ${summary.claimsChanged.length} written/updated, ${summary.claimsUnchanged.length} unchanged`);
  console.log(`             ${summary.approvedClaimCount} approved, ${summary.withheldClaimCount} withheld from approval`);

  for (const claim of seedClaims) {
    if (claim.withheldReason) console.log(`\nWITHHELD  "${claim.wording}"\n          ${claim.withheldReason}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
