import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { MetaApiError, MetaGraphClient, redactToken } from "../src/meta/client.ts";
import { loadMetaConfig, missingForPublish, requiredScopes, type MetaConfig } from "../src/meta/config.ts";
import { verifyMetaSetup } from "../src/meta/verify.ts";
import { FakeGraphServer } from "./support/graph-server.ts";

const TOKEN = "EAAtest_token_value_1234567890";
const APP_SECRET = "app-secret";

function configFor(server: FakeGraphServer, overrides: Partial<MetaConfig> = {}): MetaConfig {
  return {
    loginKind: "facebook",
    graphHost: server.host,
    graphProtocol: "http",
    apiVersion: "v25.0",
    accessToken: TOKEN,
    appId: "app-1",
    appSecret: APP_SECRET,
    igUserId: "17841400000000000",
    ...overrides,
  };
}

test("configuration", async (suite) => {
  await suite.test("defaults to the Facebook login path and a pinned API version", () => {
    const config = loadMetaConfig({});
    assert.equal(config.loginKind, "facebook");
    assert.equal(config.graphHost, "graph.facebook.com");
    assert.match(config.apiVersion, /^v\d+\.\d+$/);
    assert.equal(config.accessToken, undefined);
  });

  await suite.test("the Instagram login path uses a different host and scopes", () => {
    const config = loadMetaConfig({ META_LOGIN_KIND: "instagram" });
    assert.equal(config.graphHost, "graph.instagram.com");
    assert.deepEqual(requiredScopes.instagram, ["instagram_business_basic", "instagram_business_content_publish"]);
    assert.notDeepEqual(requiredScopes.instagram, requiredScopes.facebook);
  });

  await suite.test("rejects an unknown login kind rather than guessing", () => {
    assert.throws(() => loadMetaConfig({ META_LOGIN_KIND: "tiktok" }), /must be 'facebook' or 'instagram'/);
  });

  await suite.test("blank environment values are treated as absent", () => {
    const config = loadMetaConfig({ META_ACCESS_TOKEN: "   ", META_IG_USER_ID: "" });
    assert.equal(config.accessToken, undefined);
    assert.equal(config.igUserId, undefined);
  });

  await suite.test("names the exact missing variables", () => {
    const gates = missingForPublish(loadMetaConfig({}));
    assert.deepEqual(gates.map((gate) => gate.variable).sort(), [
      "META_ACCESS_TOKEN",
      "META_APP_SECRET",
      "META_IG_USER_ID",
    ]);
    for (const gate of gates) assert.ok(gate.why.length > 20, `${gate.variable} has no usable explanation.`);
  });

  await suite.test("a page id substitutes for an explicit Instagram account id", () => {
    const gates = missingForPublish(
      loadMetaConfig({ META_ACCESS_TOKEN: TOKEN, META_APP_SECRET: APP_SECRET, META_PAGE_ID: "123" }),
    );
    assert.deepEqual(gates, []);
  });
});

test("graph client", async (suite) => {
  const server = await FakeGraphServer.start();
  suite.after(async () => await server.stop());

  await suite.test("signs requests with appsecret_proof and carries the token", async () => {
    server.reset();
    server.route({ path: "me", body: { id: "1" } });

    await new MetaGraphClient(configFor(server)).request({ path: "me" });

    const request = server.lastRequest()!;
    assert.equal(request.params.access_token, TOKEN);
    assert.equal(
      request.params.appsecret_proof,
      createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex"),
      "appsecret_proof is missing or wrong.",
    );
  });

  await suite.test("omits appsecret_proof when no app secret is configured", async () => {
    server.reset();
    server.route({ path: "me", body: { id: "1" } });

    await new MetaGraphClient(configFor(server, { appSecret: undefined })).request({ path: "me" });
    assert.equal(server.lastRequest()!.params.appsecret_proof, undefined);
  });

  await suite.test("POSTs parameters as a form body, not a query string", async () => {
    server.reset();
    server.route({ path: "123/media", method: "POST", body: { id: "container-1" } });

    await new MetaGraphClient(configFor(server)).request({
      path: "123/media",
      method: "POST",
      params: { image_url: "https://example.com/a.jpg", caption: "hello world" },
    });

    const request = server.lastRequest()!;
    assert.equal(request.method, "POST");
    assert.equal(request.params.caption, "hello world");
    assert.equal(request.params.image_url, "https://example.com/a.jpg");
  });

  await suite.test("maps a Graph error envelope into a typed error", async () => {
    server.reset();
    server.route({
      path: "me",
      status: 400,
      body: { error: { message: "Invalid OAuth token", code: 190, error_subcode: 463, type: "OAuthException", fbtrace_id: "AbC" } },
    });

    const error = await new MetaGraphClient(configFor(server)).request({ path: "me" }).then(
      () => undefined,
      (caught) => caught as MetaApiError,
    );

    assert.ok(error instanceof MetaApiError);
    assert.equal(error.code, 190);
    assert.equal(error.subcode, 463);
    assert.equal(error.type, "OAuthException");
    assert.equal(error.fbtraceId, "AbC");
    assert.equal(error.retryable, false, "An invalid token must not be retried.");
  });

  await suite.test("marks rate limits and server faults retryable", async () => {
    for (const [code, status] of [[4, 400], [17, 400], [32, 400], [613, 400], [0, 503]] as const) {
      server.reset();
      server.route({ path: "me", status, body: { error: { message: "throttled", code } } });
      const error = await new MetaGraphClient(configFor(server)).request({ path: "me" }).then(
        () => undefined,
        (caught) => caught as MetaApiError,
      );
      assert.equal(error?.retryable, true, `code ${code} / status ${status} should be retryable.`);
    }
  });

  await suite.test("refuses to call the API with no token", async () => {
    await assert.rejects(
      () => new MetaGraphClient(configFor(server, { accessToken: undefined })).request({ path: "me" }),
      /META_ACCESS_TOKEN is not configured/,
    );
  });

  await suite.test("never leaks a token into an error message", () => {
    assert.equal(redactToken(`failed for ${TOKEN}`), "failed for EAA<redacted>");
    assert.equal(redactToken("IGQVJmockmockmockmock123"), "IGQ<redacted>");
  });
});

test("preflight verification", async (suite) => {
  const server = await FakeGraphServer.start();
  suite.after(async () => await server.stop());

  const healthy = () => {
    server.reset();
    server.route(
      {
        path: "debug_token",
        body: { data: { is_valid: true, app_id: "app-1", expires_at: 0, scopes: [...requiredScopes.facebook] } },
      },
      { path: "17841400000000000", body: { id: "17841400000000000", username: "pahaltea" } },
      {
        path: "17841400000000000/content_publishing_limit",
        body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] },
      },
    );
  };

  await suite.test("reports ready when every real check passes", async () => {
    healthy();
    const report = await verifyMetaSetup(configFor(server));

    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
    assert.equal(report.igUsername, "pahaltea");
    assert.equal(report.quotaUsed, 3);
    assert.equal(report.quotaCap, 100);
    assert.deepEqual(report.checks.map((check) => check.status), ["pass", "pass", "pass", "pass", "pass"]);
  });

  await suite.test("skips every live check and stays not-ready without a token", async () => {
    server.reset(); // clear the recorder so the "no calls made" assertion is meaningful
    const report = await verifyMetaSetup(configFor(server, { accessToken: undefined }));
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].status, "fail");
    assert.ok(report.checks.slice(1).every((check) => check.status === "skipped"));
    assert.equal(server.requestsFor("debug_token").length, 0, "A Graph call was attempted without a token.");
  });

  await suite.test("fails when a required permission was not granted", async () => {
    server.reset();
    server.route(
      { path: "debug_token", body: { data: { is_valid: true, app_id: "app-1", scopes: ["instagram_basic"] } } },
      { path: "17841400000000000", body: { id: "17841400000000000", username: "pahaltea" } },
      { path: "17841400000000000/content_publishing_limit", body: { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } },
    );

    const report = await verifyMetaSetup(configFor(server));
    assert.equal(report.ok, false);
    const permissions = report.checks.find((check) => check.name === "permissions")!;
    assert.equal(permissions.status, "fail");
    assert.match(permissions.detail, /instagram_content_publish/);
  });

  await suite.test("fails on an invalid token", async () => {
    server.reset();
    server.route(
      { path: "debug_token", body: { data: { is_valid: false } } },
      { path: "17841400000000000", body: { id: "17841400000000000" } },
      { path: "17841400000000000/content_publishing_limit", body: { data: [{ quota_usage: 0 }] } },
    );

    const report = await verifyMetaSetup(configFor(server));
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "token")!.status, "fail");
  });

  await suite.test("discovers the Instagram account from a linked Page", async () => {
    server.reset();
    server.route(
      { path: "debug_token", body: { data: { is_valid: true, app_id: "app-1", scopes: [...requiredScopes.facebook] } } },
      {
        path: "9988",
        body: { id: "9988", name: "Pahal Tea", instagram_business_account: { id: "17841499999999999", username: "pahaltea" } },
      },
      { path: "17841499999999999/content_publishing_limit", body: { data: [{ quota_usage: 0, config: { quota_total: 100 } }] } },
    );

    const report = await verifyMetaSetup(configFor(server, { igUserId: undefined, pageId: "9988" }));
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
    assert.equal(report.igUserId, "17841499999999999");
  });

  await suite.test("says so plainly when the Page has no linked Instagram account", async () => {
    server.reset();
    server.route(
      { path: "debug_token", body: { data: { is_valid: true, app_id: "app-1", scopes: [...requiredScopes.facebook] } } },
      { path: "9988", body: { id: "9988", name: "Pahal Tea" } },
    );

    const report = await verifyMetaSetup(configFor(server, { igUserId: undefined, pageId: "9988" }));
    assert.equal(report.ok, false);
    const account = report.checks.find((check) => check.name === "instagram_account")!;
    assert.equal(account.status, "fail");
    assert.match(account.detail, /no linked Instagram professional account/);
  });
});
