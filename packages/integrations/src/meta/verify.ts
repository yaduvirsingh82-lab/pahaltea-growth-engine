import { MetaApiError, MetaGraphClient } from "./client.ts";
import { missingForPublish, requiredScopes, type MetaConfig } from "./config.ts";

/**
 * Preflight for Instagram publishing. Every check is a real Graph call — nothing
 * here reports success it did not observe. The result is a checklist the CLI
 * prints verbatim so the exact remaining gate is always visible.
 */

export interface VerifyCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: VerifyCheck[];
  /** Resolved once the Instagram account is confirmed reachable. */
  igUserId?: string;
  igUsername?: string;
  grantedScopes?: string[];
  quotaUsed?: number;
  quotaCap?: number;
}

export async function verifyMetaSetup(config: MetaConfig): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const report: VerifyReport = { ok: false, checks };

  const gates = missingForPublish(config);
  checks.push({
    name: "configuration",
    status: gates.length === 0 ? "pass" : "fail",
    detail:
      gates.length === 0
        ? `Login path "${config.loginKind}" against ${config.graphHost}/${config.apiVersion}.`
        : gates.map((gate) => `${gate.variable}: ${gate.why}`).join(" | "),
  });

  if (!config.accessToken) {
    for (const name of ["token", "instagram_account", "permissions", "publishing_quota"]) {
      checks.push({ name, status: "skipped", detail: "No access token configured." });
    }
    return report;
  }

  const client = new MetaGraphClient(config);

  // 1. Token identity, scopes and expiry.
  if (config.appSecret && config.appId) {
    try {
      const debug = await client.request<{
        data?: { scopes?: string[]; expires_at?: number; is_valid?: boolean; app_id?: string };
      }>({
        path: "debug_token",
        params: { input_token: config.accessToken },
      });
      const data = debug.data ?? {};
      report.grantedScopes = data.scopes ?? [];
      const expiry = data.expires_at ? new Date(data.expires_at * 1000) : undefined;
      const neverExpires = data.expires_at === 0;
      checks.push({
        name: "token",
        status: data.is_valid ? "pass" : "fail",
        detail: data.is_valid
          ? `Valid${neverExpires ? ", never expires" : expiry ? `, expires ${expiry.toISOString()}` : ""}${
              data.app_id && config.appId && data.app_id !== config.appId ? ` — WARNING: belongs to app ${data.app_id}, not META_APP_ID` : ""
            }.`
          : "Token is not valid.",
      });
    } catch (error) {
      checks.push({ name: "token", status: "fail", detail: describe(error) });
    }
  } else {
    checks.push({
      name: "token",
      status: "skipped",
      detail: "META_APP_ID and META_APP_SECRET are needed to inspect the token's scopes and expiry.",
    });
  }

  // 2. Resolve and confirm the Instagram professional account.
  try {
    if (config.igUserId) {
      const account = await client.request<{ id: string; username?: string }>({
        path: config.igUserId,
        params: { fields: "id,username" },
      });
      report.igUserId = account.id;
      report.igUsername = account.username;
      checks.push({
        name: "instagram_account",
        status: "pass",
        detail: `Reachable: ${account.username ? `@${account.username} ` : ""}(${account.id}).`,
      });
    } else if (config.loginKind === "facebook" && config.pageId) {
      const page = await client.request<{
        id: string;
        name?: string;
        instagram_business_account?: { id: string; username?: string };
      }>({ path: config.pageId, params: { fields: "id,name,instagram_business_account{id,username}" } });

      if (page.instagram_business_account) {
        report.igUserId = page.instagram_business_account.id;
        report.igUsername = page.instagram_business_account.username;
        checks.push({
          name: "instagram_account",
          status: "pass",
          detail: `Page "${page.name ?? page.id}" is linked to Instagram ${
            page.instagram_business_account.username ? `@${page.instagram_business_account.username} ` : ""
          }(${page.instagram_business_account.id}). Set META_IG_USER_ID to this value to skip discovery.`,
        });
      } else {
        checks.push({
          name: "instagram_account",
          status: "fail",
          detail: `Page "${page.name ?? page.id}" has no linked Instagram professional account. Link it in Meta Business Suite, or the account is not a Business/Creator account.`,
        });
      }
    } else {
      checks.push({ name: "instagram_account", status: "fail", detail: "Neither META_IG_USER_ID nor META_PAGE_ID is set." });
    }
  } catch (error) {
    checks.push({ name: "instagram_account", status: "fail", detail: describe(error) });
  }

  // 3. Granted permissions against what publishing needs.
  const needed = requiredScopes[config.loginKind];
  if (report.grantedScopes) {
    const missing = needed.filter((scope) => !report.grantedScopes!.includes(scope));
    checks.push({
      name: "permissions",
      status: missing.length === 0 ? "pass" : "fail",
      detail:
        missing.length === 0
          ? `All required scopes granted: ${needed.join(", ")}.`
          : `Missing scope(s): ${missing.join(", ")}. Granted: ${report.grantedScopes.join(", ") || "none"}.`,
    });
  } else {
    checks.push({
      name: "permissions",
      status: "skipped",
      detail: `Cannot read granted scopes without META_APP_ID/META_APP_SECRET. Publishing needs: ${needed.join(", ")}.`,
    });
  }

  // 4. Publishing quota — proves the content-publishing surface is actually reachable.
  if (report.igUserId) {
    try {
      const quota = await client.request<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>({
        path: `${report.igUserId}/content_publishing_limit`,
        params: { fields: "config,quota_usage" },
      });
      const entry = quota.data?.[0];
      report.quotaUsed = entry?.quota_usage ?? 0;
      report.quotaCap = entry?.config?.quota_total ?? 100;
      checks.push({
        name: "publishing_quota",
        status: "pass",
        detail: `${report.quotaUsed} of ${report.quotaCap} API posts used in the rolling 24-hour window.`,
      });
    } catch (error) {
      checks.push({ name: "publishing_quota", status: "fail", detail: describe(error) });
    }
  } else {
    checks.push({ name: "publishing_quota", status: "skipped", detail: "Instagram account not resolved." });
  }

  report.ok = checks.every((check) => check.status === "pass");
  return report;
}

function describe(error: unknown): string {
  if (error instanceof MetaApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
