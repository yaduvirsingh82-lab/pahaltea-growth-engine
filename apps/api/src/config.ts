export interface AppConfig {
  environment: "development" | "staging" | "production";
  writeActionsEnabled: boolean;
  databaseUrl?: string;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const environment = source.APP_ENV ?? "development";
  if (!isEnvironment(environment)) throw new Error("APP_ENV must be development, staging, or production.");

  const writeActionsEnabled = source.WRITE_ACTIONS_ENABLED === "true";
  if (environment === "production" && writeActionsEnabled) {
    throw new Error("Production writes cannot be enabled by environment configuration.");
  }

  return { environment, writeActionsEnabled, databaseUrl: source.DATABASE_URL };
}

function isEnvironment(value: string): value is AppConfig["environment"] {
  return value === "development" || value === "staging" || value === "production";
}
