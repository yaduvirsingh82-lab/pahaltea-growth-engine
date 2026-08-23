import { createHash } from "node:crypto";
import type { PoolLike, Queryable } from "../client.ts";
import { withTransaction } from "../client.ts";
import { PostgresAuditRepository } from "../repositories/audit.ts";
import { uuidV5 } from "../uuid.ts";
import {
  BRAND_OWNER_ACTOR_ID,
  claimId,
  evidenceId,
  HERO_PRODUCT_ID,
  HERO_PRODUCT_NAME,
  ORGANISATION_ID,
  ORGANISATION_NAME,
  seedClaims,
  seedEvidence,
} from "./catalogue.ts";

/** Stable correlation ID so every application of this seed is traceable as one lineage. */
const SEED_CORRELATION_ID = uuidV5("seed-run:pahal-tea-claim-catalogue");

export interface SeedSummary {
  organisationId: string;
  productId: string;
  evidenceWritten: number;
  claimsChanged: readonly string[];
  claimsUnchanged: readonly string[];
  approvedClaimCount: number;
  withheldClaimCount: number;
}

/**
 * Idempotent. Rows carry deterministic version-5 UUIDs, so a second run updates
 * the same records and emits audit events only for values that actually
 * changed. Everything commits in one transaction with its audit trail.
 */
export async function seedClaimCatalogue(pool: PoolLike, now: Date = new Date()): Promise<SeedSummary> {
  return withTransaction(pool, async (tx) => {
    const audit = new PostgresAuditRepository(tx);

    await tx.query(
      `INSERT INTO organisations (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name WHERE organisations.name IS DISTINCT FROM EXCLUDED.name`,
      [ORGANISATION_ID, ORGANISATION_NAME],
    );

    await tx.query(
      `INSERT INTO products (id, organisation_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name WHERE products.name IS DISTINCT FROM EXCLUDED.name`,
      [HERO_PRODUCT_ID, ORGANISATION_ID, HERO_PRODUCT_NAME],
    );

    for (const evidence of seedEvidence) {
      await tx.query(
        `INSERT INTO evidence_records (id, organisation_id, source_type, reference, verified_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET source_type = EXCLUDED.source_type, reference = EXCLUDED.reference
         WHERE evidence_records.source_type IS DISTINCT FROM EXCLUDED.source_type
            OR evidence_records.reference IS DISTINCT FROM EXCLUDED.reference`,
        [evidenceId(evidence.key), ORGANISATION_ID, evidence.sourceType, evidence.reference, now],
      );
    }

    const claimsChanged: string[] = [];
    const claimsUnchanged: string[] = [];

    for (const claim of seedClaims) {
      const id = claimId(claim.key);
      const isApproved = claim.status === "approved";

      const result = await tx.query(
        `INSERT INTO claims (id, organisation_id, product_id, wording, status, version, approved_at, approved_by)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
         ON CONFLICT (id) DO UPDATE
           SET wording = EXCLUDED.wording,
               status = EXCLUDED.status,
               approved_at = EXCLUDED.approved_at,
               approved_by = EXCLUDED.approved_by,
               version = claims.version + 1
         WHERE claims.wording IS DISTINCT FROM EXCLUDED.wording
            OR claims.status IS DISTINCT FROM EXCLUDED.status
         RETURNING id`,
        [
          id,
          ORGANISATION_ID,
          HERO_PRODUCT_ID,
          claim.wording,
          claim.status,
          isApproved ? now : null,
          isApproved ? BRAND_OWNER_ACTOR_ID : null,
        ],
      );

      // A claim can never be approved without at least one evidence link; the
      // domain rejects it and the seed must not create a row the domain would.
      if (claim.evidenceKeys.length === 0) {
        throw new Error(`Seed claim ${claim.key} has no evidence and cannot be persisted.`);
      }
      for (const evidenceKey of claim.evidenceKeys) {
        await tx.query(
          `INSERT INTO claim_evidence_links (claim_id, evidence_record_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [id, evidenceId(evidenceKey)],
        );
      }

      if ((result.rowCount ?? 0) > 0) {
        claimsChanged.push(claim.key);
        await audit.append({
          organisationId: ORGANISATION_ID,
          actorId: BRAND_OWNER_ACTOR_ID,
          action: isApproved ? "claim.seeded_approved" : "claim.seeded_pending_owner_decision",
          entityType: "claim",
          entityId: id,
          payloadHash: hashClaim(claim.wording, claim.status),
          correlationId: SEED_CORRELATION_ID,
          occurredAt: now,
        });
      } else {
        claimsUnchanged.push(claim.key);
      }
    }

    return {
      organisationId: ORGANISATION_ID,
      productId: HERO_PRODUCT_ID,
      evidenceWritten: seedEvidence.length,
      claimsChanged,
      claimsUnchanged,
      approvedClaimCount: seedClaims.filter((claim) => claim.status === "approved").length,
      withheldClaimCount: seedClaims.filter((claim) => claim.status !== "approved").length,
    };
  });
}

/** Reads the catalogue back through the same shape the domain validator expects. */
export async function loadApprovedClaims(executor: Queryable, organisationId: string = ORGANISATION_ID) {
  const result = await executor.query(
    `SELECT c.id, c.product_id, c.wording, c.status, c.version, c.approved_at, c.approved_by,
            COALESCE(json_agg(json_build_object('id', e.id, 'sourceType', e.source_type, 'reference', e.reference))
                     FILTER (WHERE e.id IS NOT NULL), '[]') AS evidence
       FROM claims c
       LEFT JOIN claim_evidence_links l ON l.claim_id = c.id
       LEFT JOIN evidence_records e ON e.id = l.evidence_record_id
      WHERE c.organisation_id = $1
      GROUP BY c.id
      ORDER BY c.wording`,
    [organisationId],
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    wording: String(row.wording),
    status: row.status as (typeof seedClaims)[number]["status"],
    version: Number(row.version),
    evidence: row.evidence as { id: string; sourceType: string; reference: string }[],
    approvedAt: row.approved_at ? new Date(row.approved_at as string) : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
  }));
}

function hashClaim(wording: string, status: string): string {
  return createHash("sha256").update(`${status}\n${wording}`, "utf8").digest("hex");
}
