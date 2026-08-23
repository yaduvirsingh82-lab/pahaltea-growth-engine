import { loadConfig } from "../../../apps/api/src/config.ts";
import { createPool } from "../src/client.ts";
import { runMigrations } from "../src/migrate.ts";

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const config = loadConfig();

// Production schema changes are an approval-gated release action (AGENTS.md).
// The runner refuses to guess; an operator must state the intent explicitly.
if (config.environment === "production" && !process.argv.includes("--allow-production")) {
  console.error(
    "Refusing to migrate production without --allow-production and a recorded release approval.",
  );
  process.exit(2);
}

const pool = createPool(config.databaseUrl);
try {
  const result = await runMigrations(pool, migrationsDirectory);
  for (const filename of result.alreadyApplied) console.log(`  = ${filename}`);
  for (const filename of result.applied) console.log(`  + ${filename}`);
  console.log(
    result.applied.length === 0
      ? `Schema is up to date (${result.alreadyApplied.length} migrations applied).`
      : `Applied ${result.applied.length} migration(s) to ${config.environment}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
