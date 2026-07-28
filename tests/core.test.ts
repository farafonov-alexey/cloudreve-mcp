import { describe, expect, it } from "vitest";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "../src/oauth/pkce.js";
import { TokenStore } from "../src/oauth/storage.js";
import {
  buildAuthorizeUrl,
  tokensFromOAuthResponse,
  refreshAccessToken,
} from "../src/oauth/flow.js";
import { loadConfig } from "../src/config.js";
import { toFileUri, parentPath, baseName, uriToPath } from "../src/cloudreve/uri.js";
import { CacheStore, resolveUnderRoot, looksLikeDirectory } from "../src/cache/store.js";
import { CloudreveClient, CloudreveApiError } from "../src/cloudreve/client.js";
import type { AuthManager } from "../src/oauth/flow.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("PKCE", () => {
  it("generates verifier in allowed charset and length", () => {
    const v = generateCodeVerifier(64);
    expect(v).toHaveLength(64);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("produces stable S256 challenge", () => {
    const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Known RFC 7636 example challenge for this verifier
    expect(generateCodeChallenge(v)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates unique states", () => {
    expect(generateState()).not.toEqual(generateState());
  });
});

describe("URI helpers", () => {
  it("converts paths to File URIs", () => {
    expect(toFileUri("/")).toBe("cloudreve://my");
    expect(toFileUri("/docs")).toBe("cloudreve://my/docs");
    expect(toFileUri("docs/a.md")).toBe("cloudreve://my/docs/a.md");
    expect(toFileUri("cloudreve://my/x")).toBe("cloudreve://my/x");
  });

  it("encodes spaces in segments", () => {
    expect(toFileUri("/Luke's AMA")).toContain("Luke");
    expect(toFileUri("/a b/c")).toBe("cloudreve://my/a%20b/c");
  });

  it("parent/base helpers", () => {
    expect(parentPath("/a/b/c.md")).toBe("/a/b");
    expect(parentPath("/a")).toBe("/");
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(uriToPath("cloudreve://my/docs")).toBe("/docs");
  });
});

describe("TokenStore", () => {
  it("saves and loads tokens", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crmcp-"));
    const store = new TokenStore(path.join(dir, "tokens.json"));
    const tokens = tokensFromOAuthResponse({
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
      expires_in: 3600,
    });
    store.save(tokens);
    const loaded = store.load();
    expect(loaded?.access_token).toBe("a");
    expect(store.isAccessTokenValid(loaded!)).toBe(true);
    store.clear();
    expect(store.load()).toBeNull();
  });
});

describe("loadConfig", () => {
  it("requires CLOUDREVE_BASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/CLOUDREVE_BASE_URL/);
  });

  it("derives OAuth endpoints from base URL", () => {
    const cfg = loadConfig({
      CLOUDREVE_BASE_URL: "https://cloud.example.com",
      CLOUDREVE_CLIENT_ID: "c",
      CLOUDREVE_CLIENT_SECRET: "s",
    });
    expect(cfg.apiBase).toBe("https://cloud.example.com/api/v4");
    expect(cfg.authEndpoint).toBe("https://cloud.example.com/session/authorize");
    expect(cfg.scopes).toContain("offline_access");
    expect(cfg.scopes).toContain("Files.Read");
  });
});

describe("OAuth URL + refresh", () => {
  it("builds authorize URL with PKCE params", () => {
    const cfg = loadConfig({
      CLOUDREVE_BASE_URL: "https://cloud.example.com",
      CLOUDREVE_CLIENT_ID: "client-1",
      CLOUDREVE_CLIENT_SECRET: "secret",
    });
    const url = buildAuthorizeUrl(cfg, {
      state: "st",
      codeChallenge: "ch",
    });
    expect(url).toContain("https://cloud.example.com/session/authorize?");
    expect(url).toContain("client_id=client-1");
    expect(url).toContain("code_challenge=ch");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("response_type=code");
  });

  it("refreshes tokens via mocked fetch", async () => {
    const cfg = loadConfig({
      CLOUDREVE_BASE_URL: "https://cloud.example.com",
      CLOUDREVE_CLIENT_ID: "client-1",
      CLOUDREVE_CLIENT_SECRET: "secret",
    });
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            access_expires: new Date(Date.now() + 3600_000).toISOString(),
            refresh_expires: new Date(Date.now() + 86400_000).toISOString(),
          },
          msg: "",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    try {
      const tokens = await refreshAccessToken(cfg, "old-refresh");
      expect(tokens.access_token).toBe("new-access");
      expect(tokens.refresh_token).toBe("new-refresh");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("download path safety", () => {
  it("rejects traversal", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crmcp-dl-"));
    expect(() => resolveUnderRoot(root, "../../etc/passwd", "x")).toThrow(
      /escapes/,
    );
  });

  it("treats extensionless local_path as directory", () => {
    expect(looksLikeDirectory("tmp")).toBe(true);
    expect(looksLikeDirectory("tmp/")).toBe(true);
    expect(looksLikeDirectory("tmp/a.md")).toBe(false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crmcp-dl-"));
    const dest = resolveUnderRoot(root, "tmp", "report.pdf");
    expect(dest.replace(/\\/g, "/")).toMatch(/tmp\/report\.pdf$/);
  });
});

describe("CacheStore", () => {
  it("writes, lists, and verifies presign", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crmcp-cache-"));
    const cache = new CacheStore(root, "test-secret");
    cache.writeText("tmp/note.txt", "hello");
    const entries = cache.list("tmp");
    expect(entries.some((e) => e.path === "tmp/note.txt")).toBe(true);
    const signed = cache.presign("tmp/note.txt", 60);
    expect(cache.verifyPresign(signed.path, signed.expires_at, signed.token)).toBe(
      true,
    );
    expect(cache.verifyPresign(signed.path, signed.expires_at, "bad")).toBe(false);
    expect(() => cache.resolve("../outside")).toThrow(/escapes/);
  });
});

describe("CloudreveClient envelope handling", () => {
  it("surfaces API code errors", async () => {
    const cfg = loadConfig({
      CLOUDREVE_BASE_URL: "https://cloud.example.com",
      CLOUDREVE_CLIENT_ID: "c",
      CLOUDREVE_CLIENT_SECRET: "s",
    });
    const auth = {
      getAccessToken: async () => "token",
    } as AuthManager;
    const client = new CloudreveClient(cfg, auth);
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 40044, msg: "File Not Found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      await expect(client.list("/missing")).rejects.toBeInstanceOf(CloudreveApiError);
      await expect(client.list("/missing")).rejects.toThrow(/40044/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("lists files on success", async () => {
    const cfg = loadConfig({
      CLOUDREVE_BASE_URL: "https://cloud.example.com",
      CLOUDREVE_CLIENT_ID: "c",
      CLOUDREVE_CLIENT_SECRET: "s",
    });
    const auth = {
      getAccessToken: async () => "token",
    } as AuthManager;
    const client = new CloudreveClient(cfg, auth);
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      expect(url).toContain("/api/v4/file");
      expect(url).toContain("uri=");
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            files: [
              {
                id: "abc",
                name: "a.md",
                type: 0,
                path: "cloudreve://my/a.md",
                size: 12,
              },
            ],
            pagination: { page: 0, page_size: 50 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const data = await client.list("/");
      expect(data.files[0]?.id).toBe("abc");
    } finally {
      globalThis.fetch = original;
    }
  });
});
