import { loadMetaConfig, missingForPublish, requiredScopes } from "../src/meta/config.ts";
import { verifyMetaSetup } from "../src/meta/verify.ts";

const config = loadMetaConfig();
const report = await verifyMetaSetup(config);

console.log(`Meta / Instagram preflight — login path "${config.loginKind}", ${config.graphHost}/${config.apiVersion}\n`);
for (const check of report.checks) {
  const marker = check.status === "pass" ? "pass " : check.status === "fail" ? "FAIL " : "skip ";
  console.log(`${marker} ${check.name}`);
  console.log(`       ${check.detail}`);
}

if (report.ok) {
  console.log(`\nReady. Instagram ${report.igUsername ? `@${report.igUsername} ` : ""}(${report.igUserId}) can be published to.`);
  console.log("Next: npm run meta:publish -- --draft <id>   (dry run by default)");
  process.exit(0);
}

const gates = missingForPublish(config);
console.log("\nNOT READY. Exact remaining steps:\n");

if (gates.length > 0) {
  console.log("In Meta (developers.facebook.com):");
  console.log("  1. Create or open your app, then add the 'Instagram' product.");
  console.log(`  2. Request these permissions: ${requiredScopes[config.loginKind].join(", ")}.`);
  console.log("  3. Generate a long-lived access token for the account that owns the Instagram profile.");
  console.log("\nThen set these environment variables:");
  for (const gate of gates) console.log(`  ${gate.variable}\n    ${gate.why}`);
} else {
  console.log("Configuration is present but a live check failed. Fix the FAIL line(s) above and re-run.");
}

console.log("\nRe-run this command after each change: npm run meta:verify");
process.exitCode = 1;
