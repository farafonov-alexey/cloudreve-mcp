import http from "node:http";
import { exec } from "node:child_process";
import { URL } from "node:url";
import type { AppConfig } from "../config.js";
import { requireOAuthConfig } from "../config.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";
import { TokenStore, type StoredTokens } from "./storage.js";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in?: number;
}

export interface RefreshEnvelope {
  code: number;
  data?: {
    access_token: string;
    refresh_token: string;
    access_expires: string;
    refresh_expires: string;
  };
  msg?: string;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // best-effort; user can open URL manually
  });
}

function parseRedirectUri(redirectUri: string): {
  host: string;
  port: number;
  pathname: string;
} {
  const u = new URL(redirectUri);
  if (u.protocol !== "http:") {
    throw new Error(
      `Local OAuth callback must use http://127.0.0.1 (got ${u.protocol}). Register this redirect URI in your OAuth app.`,
    );
  }
  const host = u.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      `OAuth redirect host must be 127.0.0.1 or localhost for local MCP auth (got ${host}).`,
    );
  }
  return {
    host,
    port: u.port ? Number(u.port) : 80,
    pathname: u.pathname || "/",
  };
}

export function buildAuthorizeUrl(
  cfg: AppConfig,
  opts: { state: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${cfg.authEndpoint}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(
  cfg: AppConfig,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: cfg.redirectUri,
  });

  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Token exchange failed: HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`,
    );
  }

  const obj = json as Record<string, unknown>;
  // Some deployments wrap in {code,data}; OAuth token endpoint usually returns flat OAuth JSON.
  if (typeof obj.access_token === "string") {
    return obj as unknown as OAuthTokenResponse;
  }
  if (obj.code === 0 && obj.data && typeof obj.data === "object") {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.access_token === "string") {
      return {
        access_token: data.access_token as string,
        refresh_token: data.refresh_token as string | undefined,
        token_type: (data.token_type as string) || "Bearer",
        expires_in:
          typeof data.expires_in === "number"
            ? data.expires_in
            : 3600,
        refresh_token_expires_in:
          typeof data.refresh_token_expires_in === "number"
            ? data.refresh_token_expires_in
            : undefined,
      };
    }
  }
  throw new Error(
    `Token exchange failed: HTTP ${res.status}: ${text.slice(0, 300)}`,
  );
}

export async function refreshAccessToken(
  cfg: AppConfig,
  refreshToken: string,
): Promise<StoredTokens> {
  const res = await fetch(cfg.refreshEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const json = (await res.json()) as RefreshEnvelope;
  if (json.code !== 0 || !json.data) {
    throw new Error(
      `Token refresh failed: ${json.code}: ${json.msg || "unknown error"}`,
    );
  }
  const accessExpires = Date.parse(json.data.access_expires);
  const refreshExpires = Date.parse(json.data.refresh_expires);
  return {
    access_token: json.data.access_token,
    refresh_token: json.data.refresh_token,
    token_type: "Bearer",
    access_expires_at: Number.isFinite(accessExpires)
      ? accessExpires
      : Date.now() + 3600_000,
    refresh_expires_at: Number.isFinite(refreshExpires)
      ? refreshExpires
      : undefined,
    obtained_at: Date.now(),
  };
}

export function tokensFromOAuthResponse(
  resp: OAuthTokenResponse,
  scopes?: string,
): StoredTokens {
  const now = Date.now();
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    token_type: resp.token_type || "Bearer",
    access_expires_at: now + (resp.expires_in || 3600) * 1000,
    refresh_expires_at: resp.refresh_token_expires_in
      ? now + resp.refresh_token_expires_in * 1000
      : undefined,
    obtained_at: now,
    scopes,
  };
}

/**
 * Runs the full local OAuth authorization-code + PKCE flow.
 * Opens the browser and waits for the redirect callback.
 */
export async function runAuthorizationFlow(
  cfg: AppConfig,
  opts: { timeoutMs?: number; open?: boolean } = {},
): Promise<{ tokens: StoredTokens; authorizeUrl: string }> {
  requireOAuthConfig(cfg);
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const open = opts.open ?? true;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authorizeUrl = buildAuthorizeUrl(cfg, { state, codeChallenge });
  const redirect = parseRedirectUri(cfg.redirectUri);

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://${redirect.host}:${redirect.port}`);
        if (reqUrl.pathname !== redirect.pathname) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        const err = reqUrl.searchParams.get("error");
        if (err) {
          const desc = reqUrl.searchParams.get("error_description") || err;
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h1>Authorization failed</h1><p>${desc}</p>`);
          if (!settled) {
            settled = true;
            reject(new Error(`OAuth error: ${desc}`));
          }
          server.close();
          return;
        }
        const returnedState = reqUrl.searchParams.get("state");
        const authCode = reqUrl.searchParams.get("code");
        if (!authCode || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>Invalid OAuth callback</h1><p>Missing code or state mismatch.</p>");
          if (!settled) {
            settled = true;
            reject(new Error("Invalid OAuth callback: missing code or state mismatch"));
          }
          server.close();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Cloudreve MCP authorized</h1><p>You can close this tab and return to Cursor.</p>",
        );
        if (!settled) {
          settled = true;
          resolve(authCode);
        }
        server.close();
      } catch (e) {
        if (!settled) {
          settled = true;
          reject(e);
        }
        try {
          server.close();
        } catch {
          // ignore
        }
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error(`OAuth timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    server.on("close", () => clearTimeout(timer));
    server.listen(redirect.port, redirect.host, () => {
      if (open) openBrowser(authorizeUrl);
    });
    server.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  });

  const tokenResp = await exchangeAuthorizationCode(cfg, code, codeVerifier);
  const tokens = tokensFromOAuthResponse(tokenResp, cfg.scopes);
  const store = new TokenStore(cfg.tokenStorePath);
  store.save(tokens);
  return { tokens, authorizeUrl };
}

export class AuthManager {
  private readonly store: TokenStore;

  constructor(private readonly cfg: AppConfig) {
    this.store = new TokenStore(cfg.tokenStorePath);
  }

  getStore(): TokenStore {
    return this.store;
  }

  async getAccessToken(): Promise<string> {
    let tokens = this.store.load();
    if (!tokens) {
      throw new Error(
        "Not authorized. Call the authorize tool first to complete Cloudreve OAuth.",
      );
    }
    if (this.store.isAccessTokenValid(tokens)) {
      return tokens.access_token;
    }
    if (!tokens.refresh_token) {
      throw new Error(
        "Access token expired and no refresh_token available. Re-run authorize (ensure offline_access scope).",
      );
    }
    tokens = await refreshAccessToken(this.cfg, tokens.refresh_token);
    this.store.save(tokens);
    return tokens.access_token;
  }

  status(): {
    authorized: boolean;
    access_expires_at?: number;
    has_refresh_token?: boolean;
    token_store: string;
  } {
    const tokens = this.store.load();
    if (!tokens) {
      return { authorized: false, token_store: this.cfg.tokenStorePath };
    }
    return {
      authorized: this.store.isAccessTokenValid(tokens) || Boolean(tokens.refresh_token),
      access_expires_at: tokens.access_expires_at,
      has_refresh_token: Boolean(tokens.refresh_token),
      token_store: this.cfg.tokenStorePath,
    };
  }

  logout(): void {
    this.store.clear();
  }
}
