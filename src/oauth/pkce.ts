import { createHash, randomBytes } from "node:crypto";

const VERIFIER_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new Error("PKCE code_verifier length must be between 43 and 128");
  }
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += VERIFIER_CHARSET[bytes[i]! % VERIFIER_CHARSET.length];
  }
  return out;
}

export function generateCodeChallenge(codeVerifier: string): string {
  const hash = createHash("sha256").update(codeVerifier).digest();
  return base64UrlEncode(hash);
}

export function generateState(bytes = 24): string {
  return base64UrlEncode(randomBytes(bytes));
}

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
