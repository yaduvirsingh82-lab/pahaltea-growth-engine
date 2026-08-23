import { createHash } from "node:crypto";
import type { Queryable } from "../../db/src/client.ts";

/**
 * Retrieval is intentionally narrow: only claims that are currently `approved`
 * with at least one evidence link are eligible to reach a prompt. A claim
 * sitting in compliance_review — such as "Ethically Grown" — is invisible here,
 * so the model cannot cite what an owner has not released.
 */
export interface ApprovedClaimRecord {
  id: string;
  productId: string;
  productName: string;
  wording: string;
  version: number;
  evidenceReferences: string[];
}

export interface ClaimSnapshot {
  claims: readonly ApprovedClaimRecord[];
  /** Stable hash of the exact claim set and versions handed to the model. */
  hash: string;
}

export async function retrieveApprovedClaims(
  executor: Queryable,
  organisationId: string,
): Promise<ClaimSnapshot> {
  const result = await executor.query(
    `SELECT c.id,
            c.product_id,
            p.name AS product_name,
            c.wording,
            c.version,
            COALESCE(
              array_agg(e.reference ORDER BY e.reference) FILTER (WHERE e.id IS NOT NULL),
              ARRAY[]::text[]
            ) AS evidence_references
       FROM claims c
       JOIN products p ON p.id = c.product_id
       JOIN claim_evidence_links l ON l.claim_id = c.id
       JOIN evidence_records e ON e.id = l.evidence_record_id
      WHERE c.organisation_id = $1
        AND c.status = 'approved'
        AND c.approved_at IS NOT NULL
        AND c.approved_by IS NOT NULL
      GROUP BY c.id, p.name
      ORDER BY c.wording`,
    [organisationId],
  );

  const claims: ApprovedClaimRecord[] = result.rows.map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    productName: String(row.product_name),
    wording: String(row.wording),
    version: Number(row.version),
    evidenceReferences: (row.evidence_references as string[]) ?? [],
  }));

  return { claims, hash: snapshotHash(claims) };
}

export function snapshotHash(claims: readonly ApprovedClaimRecord[]): string {
  const canonical = [...claims]
    .map((claim) => `${claim.id}@${claim.version}:${claim.wording}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Records the snapshot so a draft can be traced to the exact truth it was built from. */
export async function persistSnapshot(
  executor: Queryable,
  organisationId: string,
  snapshot: ClaimSnapshot,
): Promise<void> {
  await executor.query(
    `INSERT INTO retrieval_snapshots (hash, organisation_id, claim_ids)
     VALUES ($1, $2, $3::uuid[])
     ON CONFLICT (hash) DO NOTHING`,
    [snapshot.hash, organisationId, snapshot.claims.map((claim) => claim.id)],
  );
}
