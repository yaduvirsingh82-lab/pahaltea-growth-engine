import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { withTransaction, type PoolLike, type Queryable } from "../../db/src/client.ts";
import { PostgresAuditRepository } from "../../db/src/repositories/audit.ts";
import { PostgresIdempotencyRepository } from "../../db/src/repositories/idempotency.ts";
import { admitWrite, type IntegrationConnection } from "../../domain/src/integrations.ts";
import type { Environment } from "../../domain/src/types.ts";
import { assertPublishableImage, assertPubliclyReachable, mediaKeyFor, type MediaStore, type UploadedMedia } from "./media/r2.ts";
import type { MetaConfig } from "./meta/config.ts";
import { InstagramPublisher, type PublishPlan } from "./meta/publish.ts";

export interface PublishDraftOptions {
  organisationId: string;
  draftId: string;
  /** Default true everywhere. A live publish must be asked for explicitly. */
  dryRun: boolean;
  environment: Environment;
  writeActionsEnabled: boolean;
  metaConfig: MetaConfig;
  igUserId?: string;
  /** Local JPEG to publish. Required for a live run. */
  imagePath?: string;
  mediaStore?: MediaStore;
  actorId?: string;
}

export interface PublishDraftOutcome {
  publicationId?: string;
  dryRun: boolean;
  status: "planned" | "published" | "refused" | "failed";
  reason: string;
  plan?: { method: string; path: string; params: Record<string, string> }[];
  caption?: string;
  mediaUrl?: string;
  mediaId?: string;
  permalink?: string;
}

interface DraftRow {
  id: string;
  organisationId: string;
  status: string;
  caption: string;
  hashtags: string[];
  hook: string;
  conceptName: string;
  payloadHash: string;
}

/**
 * Publishes one approved draft to Instagram, or describes exactly what a live
 * run would do.
 *
 * Every refusal returns a reason instead of throwing, so the CLI can print the
 * precise gate and the attempt can be recorded. The order of checks matters:
 * the cheap governance checks run before anything is uploaded or sent.
 */
export async function publishDraft(pool: PoolLike, options: PublishDraftOptions): Promise<PublishDraftOutcome> {
  const draft = await loadDraft(pool, options.draftId);
  if (!draft) return refuse(options.dryRun, `No draft with id ${options.draftId}.`);
  if (draft.organisationId !== options.organisationId) {
    return refuse(options.dryRun, "Draft belongs to a different organisation.");
  }
  if (draft.status !== "approved") {
    return refuse(
      options.dryRun,
      `Draft is ${draft.status}; only an approved draft may be published. Approve it with: npm run content:review -- --approve ${draft.id} --reviewer <uuid> --role marketing_approver`,
    );
  }

  const approval = await loadApproval(pool, options.organisationId, draft.payloadHash);
  if (!approval) {
    return refuse(
      options.dryRun,
      "No approval is bound to this draft's current copy. If the copy changed after approval, it must be re-approved.",
    );
  }

  const caption = buildCaption(draft);
  const igUserId = options.igUserId ?? options.metaConfig.igUserId;
  if (!igUserId) return refuse(options.dryRun, "META_IG_USER_ID is not set and no Instagram account id was supplied.");

  // ---- Dry run: record the plan, contact nobody. ----
  if (options.dryRun) {
    const publisher = new InstagramPublisher(options.metaConfig);
    const plan = publisher.describe({ igUserId, imageUrl: "<uploaded-media-url>", caption }).requests;

    const publicationId = await withTransaction(pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO publications
           (organisation_id, content_draft_id, provider, dry_run, status, payload_hash)
         VALUES ($1, $2, 'instagram', true, 'planned', $3)
         RETURNING id`,
        [options.organisationId, draft.id, draft.payloadHash],
      );
      const id = String(inserted.rows[0].id);
      await new PostgresAuditRepository(tx).append({
        organisationId: options.organisationId,
        actorId: options.actorId ?? null,
        action: "publication.dry_run",
        entityType: "publication",
        entityId: id,
        payloadHash: draft.payloadHash,
        correlationId: approval.id,
        occurredAt: new Date(),
      });
      return id;
    });

    return {
      publicationId,
      dryRun: true,
      status: "planned",
      reason: "Dry run only. No request was sent to Meta.",
      plan,
      caption,
    };
  }

  // ---- Live: every gate must hold before anything leaves the machine. ----
  const connection = await loadConnection(pool, options.organisationId);
  if (!connection) {
    return refuse(
      false,
      "No Instagram integration_connections row exists. A connection in write mode, enabled and approved by an owner, is required before publishing.",
    );
  }

  const admission = admitWrite({
    connection,
    writeActionsEnabled: options.writeActionsEnabled,
    approvalVerified: true,
    payloadHash: draft.payloadHash,
  });
  if (!admission.admitted) return refuse(false, admission.reason);

  if (!options.imagePath) return refuse(false, "A live publish needs --image <path-to-jpeg>.");
  if (!options.mediaStore) return refuse(false, "No media store is configured; Cloudflare R2 credentials are required.");

  const bytes = new Uint8Array(await readFile(options.imagePath));
  assertPublishableImage(bytes, "image/jpeg");

  // One live publication per draft, enforced by a unique index as well as here.
  const idempotency = new PostgresIdempotencyRepository(pool, options.organisationId);
  const reserved = await idempotency.reserve(
    `instagram:publish:${draft.id}:${draft.payloadHash}`,
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );
  if (!reserved) {
    return refuse(false, "This draft and copy were already submitted for publishing. Refusing to post it twice.");
  }

  let uploaded: UploadedMedia;
  let publicationId: string;
  try {
    uploaded = await options.mediaStore.upload({
      body: bytes,
      contentType: "image/jpeg",
      key: mediaKeyFor(draft.id, sha256Of(bytes)),
    });
    // Instagram fetches the image itself; a private object fails opaquely.
    await assertPubliclyReachable(uploaded.url);

    publicationId = await withTransaction(pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO publications
           (organisation_id, content_draft_id, integration_connection_id, provider, dry_run, status,
            approval_request_id, payload_hash, media_url, media_sha256, attempts)
         VALUES ($1, $2, $3, 'instagram', false, 'planned', $4, $5, $6, $7, 1)
         RETURNING id`,
        [
          options.organisationId,
          draft.id,
          connection.id,
          approval.id,
          draft.payloadHash,
          uploaded.url,
          uploaded.sha256,
        ],
      );
      return String(inserted.rows[0].id);
    });
  } catch (error) {
    return { dryRun: false, status: "failed", reason: describe(error) };
  }

  const publisher = new InstagramPublisher({ ...options.metaConfig, igUserId });
  const plan: PublishPlan = { igUserId, imageUrl: uploaded.url, caption };

  try {
    const result = await publisher.publish(plan, {
      onStep: async (step, detail) => {
        if (step === "container_created") {
          await pool.query(`UPDATE publications SET status = 'container_created', provider_container_id = $2 WHERE id = $1`, [
            publicationId,
            detail.containerId,
          ]);
        }
      },
    });

    await withTransaction(pool, async (tx) => {
      await tx.query(
        `UPDATE publications
            SET status = 'published', provider_media_id = $2, permalink = $3, published_at = now()
          WHERE id = $1`,
        [publicationId, result.mediaId, result.permalink ?? null],
      );
      await tx.query(`UPDATE content_drafts SET status = 'published' WHERE id = $1`, [draft.id]);
      await new PostgresAuditRepository(tx).append({
        organisationId: options.organisationId,
        actorId: options.actorId ?? null,
        action: "publication.published",
        entityType: "publication",
        entityId: publicationId,
        payloadHash: draft.payloadHash,
        correlationId: approval.id,
        occurredAt: new Date(),
      });
    });

    return {
      publicationId,
      dryRun: false,
      status: "published",
      reason: "Published to Instagram.",
      caption,
      mediaUrl: uploaded.url,
      mediaId: result.mediaId,
      permalink: result.permalink,
    };
  } catch (error) {
    const message = describe(error);
    await pool
      .query(`UPDATE publications SET status = 'failed', error = $2 WHERE id = $1`, [publicationId, message])
      .catch(() => undefined);
    await new PostgresAuditRepository(pool)
      .append({
        organisationId: options.organisationId,
        actorId: options.actorId ?? null,
        action: "publication.failed",
        entityType: "publication",
        entityId: publicationId,
        payloadHash: draft.payloadHash,
        correlationId: approval.id,
        occurredAt: new Date(),
      })
      .catch(() => undefined);
    return { publicationId, dryRun: false, status: "failed", reason: message, mediaUrl: uploaded.url };
  }
}

/** Caption as it will appear: body first, hashtags on their own line. */
export function buildCaption(draft: Pick<DraftRow, "caption" | "hashtags">): string {
  const tags = (draft.hashtags ?? []).filter((tag) => tag.trim() !== "");
  return tags.length > 0 ? `${draft.caption}\n\n${tags.join(" ")}` : draft.caption;
}

async function loadDraft(executor: Queryable, draftId: string): Promise<DraftRow | undefined> {
  const result = await executor.query(
    `SELECT id, organisation_id, status, coalesce(caption,'') AS caption, hashtags,
            coalesce(hook,'') AS hook, coalesce(concept_name,'') AS concept_name,
            encode(sha256(convert_to(
              coalesce(concept_name,'') || E'\n' || coalesce(hook,'') || E'\n' || coalesce(caption,'') || E'\n' ||
              coalesce(cta,'') || E'\n' || coalesce(trial_offer,'') || E'\n' || coalesce(social_proof_angle,''),
              'UTF8')), 'hex') AS payload_hash
       FROM content_drafts WHERE id = $1`,
    [draftId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: String(row.id),
    organisationId: String(row.organisation_id),
    status: String(row.status),
    caption: String(row.caption),
    hashtags: (row.hashtags as string[]) ?? [],
    hook: String(row.hook),
    conceptName: String(row.concept_name),
    payloadHash: String(row.payload_hash),
  };
}

/** An approval only counts when it is bound to the copy as it stands now. */
async function loadApproval(
  executor: Queryable,
  organisationId: string,
  payloadHash: string,
): Promise<{ id: string } | undefined> {
  const result = await executor.query(
    `SELECT r.id
       FROM approval_requests r
       JOIN approval_decisions d ON d.approval_request_id = r.id
      WHERE r.organisation_id = $1
        AND r.action_kind = 'content.publish'
        AND r.payload_hash = $2
        AND d.decision = 'approved'
        AND d.payload_hash = $2
        AND r.expires_at > now()
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [organisationId, payloadHash],
  );
  return result.rows[0] ? { id: String(result.rows[0].id) } : undefined;
}

async function loadConnection(executor: Queryable, organisationId: string): Promise<IntegrationConnection | undefined> {
  const result = await executor.query(
    `SELECT id, organisation_id, provider, mode, account_id, credential_reference, enabled
       FROM integration_connections
      WHERE organisation_id = $1 AND provider = 'instagram'
      ORDER BY created_at DESC LIMIT 1`,
    [organisationId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: String(row.id),
    organisationId: String(row.organisation_id),
    provider: "instagram",
    mode: row.mode as IntegrationConnection["mode"],
    accountId: String(row.account_id),
    credentialReference: String(row.credential_reference),
    enabled: Boolean(row.enabled),
  };
}

function refuse(dryRun: boolean, reason: string): PublishDraftOutcome {
  return { dryRun, status: "refused", reason };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
