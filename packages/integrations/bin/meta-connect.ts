import { loadConfig } from "../../../apps/api/src/config.ts";
import { createPool } from "../../db/src/client.ts";
import { PostgresAuditRepository } from "../../db/src/repositories/audit.ts";
import { withTransaction } from "../../db/src/client.ts";
import { ORGANISATION_ID } from "../../db/src/seed/catalogue.ts";
import { loadMetaConfig } from "../src/meta/config.ts";

/**
 * Records the owner-approved Instagram connection that a live publish requires.
 *
 * This writes an approval, so it deliberately demands an explicit owner id and
 * an explicit --mode. It stores a credential *reference*, never a token.
 */
const argv = process.argv.slice(2);
const value = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

const owner = value("--owner");
const mode = value("--mode");
const validModes = ["offline", "sandbox", "read_only", "write"];

if (argv.includes("--help") || !owner || !mode) {
  console.log(`Record the owner-approved Instagram integration connection.

Usage: npm run meta:connect -- --owner <uuid> --mode <mode> [--account <ig-user-id>]

  --owner <uuid>    The owner approving this connection. Recorded on the row and audited.
  --mode <mode>     ${validModes.join(" | ")}. Publishing requires 'write'.
  --account <id>    Instagram account id. Defaults to META_IG_USER_ID.
  --disable         Set enabled = false instead of true.

Enabling a write connection is an owner decision: it is one of the gates that
allows this system to post publicly as Pahal Tea. No token is stored here — the
row holds a reference, and the token stays in the environment.`);
  process.exit(owner && mode ? 0 : 2);
}

if (!validModes.includes(mode)) {
  console.error(`--mode must be one of: ${validModes.join(", ")}`);
  process.exit(2);
}

const config = loadConfig();
const metaConfig = loadMetaConfig();
const accountId = value("--account") ?? metaConfig.igUserId;
if (!accountId) {
  console.error("No Instagram account id. Pass --account <ig-user-id> or set META_IG_USER_ID.");
  process.exit(2);
}

const enabled = !argv.includes("--disable");
const pool = createPool(config.databaseUrl);

try {
  const connectionId = await withTransaction(pool, async (tx) => {
    const result = await tx.query(
      `INSERT INTO integration_connections
         (organisation_id, provider, mode, account_id, credential_reference, enabled, approved_by, approved_at)
       VALUES ($1, 'instagram', $2, $3, 'env://META_ACCESS_TOKEN', $4, $5, now())
       ON CONFLICT (organisation_id, provider, account_id) DO UPDATE
         SET mode = EXCLUDED.mode, enabled = EXCLUDED.enabled,
             approved_by = EXCLUDED.approved_by, approved_at = now()
       RETURNING id`,
      [value("--organisation") ?? ORGANISATION_ID, mode, accountId, enabled, owner],
    );
    const id = String(result.rows[0].id);

    await new PostgresAuditRepository(tx).append({
      organisationId: value("--organisation") ?? ORGANISATION_ID,
      actorId: owner,
      action: enabled ? `integration.enabled.${mode}` : "integration.disabled",
      entityType: "integration_connection",
      entityId: id,
      payloadHash: `${mode}:${accountId}:${enabled}`,
      correlationId: id,
      occurredAt: new Date(),
    });
    return id;
  });

  console.log(`Connection ${connectionId}`);
  console.log(`  provider  instagram`);
  console.log(`  account   ${accountId}`);
  console.log(`  mode      ${mode}`);
  console.log(`  enabled   ${enabled}`);
  console.log(`  approved  ${owner}`);
  if (mode === "write" && enabled) {
    console.log("\nThis connection now permits publishing, subject to the remaining gates.");
    console.log("Check them with: npm run meta:verify");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
