import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 media hosting.
 *
 * Instagram's Content Publishing API does not accept an upload: it fetches the
 * media from a URL that must be publicly reachable at the moment of the call.
 * R2 is S3-compatible, so the standard AWS SDK is reused rather than hand-rolling
 * SigV4 signing.
 *
 * The bucket must be served on a public domain (an R2 custom domain, or the
 * managed r2.dev subdomain). R2_PUBLIC_BASE_URL is that domain — it is not
 * derivable from the API endpoint, which is not public.
 */
export interface R2Config {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  /** Public base URL objects are served from, e.g. https://media.pahaltea.com */
  publicBaseUrl?: string;
  /** Overrides the derived endpoint. Used by tests against a local S3 stand-in. */
  endpoint?: string;
  forcePathStyle?: boolean;
}

export function loadR2Config(source: Record<string, string | undefined> = process.env): R2Config {
  const blank = (value: string | undefined) => (value?.trim() === "" ? undefined : value?.trim());
  return {
    accountId: blank(source.R2_ACCOUNT_ID),
    accessKeyId: blank(source.R2_ACCESS_KEY_ID),
    secretAccessKey: blank(source.R2_SECRET_ACCESS_KEY),
    bucket: blank(source.R2_BUCKET),
    publicBaseUrl: blank(source.R2_PUBLIC_BASE_URL)?.replace(/\/$/, ""),
    endpoint: blank(source.R2_ENDPOINT),
    forcePathStyle: source.R2_FORCE_PATH_STYLE === "true",
  };
}

export interface R2Gate {
  variable: string;
  why: string;
}

export function missingForUpload(config: R2Config): R2Gate[] {
  const gates: R2Gate[] = [];
  if (!config.accountId && !config.endpoint) {
    gates.push({ variable: "R2_ACCOUNT_ID", why: "Your Cloudflare account id, used to build the R2 API endpoint." });
  }
  if (!config.accessKeyId) gates.push({ variable: "R2_ACCESS_KEY_ID", why: "R2 API token access key id with object write permission." });
  if (!config.secretAccessKey) gates.push({ variable: "R2_SECRET_ACCESS_KEY", why: "The matching R2 API token secret." });
  if (!config.bucket) gates.push({ variable: "R2_BUCKET", why: "Bucket that will hold published creatives." });
  if (!config.publicBaseUrl) {
    gates.push({
      variable: "R2_PUBLIC_BASE_URL",
      why: "Public https base URL the bucket is served on. Instagram fetches the image from here, so it must be reachable without authentication.",
    });
  }
  return gates;
}

export interface UploadedMedia {
  key: string;
  url: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface MediaStore {
  readonly kind: string;
  upload(input: { body: Uint8Array; contentType: string; key: string }): Promise<UploadedMedia>;
}

export class R2MediaStore implements MediaStore {
  readonly kind = "cloudflare-r2";
  readonly #config: R2Config;
  #client: S3Client | undefined;

  constructor(config: R2Config) {
    const gates = missingForUpload(config);
    if (gates.length > 0) {
      throw new Error(`Cloudflare R2 is not configured: ${gates.map((gate) => gate.variable).join(", ")}.`);
    }
    this.#config = config;
  }

  async upload(input: { body: Uint8Array; contentType: string; key: string }): Promise<UploadedMedia> {
    this.#client ??= new S3Client({
      region: "auto",
      endpoint: this.#config.endpoint ?? `https://${this.#config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.#config.accessKeyId!,
        secretAccessKey: this.#config.secretAccessKey!,
      },
      forcePathStyle: this.#config.forcePathStyle ?? false,
    });

    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Creatives are immutable once published; a changed image would
        // invalidate the approval bound to the post.
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    return {
      key: input.key,
      url: `${this.#config.publicBaseUrl}/${input.key}`,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      bytes: input.body.byteLength,
      contentType: input.contentType,
    };
  }
}

/**
 * Confirms the object really is publicly readable before Instagram is asked to
 * fetch it. A private bucket is the most common reason a container creation
 * fails, and it fails with an opaque Meta error.
 */
export async function assertPubliclyReachable(url: string, timeoutMs = 15_000): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Media URL is not reachable (${error instanceof Error ? error.message : String(error)}): ${url}`);
  }
  if (!response.ok) {
    throw new Error(
      `Media URL returned HTTP ${response.status}. Instagram must be able to fetch it anonymously — check the bucket's public access settings: ${url}`,
    );
  }
}

/** Instagram accepts JPEG only for feed images. */
export function assertPublishableImage(bytes: Uint8Array, contentType: string): void {
  if (contentType !== "image/jpeg") {
    throw new Error(`Instagram feed images must be JPEG; got ${contentType}.`);
  }
  // JPEG magic number: FF D8 FF.
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error("File is not a JPEG: the JPEG start-of-image marker is missing.");
  }
}

export function mediaKeyFor(draftId: string, sha256: string): string {
  return `creatives/${draftId}/${sha256.slice(0, 16)}.jpg`;
}
