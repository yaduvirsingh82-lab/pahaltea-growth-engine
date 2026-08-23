/**
 * Meta / Instagram configuration.
 *
 * Credentials are read from the environment and never persisted, logged, or
 * committed. `integration_connections` stores only a credential *reference*.
 *
 * Two login paths exist and they are not interchangeable:
 *
 * - `facebook` — Facebook Login for Business. Host `graph.facebook.com`. The
 *   Instagram professional account must be linked to a Facebook Page. This is
 *   the path that later also carries Meta Ads, so it is the default.
 * - `instagram` — Instagram Login. Host `graph.instagram.com`. No Page needed,
 *   but it cannot reach the Ads API.
 */
export type MetaLoginKind = "facebook" | "instagram";

export interface MetaConfig {
  loginKind: MetaLoginKind;
  graphHost: string;
  /**
   * Always https against Meta. Overridable only so tests can drive the real
   * client against a local HTTP stand-in; never set this in a deployment.
   */
  graphProtocol?: "https" | "http";
  apiVersion: string;
  accessToken?: string;
  appId?: string;
  appSecret?: string;
  /** Instagram professional account id (the "IG User ID"). */
  igUserId?: string;
  /** Facebook Page id. Only used by the facebook login path to discover igUserId. */
  pageId?: string;
}

export const requiredScopes: Record<MetaLoginKind, readonly string[]> = {
  facebook: ["instagram_basic", "instagram_content_publish", "pages_read_engagement", "pages_show_list"],
  instagram: ["instagram_business_basic", "instagram_business_content_publish"],
};

const defaultHost: Record<MetaLoginKind, string> = {
  facebook: "graph.facebook.com",
  instagram: "graph.instagram.com",
};

export function loadMetaConfig(source: Record<string, string | undefined> = process.env): MetaConfig {
  const loginKind = (source.META_LOGIN_KIND ?? "facebook") as MetaLoginKind;
  if (loginKind !== "facebook" && loginKind !== "instagram") {
    throw new Error("META_LOGIN_KIND must be 'facebook' or 'instagram'.");
  }

  return {
    loginKind,
    graphHost: source.META_GRAPH_HOST ?? defaultHost[loginKind],
    graphProtocol: source.META_GRAPH_PROTOCOL === "http" ? "http" : "https",
    // Pinned rather than floating: a Graph version change must be a deliberate edit.
    apiVersion: source.META_API_VERSION ?? "v25.0",
    accessToken: blankToUndefined(source.META_ACCESS_TOKEN),
    appId: blankToUndefined(source.META_APP_ID),
    appSecret: blankToUndefined(source.META_APP_SECRET),
    igUserId: blankToUndefined(source.META_IG_USER_ID),
    pageId: blankToUndefined(source.META_PAGE_ID),
  };
}

export interface ConfigGate {
  variable: string;
  why: string;
}

/**
 * Exactly what is still missing before a live publish is possible. Returned as
 * data so the CLI can print a precise, actionable gate rather than a generic
 * "not configured" message.
 */
export function missingForPublish(config: MetaConfig): ConfigGate[] {
  const gates: ConfigGate[] = [];

  if (!config.accessToken) {
    gates.push({
      variable: "META_ACCESS_TOKEN",
      why: "A long-lived access token for the Instagram professional account. Without it no Graph call can be made.",
    });
  }
  if (!config.igUserId && !(config.loginKind === "facebook" && config.pageId)) {
    gates.push({
      variable: "META_IG_USER_ID",
      why:
        config.loginKind === "facebook"
          ? "The Instagram professional account id. Set this, or set META_PAGE_ID so it can be discovered from the linked Facebook Page."
          : "The Instagram professional account id that will own the post.",
    });
  }
  if (config.loginKind === "facebook" && !config.appSecret) {
    gates.push({
      variable: "META_APP_SECRET",
      why: "Used to sign requests with appsecret_proof and to inspect the token's scopes and expiry. Strongly recommended; publishing works without it but token verification does not.",
    });
  }
  return gates;
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}
