import { createHash } from "node:crypto";

/**
 * Fixed namespace for this project. Seeded rows derive their primary keys from
 * it so that re-running the seed updates the same rows instead of duplicating
 * approved product truth.
 */
export const PAHALTEA_UUID_NAMESPACE = "1e0c4a70-6b3e-5f2a-9d41-8f7b2c5e6a10";

/** RFC 4122 version 5 (SHA-1, name-based) UUID. */
export function uuidV5(name: string, namespace: string = PAHALTEA_UUID_NAMESPACE): string {
  const bytes = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
}
