import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AuthManager, runAuthorizationFlow } from "../oauth/flow.js";
import { CloudreveClient, CloudreveApiError } from "../cloudreve/client.js";
import { CacheStore, resolveUnderRoot } from "../cache/store.js";
import { toFileUri, uriToPath } from "../cloudreve/uri.js";
import path from "node:path";
import fs from "node:fs";

function ok(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function fail(err: unknown) {
  const message =
    err instanceof CloudreveApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

export function createServer(cfg: AppConfig): McpServer {
  const auth = new AuthManager(cfg);
  const client = new CloudreveClient(cfg, auth);
  const cache = new CacheStore(cfg.cacheRoot);
  fs.mkdirSync(cfg.downloadRoot, { recursive: true });

  const server = new McpServer({
    name: "cloudreve-mcp",
    version: "1.0.0",
  });

  // ----- Auth -----
  server.tool(
    "authorize",
    "Start Cloudreve v4 OAuth (authorization code + PKCE). Opens a browser and waits for the local callback. Requires CLOUDREVE_CLIENT_ID and CLOUDREVE_CLIENT_SECRET.",
    {
      open_browser: z
        .boolean()
        .optional()
        .describe("Open the system browser (default true)"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to wait for the OAuth callback (default 300000)"),
    },
    async (args) => {
      try {
        const { authorizeUrl, tokens } = await runAuthorizationFlow(cfg, {
          open: args.open_browser ?? true,
          timeoutMs: args.timeout_ms,
        });
        return ok({
          status: "authorized",
          authorize_url: authorizeUrl,
          access_expires_at: tokens.access_expires_at,
          has_refresh_token: Boolean(tokens.refresh_token),
          token_store: cfg.tokenStorePath,
          hint: "If the browser did not open, visit authorize_url manually while this tool is waiting.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "auth_status",
    "Show whether this MCP has a valid Cloudreve OAuth token stored locally.",
    {},
    async () => ok(auth.status()),
  );

  server.tool(
    "logout",
    "Clear locally stored Cloudreve OAuth tokens.",
    {},
    async () => {
      auth.logout();
      return ok({ status: "logged_out", token_store: cfg.tokenStorePath });
    },
  );

  // ----- Files -----
  server.tool(
    "list_files",
    "List files and folders under a Cloudreve path or File URI (default /).",
    {
      path: z
        .string()
        .optional()
        .describe("Remote path like /docs or File URI cloudreve://my/docs"),
      page: z.number().int().min(0).optional(),
      page_size: z.number().int().min(1).max(500).optional(),
    },
    async (args) => {
      try {
        const data = await client.list(args.path || "/", args.page ?? 0, args.page_size ?? 50);
        return ok(data);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_file_id",
    "Resolve a remote path to its Cloudreve file/folder id.",
    {
      path: z.string().describe("Remote path or File URI"),
    },
    async (args) => {
      try {
        return ok(await client.getId(args.path));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_file_properties",
    "Get file/folder properties by path, File URI, or id.",
    {
      path: z.string().optional().describe("Remote path or File URI"),
      file_id: z.string().optional().describe("Cloudreve file id"),
      extended: z.boolean().optional(),
    },
    async (args) => {
      try {
        if (!args.path && !args.file_id) {
          throw new Error("Provide path or file_id");
        }
        const info = await client.getInfo({
          uri: args.path ? toFileUri(args.path) : undefined,
          id: args.file_id,
          extended: args.extended ?? true,
        });
        return ok(info);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_download_url",
    "Get a temporary download URL for a remote file.",
    {
      path: z.string().describe("Remote file path or File URI"),
    },
    async (args) => {
      try {
        const url = await client.getDownloadUrl(args.path);
        return ok({ url });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "download_file",
    "Download a remote file into the configured download root (default local app data). local_path is relative to that root.",
    {
      path: z.string().describe("Remote file path or File URI"),
      local_path: z
        .string()
        .optional()
        .describe(
          "Relative path under download_root. Empty or directory-like values keep the remote filename.",
        ),
    },
    async (args) => {
      try {
        const remoteName = await client.resolveRemoteFileName(args.path);
        const dest = resolveUnderRoot(
          cfg.downloadRoot,
          args.local_path || "",
          remoteName,
        );
        await client.downloadToFile(args.path, dest);
        return ok({ saved_to: dest, download_root: cfg.downloadRoot });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "create_directory",
    "Create a remote directory.",
    {
      path: z.string().describe("Remote directory path, e.g. /docs/2025"),
    },
    async (args) => {
      try {
        const created = await client.createDirectory(args.path);
        return ok({ status: "created", file: created });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "rename_file",
    "Rename a remote file or directory.",
    {
      path: z.string().describe("Remote path or File URI"),
      new_name: z.string().describe("New basename"),
    },
    async (args) => {
      try {
        const file = await client.rename(args.path, args.new_name);
        return ok({ status: "renamed", file });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "move_file",
    "Move a remote file/folder into a destination directory.",
    {
      source_path: z.string(),
      destination_path: z.string().describe("Destination directory path"),
    },
    async (args) => {
      try {
        await client.move(args.source_path, args.destination_path);
        return ok({ status: "moved" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "copy_file",
    "Copy a remote file/folder into a destination directory.",
    {
      source_path: z.string(),
      destination_path: z.string().describe("Destination directory path"),
    },
    async (args) => {
      try {
        await client.copy(args.source_path, args.destination_path);
        return ok({ status: "copied" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "delete_file",
    "Delete remote files/folders (soft-delete to trash by default).",
    {
      path: z.string().describe("Remote path or File URI"),
      skip_soft_delete: z
        .boolean()
        .optional()
        .describe("If true, permanently delete instead of moving to trash"),
      unlink: z.boolean().optional(),
    },
    async (args) => {
      try {
        await client.delete(args.path, {
          skipSoftDelete: args.skip_soft_delete,
          unlink: args.unlink,
        });
        return ok({ status: "deleted" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "upload_file",
    "Upload a local file to Cloudreve. remote_path must include the filename (e.g. /docs/report.pdf).",
    {
      remote_path: z
        .string()
        .describe("Remote path including filename, e.g. /docs/report.pdf"),
      local_path: z
        .string()
        .describe("Absolute local filesystem path to the file to upload"),
    },
    async (args) => {
      try {
        await client.upload(args.remote_path, args.local_path);
        return ok({ status: "uploaded", remote_path: args.remote_path });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_source_url",
    "Create/get a permanent-ish direct (source) link for a file.",
    {
      path: z.string().describe("Remote file path or File URI"),
    },
    async (args) => {
      try {
        const url = await client.getSourceUrl(args.path);
        return ok({ url });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_share_url",
    "Create a share link for a file or folder.",
    {
      path: z.string().describe("Remote path or File URI"),
      is_dir: z.boolean().optional().describe("Hint only; Cloudreve v4 uses the URI type"),
      preview: z.boolean().optional(),
      downloads: z.number().int().optional(),
      expire: z.number().int().optional().describe("Expire in seconds"),
      password: z.string().optional(),
    },
    async (args) => {
      try {
        const share = await client.getShareUrl(args.path, {
          downloads: args.downloads,
          expire: args.expire,
          password: args.password,
          share_view: args.preview ?? true,
        });
        return ok(share);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ----- Cache -----
  server.tool(
    "cache_list",
    "List files in the local MCP cache directory.",
    {
      dir: z.string().optional().describe("Relative subdirectory under cache root"),
    },
    async (args) => {
      try {
        return ok({
          cache_root: cfg.cacheRoot,
          entries: cache.list(args.dir || ""),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cache_write_text",
    "Write a text file into the local MCP cache.",
    {
      path: z.string().describe("Relative cache path, e.g. tmp/note.txt"),
      text: z.string(),
    },
    async (args) => {
      try {
        const abs = cache.writeText(args.path, args.text);
        return ok({ saved_to: abs, relative: args.path });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cache_presign_url",
    "Create a short-lived signed local_uri for a cache file (HMAC). Useful for verifying cache access.",
    {
      path: z.string().describe("Relative cache path"),
      expire_seconds: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        return ok(cache.presign(args.path, args.expire_seconds ?? 600));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cloudreve_download_to_cache",
    "Download a Cloudreve file into the local MCP cache.",
    {
      path: z.string().describe("Remote file path or File URI"),
      cache_path: z
        .string()
        .optional()
        .describe("Relative cache path; defaults to remote filename"),
      presign: z.boolean().optional().describe("Also return a presigned local_uri"),
    },
    async (args) => {
      try {
        const remoteName = await client.resolveRemoteFileName(args.path);
        const rel =
          args.cache_path && args.cache_path.length > 0
            ? args.cache_path
            : remoteName;
        const abs = cache.resolve(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        await client.downloadToFile(args.path, abs);
        const result: Record<string, unknown> = {
          saved_to: abs,
          cache_path: rel,
          remote_path: args.path,
          remote_uri: toFileUri(args.path),
        };
        if (args.presign ?? true) {
          result.presign = cache.presign(rel);
        }
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "cloudreve_upload_from_cache",
    "Upload a file from the local MCP cache to Cloudreve.",
    {
      cache_path: z.string().describe("Relative cache path"),
      remote_path: z
        .string()
        .describe("Remote path including filename, e.g. /docs/report.pdf"),
    },
    async (args) => {
      try {
        const abs = cache.resolve(args.cache_path);
        if (!fs.existsSync(abs)) {
          throw new Error(`Cache file not found: ${args.cache_path}`);
        }
        await client.upload(args.remote_path, abs);
        return ok({
          status: "uploaded",
          cache_path: args.cache_path,
          remote_path: args.remote_path,
          remote_uri: toFileUri(args.remote_path),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Keep uri helper available for debugging
  server.tool(
    "to_file_uri",
    "Convert a path to a Cloudreve File URI (cloudreve://my/...).",
    {
      path: z.string(),
    },
    async (args) =>
      ok({
        uri: toFileUri(args.path),
        path: uriToPath(toFileUri(args.path)),
      }),
  );

  return server;
}
