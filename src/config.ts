import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_REDIRECT_URI = "http://127.0.0.1:53682/callback";
const DEFAULT_SCOPES =
  "openid profile offline_access Files.Read Files.Write Shares.Read Shares.Write";

export interface AppConfig {
  baseUrl: string;
  apiBase: string;
  siteBase: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  authEndpoint: string;
  tokenEndpoint: string;
  refreshEndpoint: string;
  userInfoEndpoint: string;
  downloadRoot: string;
  cacheRoot: string;
  tokenStorePath: string;
}

function normalizeBaseUrl(raw: string): { siteBase: string; apiBase: string } {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v4")) {
    return {
      siteBase: trimmed.slice(0, -"/api/v4".length),
      apiBase: trimmed,
    };
  }
  return {
    siteBase: trimmed,
    apiBase: `${trimmed}/api/v4`,
  };
}

function defaultConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "cloudreve-mcp",
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "cloudreve-mcp");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "cloudreve-mcp",
  );
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "cloudreve-mcp",
    );
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "cloudreve-mcp");
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "cloudreve-mcp",
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseUrl = (env.CLOUDREVE_BASE_URL || "").trim();
  if (!baseUrl) {
    throw new Error(
      "CLOUDREVE_BASE_URL is required. Set it to your Cloudreve v4 site URL, e.g. https://cloud.example.com",
    );
  }
  const { siteBase, apiBase } = normalizeBaseUrl(baseUrl);
  const clientId = env.CLOUDREVE_CLIENT_ID || "";
  const clientSecret = env.CLOUDREVE_CLIENT_SECRET || "";
  const redirectUri = env.CLOUDREVE_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  const scopes = env.CLOUDREVE_SCOPES || DEFAULT_SCOPES;
  const authEndpoint =
    env.CLOUDREVE_AUTH_ENDPOINT || `${siteBase}/session/authorize`;
  const tokenEndpoint =
    env.CLOUDREVE_TOKEN_ENDPOINT || `${apiBase}/session/oauth/token`;
  const refreshEndpoint =
    env.CLOUDREVE_REFRESH_ENDPOINT || `${apiBase}/session/token/refresh`;
  const userInfoEndpoint =
    env.CLOUDREVE_USERINFO_ENDPOINT || `${apiBase}/session/oauth/userinfo`;

  const dataDir = env.CLOUDREVE_DATA_DIR || defaultDataDir();
  const configDir = env.CLOUDREVE_CONFIG_DIR || defaultConfigDir();

  return {
    baseUrl,
    apiBase,
    siteBase,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    authEndpoint,
    tokenEndpoint,
    refreshEndpoint,
    userInfoEndpoint,
    downloadRoot: env.CLOUDREVE_DOWNLOAD_ROOT || path.join(dataDir, "download"),
    cacheRoot: env.CLOUDREVE_CACHE_ROOT || path.join(dataDir, "cache"),
    tokenStorePath:
      env.CLOUDREVE_TOKEN_STORE || path.join(configDir, "tokens.json"),
  };
}

export function requireOAuthConfig(cfg: AppConfig): void {
  if (!cfg.clientId) {
    throw new Error(
      "CLOUDREVE_CLIENT_ID is required. Register an OAuth app in Cloudreve admin and set the env var.",
    );
  }
  if (!cfg.clientSecret) {
    throw new Error(
      "CLOUDREVE_CLIENT_SECRET is required. Register an OAuth app in Cloudreve admin and set the env var.",
    );
  }
}

/** Package root for resolving relative paths when needed. */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}
