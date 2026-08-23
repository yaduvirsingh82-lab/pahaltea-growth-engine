import { MetaApiError, MetaGraphClient } from "./client.ts";
import type { MetaConfig } from "./config.ts";

/**
 * Instagram Content Publishing.
 *
 * Three steps, per Meta's documented contract:
 *   1. POST /{ig-user-id}/media       → creation_id (a container)
 *   2. GET  /{container-id}?fields=status_code → poll until FINISHED
 *   3. POST /{ig-user-id}/media_publish → the published media id
 *
 * Step 2 is not optional. Publishing a container that is still IN_PROGRESS
 * fails, and an image container can take seconds to become ready.
 */

export interface PublishPlan {
  igUserId: string;
  imageUrl: string;
  caption: string;
  altText?: string;
}

export interface PublishResult {
  containerId: string;
  mediaId: string;
  permalink?: string;
}

export interface PublishHooks {
  /** Called with each step so the caller can persist progress between calls. */
  onStep?: (step: "container_created" | "container_ready" | "published", detail: Record<string, string>) => Promise<void>;
}

export interface PollOptions {
  maxAttempts?: number;
  intervalMs?: number;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class InstagramPublisher {
  readonly #client: MetaGraphClient;

  constructor(config: MetaConfig) {
    this.#client = new MetaGraphClient(config);
  }

  /**
   * Describes exactly what a live run would send, without contacting Meta.
   * This is the default path; a live publish is a separate, explicit call.
   */
  describe(plan: PublishPlan): { requests: { method: string; path: string; params: Record<string, string> }[] } {
    return {
      requests: [
        {
          method: "POST",
          path: `${plan.igUserId}/media`,
          params: {
            image_url: plan.imageUrl,
            caption: plan.caption,
            ...(plan.altText ? { alt_text: plan.altText } : {}),
          },
        },
        { method: "GET", path: "{creation_id}", params: { fields: "status_code" } },
        { method: "POST", path: `${plan.igUserId}/media_publish`, params: { creation_id: "{creation_id}" } },
      ],
    };
  }

  async createContainer(plan: PublishPlan): Promise<string> {
    const response = await this.#client.request<{ id: string }>({
      path: `${plan.igUserId}/media`,
      method: "POST",
      params: {
        image_url: plan.imageUrl,
        caption: plan.caption,
        alt_text: plan.altText,
      },
    });
    if (!response.id) throw new Error("Meta returned no container id.");
    return response.id;
  }

  async waitForContainer(containerId: string, options: PollOptions = {}): Promise<void> {
    const maxAttempts = options.maxAttempts ?? 30;
    const intervalMs = options.intervalMs ?? 3_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const status = await this.#client.request<{ status_code?: string; status?: string }>({
        path: containerId,
        params: { fields: "status_code,status" },
      });

      switch (status.status_code) {
        case "FINISHED":
          return;
        case "ERROR":
          throw new Error(`Instagram could not process the media: ${status.status ?? "no detail given"}`);
        case "EXPIRED":
          throw new Error("The media container expired before it was published (containers last 24 hours).");
        default:
          if (attempt === maxAttempts) {
            throw new Error(
              `Media container was still ${status.status_code ?? "IN_PROGRESS"} after ${maxAttempts} checks over ${
                (maxAttempts * intervalMs) / 1000
              }s.`,
            );
          }
          await sleep(intervalMs);
      }
    }
  }

  async publishContainer(igUserId: string, containerId: string): Promise<string> {
    const response = await this.#client.request<{ id: string }>({
      path: `${igUserId}/media_publish`,
      method: "POST",
      params: { creation_id: containerId },
    });
    if (!response.id) throw new Error("Meta returned no media id after publishing.");
    return response.id;
  }

  async permalinkFor(mediaId: string): Promise<string | undefined> {
    try {
      const media = await this.#client.request<{ permalink?: string }>({
        path: mediaId,
        params: { fields: "permalink" },
      });
      return media.permalink;
    } catch {
      // A missing permalink never invalidates a successful publish.
      return undefined;
    }
  }

  /** The full live sequence. Only reached after write admission has been granted. */
  async publish(plan: PublishPlan, hooks: PublishHooks = {}, poll: PollOptions = {}): Promise<PublishResult> {
    const containerId = await this.createContainer(plan);
    await hooks.onStep?.("container_created", { containerId });

    await this.waitForContainer(containerId, poll);
    await hooks.onStep?.("container_ready", { containerId });

    const mediaId = await this.publishContainer(plan.igUserId, containerId);
    const permalink = await this.permalinkFor(mediaId);
    await hooks.onStep?.("published", { containerId, mediaId, ...(permalink ? { permalink } : {}) });

    return { containerId, mediaId, permalink };
  }

  /** Remaining posts in the rolling 24-hour window, or undefined if unknown. */
  async remainingQuota(igUserId: string): Promise<number | undefined> {
    try {
      const quota = await this.#client.request<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>({
        path: `${igUserId}/content_publishing_limit`,
        params: { fields: "config,quota_usage" },
      });
      const entry = quota.data?.[0];
      if (!entry) return undefined;
      return (entry.config?.quota_total ?? 100) - (entry.quota_usage ?? 0);
    } catch (error) {
      if (error instanceof MetaApiError) return undefined;
      throw error;
    }
  }
}
