import assert from "node:assert/strict";
import test from "node:test";
import { admitWrite } from "../../domain/src/integrations.ts";
import type { IntegrationConnection } from "../../domain/src/integrations.ts";
import { assertPublishableImage, loadR2Config, mediaKeyFor, missingForUpload } from "../src/media/r2.ts";
import { InstagramPublisher } from "../src/meta/publish.ts";
import type { MetaConfig } from "../src/meta/config.ts";
import { buildCaption } from "../src/publish-draft.ts";
import { FakeGraphServer } from "./support/graph-server.ts";

const IG = "17841400000000000";

const writable: IntegrationConnection = {
  id: "conn-1",
  organisationId: "org-1",
  provider: "instagram",
  mode: "write",
  accountId: IG,
  credentialReference: "secret://managed/meta",
  enabled: true,
};

function configFor(server: FakeGraphServer): MetaConfig {
  return {
    loginKind: "facebook",
    graphHost: server.host,
    graphProtocol: "http",
    apiVersion: "v25.0",
    accessToken: "EAAtest_token_value_1234567890",
    appSecret: "secret",
    igUserId: IG,
  };
}

const noWait = { intervalMs: 0, sleep: async () => {} };

test("write admission", async (suite) => {
  const base = { connection: writable, writeActionsEnabled: true, approvalVerified: true, payloadHash: "abc" };

  await suite.test("admits only when every condition holds", () => {
    const admission = admitWrite(base);
    assert.equal(admission.admitted, true, admission.reason);
  });

  await suite.test("refuses when writes are not enabled for the process", () => {
    const admission = admitWrite({ ...base, writeActionsEnabled: false });
    assert.equal(admission.admitted, false);
    assert.match(admission.reason, /WRITE_ACTIONS_ENABLED/);
  });

  await suite.test("refuses a connection that is not in write mode", () => {
    for (const mode of ["offline", "sandbox", "read_only"] as const) {
      const admission = admitWrite({ ...base, connection: { ...writable, mode } });
      assert.equal(admission.admitted, false, `${mode} was admitted for writing.`);
      assert.match(admission.reason, /requires write mode/);
    }
  });

  await suite.test("refuses a disabled connection and one with no credential reference", () => {
    assert.equal(admitWrite({ ...base, connection: { ...writable, enabled: false } }).admitted, false);
    assert.equal(admitWrite({ ...base, connection: { ...writable, credentialReference: "" } }).admitted, false);
  });

  await suite.test("refuses without a verified approval bound to the payload", () => {
    assert.equal(admitWrite({ ...base, approvalVerified: false }).admitted, false);
    assert.equal(admitWrite({ ...base, payloadHash: "" }).admitted, false);
  });
});

test("media handling", async (suite) => {
  await suite.test("names every missing R2 variable", () => {
    const gates = missingForUpload(loadR2Config({}));
    assert.deepEqual(gates.map((gate) => gate.variable), [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PUBLIC_BASE_URL",
    ]);
  });

  await suite.test("requires a public base URL because Instagram fetches the image itself", () => {
    const gates = missingForUpload(
      loadR2Config({
        R2_ACCOUNT_ID: "acc",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "media",
      }),
    );
    assert.deepEqual(gates.map((gate) => gate.variable), ["R2_PUBLIC_BASE_URL"]);
    assert.match(gates[0].why, /without authentication/);
  });

  await suite.test("trims a trailing slash off the public base URL", () => {
    assert.equal(loadR2Config({ R2_PUBLIC_BASE_URL: "https://media.example.com/" }).publicBaseUrl, "https://media.example.com");
  });

  await suite.test("rejects anything that is not a real JPEG", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    assert.doesNotThrow(() => assertPublishableImage(jpeg, "image/jpeg"));

    assert.throws(() => assertPublishableImage(jpeg, "image/png"), /must be JPEG/);
    // A PNG magic number renamed to .jpg must not slip through.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    assert.throws(() => assertPublishableImage(png, "image/jpeg"), /not a JPEG/);
    assert.throws(() => assertPublishableImage(new Uint8Array([0xff]), "image/jpeg"), /not a JPEG/);
  });

  await suite.test("media keys are content-addressed per draft", () => {
    const key = mediaKeyFor("draft-1", "a".repeat(64));
    assert.match(key, /^creatives\/draft-1\/a{16}\.jpg$/);
    assert.notEqual(key, mediaKeyFor("draft-2", "a".repeat(64)));
  });
});

test("caption assembly", async (suite) => {
  await suite.test("puts hashtags on their own line after the body", () => {
    assert.equal(buildCaption({ caption: "Body copy.", hashtags: ["#a", "#b"] }), "Body copy.\n\n#a #b");
  });

  await suite.test("omits the hashtag block entirely when there are none", () => {
    assert.equal(buildCaption({ caption: "Body copy.", hashtags: [] }), "Body copy.");
    assert.equal(buildCaption({ caption: "Body copy.", hashtags: ["  "] }), "Body copy.");
  });
});

test("instagram publisher", async (suite) => {
  const server = await FakeGraphServer.start();
  suite.after(async () => await server.stop());

  await suite.test("describe() contacts nobody", async () => {
    server.reset();
    const plan = new InstagramPublisher(configFor(server)).describe({
      igUserId: IG,
      imageUrl: "https://media.example.com/a.jpg",
      caption: "hello",
    });

    assert.equal(server.requests.length, 0, "describe() made a network call.");
    assert.deepEqual(plan.requests.map((request) => `${request.method} ${request.path}`), [
      `POST ${IG}/media`,
      "GET {creation_id}",
      `POST ${IG}/media_publish`,
    ]);
  });

  await suite.test("publishes through container, poll, publish in that order", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "container-9" } },
      { path: "container-9", body: { status_code: "FINISHED" } },
      { path: `${IG}/media_publish`, method: "POST", body: { id: "media-9" } },
      { path: "media-9", body: { permalink: "https://www.instagram.com/p/abc/" } },
    );

    const steps: string[] = [];
    const result = await new InstagramPublisher(configFor(server)).publish(
      { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
      { onStep: async (step) => void steps.push(step) },
      noWait,
    );

    assert.equal(result.mediaId, "media-9");
    assert.equal(result.containerId, "container-9");
    assert.equal(result.permalink, "https://www.instagram.com/p/abc/");
    assert.deepEqual(steps, ["container_created", "container_ready", "published"]);

    const order = server.requests.map((request) => `${request.method} ${request.path}`);
    assert.deepEqual(order.slice(0, 3), [`POST ${IG}/media`, "GET container-9", `POST ${IG}/media_publish`]);
  });

  await suite.test("sends the caption and image url on the container request", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c1" } },
      { path: "c1", body: { status_code: "FINISHED" } },
      { path: `${IG}/media_publish`, method: "POST", body: { id: "m1" } },
      { path: "m1", body: {} },
    );

    await new InstagramPublisher(configFor(server)).publish(
      { igUserId: IG, imageUrl: "https://media.example.com/x.jpg", caption: "a caption\n\n#tag", altText: "a cup of tea" },
      {},
      noWait,
    );

    const container = server.requestsFor(`${IG}/media`)[0];
    assert.equal(container.params.image_url, "https://media.example.com/x.jpg");
    assert.equal(container.params.caption, "a caption\n\n#tag");
    assert.equal(container.params.alt_text, "a cup of tea");
  });

  await suite.test("waits while the container is still processing", async () => {
    server.reset();
    let polls = 0;
    const server2 = server;
    server2.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c2" } },
      { path: `${IG}/media_publish`, method: "POST", body: { id: "m2" } },
      { path: "m2", body: {} },
    );
    // Route c2 dynamically: IN_PROGRESS twice, then FINISHED.
    server2.route({
      path: "c2",
      get body() {
        polls += 1;
        return polls < 3 ? { status_code: "IN_PROGRESS" } : { status_code: "FINISHED" };
      },
    } as never);

    const result = await new InstagramPublisher(configFor(server)).publish(
      { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
      {},
      noWait,
    );

    assert.equal(result.mediaId, "m2");
    assert.equal(polls, 3, `Expected three status polls, saw ${polls}.`);
  });

  await suite.test("never publishes a container that reported ERROR", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c3" } },
      { path: "c3", body: { status_code: "ERROR", status: "Media could not be downloaded" } },
      { path: `${IG}/media_publish`, method: "POST", body: { id: "must-not-happen" } },
    );

    await assert.rejects(
      () =>
        new InstagramPublisher(configFor(server)).publish(
          { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
          {},
          noWait,
        ),
      /could not process the media/,
    );
    assert.equal(server.requestsFor("media_publish").length, 0, "A failed container was published anyway.");
  });

  await suite.test("treats an expired container as fatal", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c4" } },
      { path: "c4", body: { status_code: "EXPIRED" } },
    );

    await assert.rejects(
      () =>
        new InstagramPublisher(configFor(server)).publish(
          { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
          {},
          noWait,
        ),
      /expired/,
    );
  });

  await suite.test("gives up after the poll budget instead of hanging", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c5" } },
      { path: "c5", body: { status_code: "IN_PROGRESS" } },
    );

    await assert.rejects(
      () =>
        new InstagramPublisher(configFor(server)).publish(
          { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
          {},
          { ...noWait, maxAttempts: 3 },
        ),
      /still IN_PROGRESS after 3 checks/,
    );
  });

  await suite.test("a publish failure surfaces the Graph error", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c6" } },
      { path: "c6", body: { status_code: "FINISHED" } },
      {
        path: `${IG}/media_publish`,
        method: "POST",
        status: 400,
        body: { error: { message: "The user is not an admin of the page", code: 200 } },
      },
    );

    await assert.rejects(
      () =>
        new InstagramPublisher(configFor(server)).publish(
          { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
          {},
          noWait,
        ),
      /not an admin of the page/,
    );
  });

  await suite.test("a missing permalink does not invalidate a successful publish", async () => {
    server.reset();
    server.route(
      { path: `${IG}/media`, method: "POST", body: { id: "c7" } },
      { path: "c7", body: { status_code: "FINISHED" } },
      { path: `${IG}/media_publish`, method: "POST", body: { id: "m7" } },
      // No route for m7: the permalink lookup 404s.
    );

    const result = await new InstagramPublisher(configFor(server)).publish(
      { igUserId: IG, imageUrl: "https://media.example.com/a.jpg", caption: "hello" },
      {},
      noWait,
    );
    assert.equal(result.mediaId, "m7");
    assert.equal(result.permalink, undefined);
  });

  await suite.test("reports remaining publishing quota", async () => {
    server.reset();
    server.route({
      path: `${IG}/content_publishing_limit`,
      body: { data: [{ quota_usage: 12, config: { quota_total: 100 } }] },
    });
    assert.equal(await new InstagramPublisher(configFor(server)).remainingQuota(IG), 88);
  });
});
