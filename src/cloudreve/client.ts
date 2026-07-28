import fs from "node:fs";
import path from "node:path";
import type { AuthManager } from "../oauth/flow.js";
import type { AppConfig } from "../config.js";
import { baseName, joinPath, parentPath, toFileUri, uriToPath } from "./uri.js";
import type {
  ApiEnvelope,
  FileResponse,
  FileURLResponse,
  ListResponse,
  UploadCredential,
} from "./types.js";
import { FileType } from "./types.js";

export class CloudreveApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "CloudreveApiError";
  }
}

export class CloudreveClient {
  constructor(
    private readonly cfg: AppConfig,
    private readonly auth: AuthManager,
  ) {}

  private async request<T>(
    method: string,
    apiPath: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      rawBody?: Buffer | Uint8Array | string;
      headers?: Record<string, string>;
      expectJson?: boolean;
    } = {},
  ): Promise<T> {
    const token = await this.auth.getAccessToken();
    const url = new URL(
      apiPath.startsWith("http")
        ? apiPath
        : `${this.cfg.apiBase}/${apiPath.replace(/^\//, "")}`,
    );
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    };

    let body: Buffer | Uint8Array | string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body });
    const expectJson = opts.expectJson !== false;
    if (!expectJson) {
      if (!res.ok) {
        throw new CloudreveApiError(`HTTP ${res.status} @ ${url}`);
      }
      return res as unknown as T;
    }

    const text = await res.text();
    let envelope: ApiEnvelope<T>;
    try {
      envelope = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      throw new CloudreveApiError(
        `Invalid JSON from ${method} ${url}: ${text.slice(0, 200)}`,
      );
    }

    if (envelope.code !== 0) {
      throw new CloudreveApiError(
        `${envelope.code}: ${envelope.msg || envelope.error || "unknown error"}`,
        envelope.code,
        envelope.correlation_id,
      );
    }
    return envelope.data as T;
  }

  // ---------- Listing / info ----------

  async list(pathOrUri = "/", page = 0, pageSize = 50): Promise<ListResponse> {
    const uri = toFileUri(pathOrUri);
    return this.request<ListResponse>("GET", "/file", {
      query: { uri, page, page_size: pageSize },
    });
  }

  async getInfo(opts: {
    uri?: string;
    id?: string;
    extended?: boolean;
  }): Promise<FileResponse> {
    return this.request<FileResponse>("GET", "/file/info", {
      query: {
        uri: opts.uri,
        id: opts.id,
        extended: opts.extended ? "true" : undefined,
      },
    });
  }

  async getId(
    filePath: string,
  ): Promise<{ id: string; type: "file" | "folder"; path: string; name: string }> {
    const uri = toFileUri(filePath);
    // Prefer direct info by URI
    try {
      const info = await this.getInfo({ uri });
      return {
        id: info.id,
        type: info.type === FileType.folder ? "folder" : "file",
        path: info.path || uri,
        name: info.name,
      };
    } catch {
      // Fall back to listing parent
      const display = uriToPath(uri);
      const parent = parentPath(display);
      const name = baseName(display);
      const listing = await this.list(parent);
      const found = (listing.files || []).find((f) => f.name === name);
      if (!found) throw new CloudreveApiError(`File not found: ${filePath}`, 40044);
      return {
        id: found.id,
        type: found.type === FileType.folder ? "folder" : "file",
        path: found.path,
        name: found.name,
      };
    }
  }

  // ---------- Mutations ----------

  async createDirectory(dirPath: string): Promise<FileResponse> {
    const uri = toFileUri(dirPath);
    return this.request<FileResponse>("POST", "/file/create", {
      body: { uri, type: "folder", err_on_conflict: false },
    });
  }

  async rename(filePathOrUri: string, newName: string): Promise<FileResponse> {
    const uri = toFileUri(filePathOrUri);
    return this.request<FileResponse>("POST", "/file/rename", {
      body: { uri, new_name: newName },
    });
  }

  async move(sourcePath: string, destinationDir: string): Promise<void> {
    await this.request<void>("POST", "/file/move", {
      body: {
        uris: [toFileUri(sourcePath)],
        dst: toFileUri(destinationDir),
        copy: false,
      },
    });
  }

  async copy(sourcePath: string, destinationDir: string): Promise<void> {
    await this.request<void>("POST", "/file/move", {
      body: {
        uris: [toFileUri(sourcePath)],
        dst: toFileUri(destinationDir),
        copy: true,
      },
    });
  }

  async delete(
    paths: string | string[],
    opts: { unlink?: boolean; skipSoftDelete?: boolean } = {},
  ): Promise<void> {
    const list = Array.isArray(paths) ? paths : [paths];
    await this.request<void>("DELETE", "/file", {
      body: {
        uris: list.map((p) => toFileUri(p)),
        unlink: opts.unlink ?? false,
        skip_soft_delete: opts.skipSoftDelete ?? false,
      },
    });
  }

  // ---------- URLs / share ----------

  async getDownloadUrl(filePathOrUri: string): Promise<string> {
    const data = await this.request<FileURLResponse>("POST", "/file/url", {
      body: {
        uris: [toFileUri(filePathOrUri)],
        download: true,
      },
    });
    const url = data?.urls?.[0]?.url;
    if (!url) throw new CloudreveApiError("No download URL returned");
    return this.absUrl(url);
  }

  async getSourceUrl(filePathOrUri: string): Promise<string> {
    // Direct / source links
    const data = await this.request<{ links?: Array<{ link: string; file_url?: string }> } | Array<{ link: string }>>(
      "POST",
      "/file/source",
      { body: { uris: [toFileUri(filePathOrUri)] } },
    );
    if (Array.isArray(data)) {
      const link = data[0]?.link;
      if (!link) throw new CloudreveApiError("No source URL returned");
      return this.absUrl(link);
    }
    const link = data?.links?.[0]?.link;
    if (!link) throw new CloudreveApiError("No source URL returned");
    return this.absUrl(link);
  }

  async getShareUrl(
    filePathOrUri: string,
    opts: {
      downloads?: number;
      expire?: number;
      password?: string;
      is_private?: boolean;
      share_view?: boolean;
      show_readme?: boolean;
    } = {},
  ): Promise<unknown> {
    return this.request("POST", "/share", {
      body: {
        uri: toFileUri(filePathOrUri),
        downloads: opts.downloads,
        expire: opts.expire,
        password: opts.password,
        is_private: opts.is_private ?? Boolean(opts.password),
        share_view: opts.share_view ?? true,
        show_readme: opts.show_readme,
      },
    });
  }

  // ---------- Download / upload ----------

  async downloadToFile(filePathOrUri: string, destPath: string): Promise<string> {
    const url = await this.getDownloadUrl(filePathOrUri);
    const token = await this.auth.getAccessToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new CloudreveApiError(
        `Download failed: HTTP ${res.status} for ${url}`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return destPath;
  }

  /**
   * Upload a local file to a remote path that includes the filename
   * (e.g. `/docs/report.pdf`). Uses upload session + local/relay chunk upload.
   */
  async upload(remotePathWithName: string, localFilePath: string): Promise<void> {
    if (!fs.existsSync(localFilePath) || !fs.statSync(localFilePath).isFile()) {
      throw new Error(`Local file not found: ${localFilePath}`);
    }
    const stat = fs.statSync(localFilePath);
    const remoteUri = toFileUri(remotePathWithName);

    // Resolve storage policy from parent directory listing
    const display = uriToPath(remoteUri);
    const parent = parentPath(display);
    const listing = await this.list(parent);
    const policyId = listing.storage_policy?.id;
    if (!policyId) {
      throw new CloudreveApiError(
        "Could not determine storage policy for upload target directory",
      );
    }

    const session = await this.request<UploadCredential>("PUT", "/file/upload", {
      body: {
        uri: remoteUri,
        size: stat.size,
        policy_id: policyId,
        last_modified: Math.floor(stat.mtimeMs),
        mime_type: "",
      },
    });

    const policyType = session.storage_policy?.type || listing.storage_policy?.type || "local";
    const relay = session.storage_policy?.relay ?? listing.storage_policy?.relay;
    const chunkSize = session.chunk_size || stat.size || 1;
    const fileBuf = fs.readFileSync(localFilePath);
    const totalChunks = Math.max(1, Math.ceil(fileBuf.length / chunkSize));

    if (policyType === "local" || relay) {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(fileBuf.length, start + chunkSize);
        const chunk = fileBuf.subarray(start, end);
        await this.request("POST", `/file/upload/${session.session_id}/${i}`, {
          rawBody: chunk,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(chunk.length),
          },
          expectJson: true,
        });
      }
      return;
    }

    if (policyType === "onedrive") {
      const uploadUrl = session.upload_urls?.[0];
      if (!uploadUrl) throw new CloudreveApiError("Missing OneDrive upload URL");
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(fileBuf.length, start + chunkSize) - 1;
        const chunk = fileBuf.subarray(start, end + 1);
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${fileBuf.length}`,
          },
          body: chunk,
        });
        if (!put.ok && put.status !== 202 && put.status !== 201) {
          throw new CloudreveApiError(
            `OneDrive chunk upload failed: HTTP ${put.status}`,
          );
        }
      }
      await this.request("POST", `/callback/onedrive/${session.session_id}`, {
        body: {},
      });
      return;
    }

    // Generic pre-signed URL chunk upload (S3-like / OSS with relay false)
    if (session.upload_urls && session.upload_urls.length > 0) {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(fileBuf.length, start + chunkSize);
        const chunk = fileBuf.subarray(start, end);
        const uploadUrl =
          session.upload_urls[i] || session.upload_urls[0];
        if (!uploadUrl) throw new CloudreveApiError("Missing upload URL for chunk");
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk,
        });
        if (!put.ok && put.status !== 200 && put.status !== 201 && put.status !== 204) {
          throw new CloudreveApiError(
            `Chunk upload failed: HTTP ${put.status} @ ${uploadUrl}`,
          );
        }
      }
      // Best-effort complete callback for S3-like if present
      if (session.completeURL) {
        await fetch(session.completeURL, { method: "POST" });
      }
      return;
    }

    throw new CloudreveApiError(
      `Storage policy ${JSON.stringify(policyType)} upload is not supported by this MCP yet. Enable relay or use local storage.`,
    );
  }

  /** Small-file helper: PUT file content in one request. */
  async uploadContent(remotePathWithName: string, content: Buffer | string): Promise<void> {
    const uri = toFileUri(remotePathWithName);
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    await this.request("PUT", "/file/content", {
      query: { uri },
      rawBody: buf,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buf.length),
      },
    });
  }

  absUrl(maybeUrl: string): string {
    if (maybeUrl.startsWith("http://") || maybeUrl.startsWith("https://")) {
      return maybeUrl;
    }
    const u = maybeUrl.startsWith("/") ? maybeUrl : `/${maybeUrl}`;
    if (u.startsWith("/api/")) {
      return `${this.cfg.siteBase}${u}`;
    }
    return `${this.cfg.apiBase}${u}`;
  }

  /** Resolve remote filename for a URI/path. */
  async resolveRemoteFileName(filePathOrUri: string): Promise<string> {
    try {
      const info = await this.getInfo({ uri: toFileUri(filePathOrUri) });
      return info.name || baseName(uriToPath(toFileUri(filePathOrUri)));
    } catch {
      return baseName(uriToPath(toFileUri(filePathOrUri)));
    }
  }

  joinRemote(dir: string, name: string): string {
    return joinPath(dir, name);
  }
}
