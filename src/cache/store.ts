import fs from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";

function safeRel(rel: string): string {
  const cleaned = (rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const norm = path.posix.normalize(cleaned || ".");
  if (norm === ".." || norm.startsWith("../")) {
    throw new Error("Path escapes cache root");
  }
  return norm === "." ? "" : norm;
}

export class CacheStore {
  constructor(
    private readonly root: string,
    private readonly secret: string = process.env.CLOUDREVE_CACHE_SECRET || "cloudreve-mcp-cache",
  ) {
    fs.mkdirSync(this.root, { recursive: true });
  }

  resolve(relPath: string): string {
    const rel = safeRel(relPath);
    const abs = path.resolve(this.root, rel);
    const rootResolved = path.resolve(this.root);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      throw new Error("Path escapes cache root");
    }
    return abs;
  }

  list(dir = ""): Array<{ path: string; size: number; mtimeMs: number; isDirectory: boolean }> {
    const abs = this.resolve(dir);
    if (!fs.existsSync(abs)) return [];
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries.map((e) => {
      const childRel = path.posix.join(safeRel(dir), e.name);
      const childAbs = path.join(abs, e.name);
      const st = fs.statSync(childAbs);
      return {
        path: childRel,
        size: st.size,
        mtimeMs: st.mtimeMs,
        isDirectory: e.isDirectory(),
      };
    });
  }

  writeText(relPath: string, text: string): string {
    const abs = this.resolve(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
    return abs;
  }

  writeBuffer(relPath: string, buf: Buffer): string {
    const abs = this.resolve(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    return abs;
  }

  readBuffer(relPath: string): Buffer {
    const abs = this.resolve(relPath);
    return fs.readFileSync(abs);
  }

  exists(relPath: string): boolean {
    return fs.existsSync(this.resolve(relPath));
  }

  /**
   * Create a short-lived HMAC "presign" token for a cache-relative path.
   * Returns a local URI scheme string the agent can pass back to download_from_cache_presign.
   */
  presign(relPath: string, expireSeconds = 600): {
    path: string;
    expires_at: number;
    token: string;
    local_uri: string;
  } {
    const rel = safeRel(relPath);
    if (!this.exists(rel)) throw new Error(`Cache file not found: ${rel}`);
    const expiresAt = Math.floor(Date.now() / 1000) + expireSeconds;
    const payload = `${rel}:${expiresAt}`;
    const token = createHmac("sha256", this.secret).update(payload).digest("hex");
    return {
      path: rel,
      expires_at: expiresAt,
      token,
      local_uri: `cache://${encodeURIComponent(rel)}?expires=${expiresAt}&token=${token}`,
    };
  }

  verifyPresign(relPath: string, expiresAt: number, token: string): boolean {
    const rel = safeRel(relPath);
    if (expiresAt < Math.floor(Date.now() / 1000)) return false;
    const payload = `${rel}:${expiresAt}`;
    const expected = createHmac("sha256", this.secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
    } catch {
      return false;
    }
  }
}

export function looksLikeDirectory(localPath: string): boolean {
  if (!localPath) return true;
  if (localPath.endsWith("/") || localPath.endsWith("\\")) return true;
  const name = path.basename(localPath);
  return !name.includes(".");
}

export function resolveUnderRoot(root: string, localPath: string, remoteFileName?: string): string {
  const cleaned = (localPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const norm = path.posix.normalize(cleaned || ".");
  if (norm === ".." || norm.startsWith("../")) {
    throw new Error("local_path escapes download root");
  }
  const base = path.resolve(root);
  let target =
    norm === "." ? base : path.resolve(base, ...norm.split("/").filter(Boolean));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("local_path escapes download root");
  }
  if (looksLikeDirectory(localPath)) {
    if (!remoteFileName) throw new Error("remote filename required for directory local_path");
    target = path.join(target, remoteFileName);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}
