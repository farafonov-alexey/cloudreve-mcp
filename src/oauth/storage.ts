import fs from "node:fs";
import path from "node:path";

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  /** Absolute expiry time in ms since epoch for access token. */
  access_expires_at: number;
  /** Absolute expiry time in ms since epoch for refresh token, if known. */
  refresh_expires_at?: number;
  obtained_at: number;
  scopes?: string;
}

export class TokenStore {
  constructor(private readonly filePath: string) {}

  load(): StoredTokens | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredTokens;
      if (!parsed.access_token) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(tokens: StoredTokens): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows may ignore chmod; best-effort.
    }
  }

  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }

  isAccessTokenValid(tokens: StoredTokens, skewMs = 60_000): boolean {
    return tokens.access_expires_at - skewMs > Date.now();
  }
}
