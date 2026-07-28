/**
 * Helpers for Cloudreve v4 File URIs.
 * @see https://docs.cloudreve.org/en/api/file-uri
 */

/** Convert a user-friendly path (`/docs`, `docs/a.md`) to `cloudreve://my/...`. */
export function toFileUri(pathOrUri: string, fs: "my" | "trash" | "shared_with_me" = "my"): string {
  const raw = (pathOrUri || "").trim();
  if (!raw || raw === "/") {
    return `cloudreve://${fs}`;
  }
  if (raw.startsWith("cloudreve://")) {
    return raw;
  }
  const normalized = raw.replace(/\\/g, "/");
  const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`;
  // Encode each path segment but keep slashes
  const encoded = withLeading
    .split("/")
    .map((seg, i) => (i === 0 ? "" : encodeURIComponent(seg)))
    .join("/");
  return `cloudreve://${fs}${encoded}`;
}

/** Extract a display path from a File URI or return the input. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("cloudreve://")) return uri;
  try {
    const u = new URL(uri);
    return decodeURIComponent(u.pathname || "/") || "/";
  } catch {
    return uri;
  }
}

/** Parent directory path of a file path (`/a/b/c.md` -> `/a/b`). */
export function parentPath(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const normalized = p.startsWith("/") ? p : `/${p}`;
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx) || "/";
}

/** Basename of a path. */
export function baseName(filePath: string): string {
  const p = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, "") || "";
  const n = name.replace(/^\/+/, "");
  if (!d || d === "/") return `/${n}`;
  return `${d.startsWith("/") ? d : `/${d}`}/${n}`;
}
