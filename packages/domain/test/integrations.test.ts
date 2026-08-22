import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { assertReadOnlyConnection, verifyMetaWebhook, verifyShopifyWebhook } from "../src/integrations.ts";

const payload = '{"id":"event-1"}';
const secret = "test-secret";

test("only permits enabled sandbox or read-only connections", () => {
  assert.doesNotThrow(() => assertReadOnlyConnection({
    id: "connection-1", organisationId: "org-1", provider: "shopify", mode: "sandbox", accountId: "test-store", credentialReference: "secret://test", enabled: true,
  }));
  assert.throws(() => assertReadOnlyConnection({
    id: "connection-2", organisationId: "org-1", provider: "meta", mode: "write", accountId: "ad-account", credentialReference: "secret://test", enabled: true,
  }));
});

test("verifies Shopify HMAC signatures against the raw payload", () => {
  const signature = createHmac("sha256", secret).update(payload).digest("base64");
  assert.equal(verifyShopifyWebhook(payload, signature, secret), true);
  assert.equal(verifyShopifyWebhook(payload, signature, "wrong-secret"), false);
});

test("verifies Meta SHA-256 HMAC signatures against the raw payload", () => {
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(verifyMetaWebhook(payload, `sha256=${signature}`, secret), true);
  assert.equal(verifyMetaWebhook(payload, `sha1=${signature}`, secret), false);
});
