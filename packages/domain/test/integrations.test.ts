import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { admitWebhook, assertReadOnlyConnection, verifyMetaWebhook, verifyShopifyWebhook } from "../src/integrations.ts";

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

test("admits only verified, enabled, non-duplicate Shopify events", async () => {
  const keys = new Set<string>();
  const idempotency = {
    reserve: async (key: string) => {
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
  };
  const signature = createHmac("sha256", secret).update(payload).digest("base64");
  const connection = {
    id: "connection-1", organisationId: "org-1", provider: "shopify" as const, mode: "read_only" as const,
    accountId: "store-1", credentialReference: "secret://shopify", enabled: true,
  };
  const event = { provider: "shopify" as const, eventId: "event-1", eventType: "orders/create", receivedAt: new Date(), rawPayload: payload, signature };
  assert.equal((await admitWebhook(connection, event, secret, idempotency)).accepted, true);
  assert.equal((await admitWebhook(connection, event, secret, idempotency)).reason, "Duplicate webhook event.");
  assert.equal((await admitWebhook({ ...connection, enabled: false }, event, secret, idempotency)).accepted, false);
});
