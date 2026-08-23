import { loadConfig } from "../../../apps/api/src/config.ts";
import { createPool } from "../../db/src/client.ts";
import { ORGANISATION_ID } from "../../db/src/seed/catalogue.ts";
import { uuidV5 } from "../../db/src/uuid.ts";
import { generateInstagramConcepts } from "../src/generate.ts";
import { resolveProvider } from "../src/providers/index.ts";
import { contentObjectives, instagramFormats } from "../src/schema.ts";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Generate Instagram content concepts from approved product claims.

Usage: npm run content:generate -- [options]

  --count <n>          Number of concepts (default 3)
  --format <f>         ${instagramFormats.join(" | ")}
  --objective <o>      ${contentObjectives.join(" | ")}
  --brief "<text>"     Styling guidance for the model. Never a source of facts.
  --provider <id>      ollama | anthropic | offline-template (default: auto-detect)
  --created-by <uuid>  Actor recorded as the draft creator
  --dry-run            Resolve the provider and print the plan without generating

Provider resolution prefers Ollama (local, free, open source), then Anthropic,
then the deterministic offline generator in development only.`);
  process.exit(0);
}

const config = loadConfig();
const organisationId = args.organisation ?? ORGANISATION_ID;
// Deterministic identity for machine-generated drafts, so segregation of
// duties can be enforced against a stable "creator".
const createdBy = args.createdBy ?? uuidV5("actor:pahal-tea:content-generator");

let resolved;
try {
  resolved = await resolveProvider({ requested: args.provider, environment: config.environment });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`Provider : ${resolved.provider.id} (${resolved.provider.model})`);
console.log(`Reason   : ${resolved.reason}`);
for (const entry of resolved.considered) console.log(`           tried ${entry.id}: ${entry.detail}`);
if (resolved.provider.isOfflineStub) {
  console.log("\n!! OFFLINE GENERATOR — output is deterministic placeholder copy, not model output.");
  console.log("!! Every draft is flagged is_offline_stub in generation_runs. Do not publish it.\n");
}

if (args.dryRun) {
  console.log("\nDry run: no generation performed.");
  process.exit(0);
}

const pool = createPool(config.databaseUrl);
try {
  const outcome = await generateInstagramConcepts(pool, {
    organisationId,
    createdBy,
    provider: resolved.provider,
    environment: config.environment,
    count: args.count ?? 3,
    format: args.format,
    objective: args.objective,
    brief: args.brief,
  });

  console.log(`\nRun ${outcome.runId}`);
  console.log(`Claims retrieved : ${outcome.claimsRetrieved} (snapshot ${outcome.retrievalSnapshotHash.slice(0, 12)})`);
  console.log(`Drafts persisted : ${outcome.drafts.length} (${outcome.rejected} failed validation)`);
  for (const draft of outcome.drafts) {
    console.log(`  ${draft.valid ? "ok    " : "FAILED"}  ${draft.id}  ${draft.conceptName}`);
  }
  console.log(`\nReview them with: npm run content:review`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const count = value("--count");
  const format = value("--format");
  const objective = value("--objective");

  if (format && !instagramFormats.includes(format as never)) {
    console.error(`--format must be one of: ${instagramFormats.join(", ")}`);
    process.exit(2);
  }
  if (objective && !contentObjectives.includes(objective as never)) {
    console.error(`--objective must be one of: ${contentObjectives.join(", ")}`);
    process.exit(2);
  }

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    dryRun: argv.includes("--dry-run"),
    count: count ? Number(count) : undefined,
    format: format as (typeof instagramFormats)[number] | undefined,
    objective: objective as (typeof contentObjectives)[number] | undefined,
    brief: value("--brief"),
    provider: value("--provider"),
    organisation: value("--organisation"),
    createdBy: value("--created-by"),
  };
}
