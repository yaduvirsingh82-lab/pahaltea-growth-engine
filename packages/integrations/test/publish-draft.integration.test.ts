import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { generateInstagramConcepts } from "../../ai/src/generate.ts";
import { OfflineTemplateProvider } from "../../ai/src/providers/offline.ts";
import { listDrafts, reviewDraft } from "../../ai/src/review.ts";
import { ORGANISATION_ID } from "../../db/src/seed/catalogue.ts";
import { seedClaimCatalogue } from "../../db/src/seed/run.ts";
import { createTestDatabase, databaseSkipReason, type TestDatabase } from "../../db/test/support/database.ts";
import type { MediaStore, UploadedMedia } from "../src/media/r2.ts";
import type { MetaConfig } from "../src/meta/config.ts";
import { publishDraft } from "../src/publish-draft.ts";
import { FakeGraphServer } from "./support/graph-server.ts";

const skip = databaseSkipReason();
const IG = "17841400000000000";

/** Serves uploaded bytes so assertPubliclyReachable exercises a real fetch. */
class LocalMediaStore implements MediaStore {
  readonly kind = "local-test";
  readonly #server: Server;
  readonly #objects = new Map<string, Uint8Array>();
  #port = 0;
  public = true;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<LocalMediaStore> {
    let store: LocalMediaStore;
    const server = createServer((req, res) => {
      const key = (req.url ?? "/").replace(/^\//, "");
      const body = store.#objects.get(key);
      if (!body || !store.public) {
        res.statusCode = body ? 403 : 404;
        res.end();
        return;
      }
      res.setHeader("content-type", "image/jpeg");
      res.end(Buffer.from(body));
    });
    store = new LocalMediaStore(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    store.#port = (server.address() as AddressInfo).port;
    return store;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async upload(input: { body: Uint8Array; contentType: string; key: string }): Promise<UploadedMedia> {
    this.#objects.set(input.key, input.body);
    return {
      key: input.key,
      url: `${this.baseUrl}/${input.key}`,
      sha256: "0".repeat(64),
      bytes: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

test("publishing an approved draft", { skip, concurrency: false }, async (suite) => {
  let db: TestDatabase;
  let graph: FakeGraphServer;
  let media: LocalMediaStore;
  let imagePath: string;
  const reviewer = randomUUID();
  const creator = randomUUID();

  const metaConfig = (): MetaConfig => ({
    loginKind: "facebook",
    graphHost: graph.host,
    graphProtocol: "http",
    apiVersion: "v25.0",
    accessToken: "EAAtest_token_value_1234567890",
    igUserId: IG,
  });

  /** Generates a batch and approves one draft, returning its id. */
  async function approvedDraft(): Promise<string> {
    await generateInstagramConcepts(db.pool, {
      organisationId: ORGANISATION_ID,
      createdBy: creator,
      provider: new OfflineTemplateProvider(),
      environment: "development",
      count: 1,
    });
    const [draft] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });
    const result = await reviewDraft(db.pool, {
      draftId: draft.id,
      reviewerId: reviewer,
      reviewerRoles: ["marketing_approver"],
      decision: "approved",
      environment: "development",
    });
    assert.equal(result.applied, true, result.reason);
    return draft.id;
  }

  async function enableWriteConnection(): Promise<void> {
    await db.pool.query(
      `INSERT INTO integration_connections
         (organisation_id, provider, mode, account_id, credential_reference, enabled, approved_by, approved_at)
       VALUES ($1, 'instagram', 'write', $2, 'secret://managed/meta', true, $3, now())
       ON CONFLICT (organisation_id, provider, account_id)
       DO UPDATE SET mode = 'write', enabled = true, approved_by = EXCLUDED.approved_by, approved_at = now()`,
      [ORGANISATION_ID, IG, reviewer],
    );
  }

  function routeHappyPath(containerId: string, mediaId: string): void {
    graph.reset();
    graph.route(
      { path: `${IG}/media`, method: "POST", body: { id: containerId } },
      { path: containerId, body: { status_code: "FINISHED" } },
      { path: `${IG}/media_publish`, method: "POST", body: { id: mediaId } },
      { path: mediaId, body: { permalink: `https://www.instagram.com/p/${mediaId}/` } },
    );
  }

  suite.before(async () => {
    db = await createTestDatabase("publish");
    await seedClaimCatalogue(db.pool);
    graph = await FakeGraphServer.start();
    media = await LocalMediaStore.start();
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "pahaltea-media-"));
    imagePath = join(dir, "creative.jpg");
    // Minimal but genuine JPEG magic number.
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  });

  suite.after(async () => {
    await media.stop();
    await graph.stop();
    await db.close();
  });

  await suite.test("a dry run records a plan and contacts nobody", async () => {
    const draftId = await approvedDraft();
    graph.reset();

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: true,
      environment: "development",
      writeActionsEnabled: false,
      metaConfig: metaConfig(),
    });

    assert.equal(outcome.status, "planned");
    assert.equal(outcome.dryRun, true);
    assert.equal(graph.requests.length, 0, "A dry run contacted Meta.");
    assert.equal(outcome.plan?.length, 3);
    assert.ok(outcome.caption?.includes("#pahaltea"), "Hashtags missing from the caption preview.");

    const row = await db.pool.query(`SELECT dry_run, status FROM publications WHERE id = $1`, [outcome.publicationId]);
    assert.equal(row.rows[0].dry_run, true);
    assert.equal(row.rows[0].status, "planned");
  });

  await suite.test("refuses a draft that has not been approved", async () => {
    await generateInstagramConcepts(db.pool, {
      organisationId: ORGANISATION_ID,
      createdBy: creator,
      provider: new OfflineTemplateProvider(),
      environment: "development",
      count: 1,
    });
    const [unapproved] = await listDrafts(db.pool, ORGANISATION_ID, { status: "claim_validation" });

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId: unapproved.id,
      dryRun: true,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
    });
    assert.equal(outcome.status, "refused");
    assert.match(outcome.reason, /only an approved draft may be published/);
  });

  await suite.test("refuses when the copy changed after approval", async () => {
    const draftId = await approvedDraft();
    // Editing the caption breaks the hash the approval was bound to.
    await db.pool.query(`UPDATE content_drafts SET caption = caption || ' (edited)' WHERE id = $1`, [draftId]);

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: true,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
    });
    assert.equal(outcome.status, "refused");
    assert.match(outcome.reason, /must be re-approved/);
  });

  await suite.test("a live run refuses with no integration connection", async () => {
    const draftId = await approvedDraft();
    graph.reset();

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: false,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
      imagePath,
      mediaStore: media,
    });

    assert.equal(outcome.status, "refused");
    assert.match(outcome.reason, /No Instagram integration_connections row exists/);
    assert.equal(graph.requests.length, 0);
  });

  await suite.test("a live run refuses while writes are disabled, and while the connection is read-only", async () => {
    const draftId = await approvedDraft();
    await enableWriteConnection();
    graph.reset();

    const disabled = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: false,
      environment: "development",
      writeActionsEnabled: false,
      metaConfig: metaConfig(),
      imagePath,
      mediaStore: media,
    });
    assert.equal(disabled.status, "refused");
    assert.match(disabled.reason, /WRITE_ACTIONS_ENABLED/);

    await db.pool.query(`UPDATE integration_connections SET mode = 'read_only' WHERE organisation_id = $1`, [ORGANISATION_ID]);
    const readOnly = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: false,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
      imagePath,
      mediaStore: media,
    });
    assert.equal(readOnly.status, "refused");
    assert.match(readOnly.reason, /requires write mode/);
    assert.equal(graph.requests.length, 0, "A refused live run still contacted Meta.");
  });

  await suite.test("publishes, records the provider ids, and marks the draft published", async () => {
    const draftId = await approvedDraft();
    await enableWriteConnection();
    routeHappyPath("container-live", "media-live");

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: false,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
      imagePath,
      mediaStore: media,
    });

    assert.equal(outcome.status, "published", outcome.reason);
    assert.equal(outcome.mediaId, "media-live");
    assert.match(outcome.permalink ?? "", /instagram\.com/);

    const publication = await db.pool.query(
      `SELECT status, dry_run, provider_media_id, provider_container_id, permalink, approval_request_id,
              integration_connection_id, media_url, published_at
         FROM publications WHERE id = $1`,
      [outcome.publicationId],
    );
    const row = publication.rows[0];
    assert.equal(row.status, "published");
    assert.equal(row.dry_run, false);
    assert.equal(row.provider_media_id, "media-live");
    assert.equal(row.provider_container_id, "container-live");
    assert.ok(row.approval_request_id, "Publication is not bound to an approval.");
    assert.ok(row.integration_connection_id, "Publication has no connection recorded.");
    assert.ok(row.published_at);

    const draft = await db.pool.query(`SELECT status FROM content_drafts WHERE id = $1`, [draftId]);
    assert.equal(draft.rows[0].status, "published");

    const audit = await db.pool.query(
      `SELECT count(*)::int AS total FROM audit_events WHERE action = 'publication.published' AND entity_id = $1`,
      [outcome.publicationId],
    );
    assert.equal(audit.rows[0].total, 1);
  });

  await suite.test("refuses to publish the same draft and copy twice", async () => {
    const published = await db.pool.query(
      `SELECT content_draft_id FROM publications WHERE dry_run = false AND status = 'published' LIMIT 1`,
    );
    const draftId = String(published.rows[0].content_draft_id);
    await db.pool.query(`UPDATE content_drafts SET status = 'approved' WHERE id = $1`, [draftId]);
    routeHappyPath("container-second", "media-second");

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: false,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
      imagePath,
      mediaStore: media,
    });

    assert.equal(outcome.status, "refused");
    assert.match(outcome.reason, /already submitted for publishing/);
    assert.equal(graph.requestsFor("media_publish").length, 0, "The draft was published a second time.");
  });

  await suite.test("a media URL that is not publicly reachable fails before Meta is called", async () => {
    const draftId = await approvedDraft();
    await enableWriteConnection();
    graph.reset();
    media.public = false;

    try {
      const outcome = await publishDraft(db.pool, {
        organisationId: ORGANISATION_ID,
        draftId,
        dryRun: false,
        environment: "development",
        writeActionsEnabled: true,
        metaConfig: metaConfig(),
        imagePath,
        mediaStore: media,
      });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.reason, /HTTP 403|public access/);
      assert.equal(graph.requests.length, 0, "Meta was called with an unreachable image.");
    } finally {
      media.public = true;
    }
  });

  await suite.test("a Graph failure is recorded against the publication and the draft is not marked published", async () => {
    const draftId = await approvedDraft();
    await enableWriteConnection();
    graph.reset();
    graph.route({
      path: `${IG}/media`,
      method: "POST",
      status: 400,
      body: { error: { message: "The image is not a valid format", code: 9004 } },
    });

    const outcome = await publishDraft(db.pool, {
      organisationId: ORGANISATION_ID,
      draftId,
      dryRun: false,
      environment: "development",
      writeActionsEnabled: true,
      metaConfig: metaConfig(),
      imagePath,
      mediaStore: media,
    });

    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /not a valid format/);

    const publication = await db.pool.query(`SELECT status, error FROM publications WHERE id = $1`, [outcome.publicationId]);
    assert.equal(publication.rows[0].status, "failed");
    assert.match(String(publication.rows[0].error), /not a valid format/);

    const draft = await db.pool.query(`SELECT status FROM content_drafts WHERE id = $1`, [draftId]);
    assert.equal(draft.rows[0].status, "approved", "A failed publish still marked the draft published.");
  });

  await suite.test("the database refuses a second live publication row for one draft", async () => {
    const published = await db.pool.query(
      `SELECT organisation_id, content_draft_id, payload_hash FROM publications WHERE dry_run = false LIMIT 1`,
    );
    const row = published.rows[0];
    await assert.rejects(
      () =>
        db.pool.query(
          `INSERT INTO publications (organisation_id, content_draft_id, provider, dry_run, status, payload_hash,
                                     integration_connection_id, approval_request_id)
           SELECT $1, $2, 'instagram', false, 'planned', $3, integration_connection_id, approval_request_id
             FROM publications WHERE content_draft_id = $2 AND dry_run = false LIMIT 1`,
          [row.organisation_id, row.content_draft_id, row.payload_hash],
        ),
      /publications_one_live_per_draft/,
    );
  });
});
