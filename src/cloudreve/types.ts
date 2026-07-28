export interface ApiEnvelope<T = unknown> {
  code: number;
  data?: T;
  msg?: string;
  error?: string;
  correlation_id?: string;
}

export interface FileResponse {
  type: number; // 0 file, 1 folder
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  size?: number;
  path: string;
  shared?: boolean;
  capability?: string;
  owned?: boolean;
  extended_info?: Record<string, unknown>;
}

export interface ListResponse {
  files: FileResponse[];
  pagination?: {
    page: number;
    page_size: number;
    total_items?: number;
    next_token?: string;
    is_cursor?: boolean;
  };
  props?: Record<string, unknown>;
  parent?: FileResponse;
  storage_policy?: StoragePolicy;
}

export interface StoragePolicy {
  id: string;
  name?: string;
  type: string;
  relay?: boolean;
  chunk_concurrency?: number;
  max_size?: number;
}

export interface UploadCredential {
  session_id: string;
  expires: number;
  chunk_size: number;
  upload_urls?: string[];
  credential?: string;
  storage_policy?: StoragePolicy;
  uri?: string;
  completeURL?: string;
  uploadID?: string;
  callback?: string;
}

export interface FileURLResponse {
  urls: Array<{ url: string; stream_saver_display_name?: string }>;
  expires?: string;
}

export const FileType = {
  file: 0,
  folder: 1,
} as const;
