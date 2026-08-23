import { loadConfig } from "../../../apps/api/src/config.ts";
import { createPool } from "../../db/src/client.ts";
import { ORGANISATION_ID } from "../../db/src/seed/catalogue.ts";
import { loadMetaConfig } from "../src/meta/config.ts";
import { loadR2Config, missingForUpload, R2MediaStore } from "../src/media/r2.ts";
import { publishDraft } from "../src/publish-draft.ts";

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

if (argv.includes("--help") || argv.includes("-h") || !value("--draft")) {
  console.log(`Publish one approved draft to Instagram.

Usage: npm run meta:publish -- --draft <id> [options]

  --draft <id>     The approved content draft to publish
  --image <path>   Local JPEG to publish. Required for --live.
  --live           Actually publish. WITHOUT THIS FLAG NOTHING IS SENT.
  --actor <uuid>   Actor recorded on the audit event

Dry run is the default and contacts nobody: it records the plan and prints the
exact Graph requests a live run would make.

A live run additionally requires all of:
  - the draft is approved, and the approval is bound to the current copy
  - an enabled instagram integration_connections row in write mode
  - WRITE_ACTIONS_ENABLED=true
  - Meta and Cloudflare R2 credentials in the environment`);
  process.exit(value("--draft") ? 0 : 2);
}

const config = loadConfig();
const metaConfig = loadMetaConfig();
const live = argv.includes("--live");

let mediaStore;
if (live) {
  const r2 = loadR2Config();
  const gates = missingForUpload(r2);
  if (gates.length > 0) {
    console.error("Cloudflare R2 is not configured. Missing:\n");
    for (const gate of gates) console.error(`  ${gate.variable}\n    ${gate.why}`);
    process.exit(1);
  }
  mediaStore = new R2MediaStore(r2);
}

const pool = createPool(config.databaseUrl);
try {
  const outcome = await publishDraft(pool, {
    organisationId: value("--organisation") ?? ORGANISATION_ID,
    draftId: value("--draft")!,
    dryRun: !live,
    environment: config.environment,
    writeActionsEnabled: config.writeActionsEnabled,
    metaConfig,
    imagePath: value("--image"),
    mediaStore,
    actorId: value("--actor"),
  });

  console.log(`${outcome.dryRun ? "DRY RUN" : "LIVE"}  ${outcome.status.toUpperCase()}`);
  console.log(outcome.reason);

  if (outcome.caption) console.log(`\n--- caption as it will appear ---\n${outcome.caption}\n---`);

  if (outcome.plan) {
    console.log("\nRequests a live run would send:");
    for (const request of outcome.plan) {
      console.log(`  ${request.method} /${request.path}`);
      for (const [key, param] of Object.entries(request.params)) {
        console.log(`      ${key}=${param.length > 90 ? `${param.slice(0, 90)}…` : param}`);
      }
    }
    console.log("\nNothing was sent. Re-run with --live --image <file.jpg> once every gate above is satisfied.");
  }

  if (outcome.mediaId) {
    console.log(`\nInstagram media id: ${outcome.mediaId}`);
    if (outcome.permalink) console.log(`Permalink: ${outcome.permalink}`);
  }

  process.exitCode = outcome.status === "refused" || outcome.status === "failed" ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
