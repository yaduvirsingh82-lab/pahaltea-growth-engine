import { createHmac, timingSafeEqual } from "node:crypto";

export type IntegrationProvider = "shopify" | "meta" | "instagram" | "n8n" | "whatsapp";
export type IntegrationMode = "offline" | "sandbox" | "read_only" | "write";

export interface IntegrationConnection {
  id: string;
  organisationId: string;
  provider: IntegrationProvider;
  mode: IntegrationMode;
  accountId: string;
  credentialReference: string;
  enabled: boolean;
}

export interface WebhookEnvelope {
  provider: IntegrationProvider;
  eventId: string;
  eventType: string;
  receivedAt: Date;
  rawPayload: string;
  signature: string;
}

export interface ReadOnlyIntegration {
  readonly provider: IntegrationProvider;
  fetchPage(cursor?: string): Promise<{ events: readonly Record<string, unknown>[]; nextCursor?: string }>;
}

/** Must atomically reserve a key. A duplicate key returns false and is never processed again. */
export interface IdempotencyRepository {
  reserve(key: string, expiresAt: Date): Promise<boolean>;
}

export interface WebhookAdmission {
  accepted: boolean;
  reason: string;
}

export function assertReadOnlyConnection(connection: IntegrationConnection): void {
  if (!connection.enabled) throw new Error(`${connection.provider} connection is disabled.`);
  if (connection.mode !== "read_only" && connection.mode !== "sandbox") {
    throw new Error(`${connection.provider} is not configured for offline/read-only use.`);
  }
  if (!connection.credentialReference) throw new Error(`${connection.provider} requires a managed credential reference.`);
}

export function verifyShopifyWebhook(rawPayload: string, signatureBase64: string, secret: string): boolean {
  return verifyHmac(rawPayload, signatureBase64, secret, "base64");
}

export function verifyMetaWebhook(rawPayload: string, signatureHeader: string, secret: string): boolean {
  const [algorithm, signature] = signatureHeader.split("=", 2);
  return algorithm === "sha256" && Boolean(signature) && verifyHmac(rawPayload, signature, secret, "hex");
}

export async function admitWebhook(
  connection: IntegrationConnection,
  envelope: WebhookEnvelope,
  secret: string,
  idempotency: IdempotencyRepository,
  now: Date = new Date(),
): Promise<WebhookAdmission> {
  try {
    assertReadOnlyConnection(connection);
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : "Connection is not eligible." };
  }
  if (connection.provider !== envelope.provider) return { accepted: false, reason: "Provider does not match the connection." };

  const signatureIsValid = envelope.provider === "shopify"
    ? verifyShopifyWebhook(envelope.rawPayload, envelope.signature, secret)
    : envelope.provider === "meta" || envelope.provider === "instagram"
      ? verifyMetaWebhook(envelope.rawPayload, envelope.signature, secret)
      : false;
  if (!signatureIsValid) return { accepted: false, reason: "Webhook signature is invalid." };

  const reserved = await idempotency.reserve(
    `${envelope.provider}:${connection.accountId}:${envelope.eventId}`,
    new Date(now.getTime() + 24 * 60 * 60 * 1000),
  );
  return reserved
    ? { accepted: true, reason: "Verified webhook admitted for processing." }
    : { accepted: false, reason: "Duplicate webhook event." };
}

function verifyHmac(payload: string, suppliedSignature: string, secret: string, encoding: "base64" | "hex"): boolean {
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest(encoding);
  const supplied = Buffer.from(suppliedSignature, encoding);
  const expectedBuffer = Buffer.from(expected, encoding);
  return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
}
