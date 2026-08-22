import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0003_integration_admission.sql", import.meta.url);

test("integration migration stores only credential references and webhook hashes", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /credential_reference text NOT NULL/);
  assert.match(sql, /payload_hash text NOT NULL/);
  assert.doesNotMatch(sql, /raw_payload/i);
  assert.match(sql, /CHECK \(\(enabled = false\) OR \(approved_by IS NOT NULL AND approved_at IS NOT NULL\)\)/);
});

test("integration migration enforces unique idempotency and provider-event keys", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /UNIQUE \(organisation_id, key\)/);
  assert.match(sql, /UNIQUE \(organisation_id, provider, provider_event_id\)/);
});
