import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";

// SF1: browser -> GCS direct upload via V4 signed URL. The API never receives image bytes
// for storefront product photos — see storefront-assets.service.ts for the two-step
// create-pending / confirm-ready flow this adapter supports.

export const ALLOWED_STOREFRONT_ASSET_CONTENT_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);
export const MAX_STOREFRONT_ASSET_BYTES = 8 * 1024 * 1024; // 8MB, matches SF1 spec
export const STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER = "x-goog-content-length-range";
export const STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE = `0,${MAX_STOREFRONT_ASSET_BYTES}`;
export const STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER = "x-goog-if-generation-match";
export const STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH = "0";
const SAFE_ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

export type StorefrontAssetSignedPutUrl = {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
};

export type StorefrontAssetHeadResult = {
  exists: boolean;
  contentLength: number | null;
  contentType: string | null;
  updatedAt: Date | null;
};

export interface StorefrontAssetStorageAdapter {
  createSignedPutUrl(input: { gcsPath: string; contentType: string; expiresAt: Date }): Promise<StorefrontAssetSignedPutUrl>;
  headObject(input: { gcsPath: string }): Promise<StorefrontAssetHeadResult>;
  deleteObject(input: { gcsPath: string }): Promise<{ deleted: boolean }>;
  downloadForHashing(input: { gcsPath: string; maxBytes: number }): Promise<Buffer>;
}

export function normalizeStorefrontAssetContentType(contentType: string | undefined) {
  const normalized = String(contentType ?? "").trim().toLowerCase();
  if (!ALLOWED_STOREFRONT_ASSET_CONTENT_TYPES.has(normalized)) {
    throw new HttpError(400, "STOREFRONT_ASSET_CONTENT_TYPE_INVALID");
  }
  return normalized;
}

function extensionForContentType(contentType: string) {
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  throw new HttpError(400, "STOREFRONT_ASSET_CONTENT_TYPE_INVALID");
}

function safeIdSegment(label: string, value: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length > 80 || !SAFE_ID_SEGMENT.test(trimmed)) {
    throw new HttpError(400, `${label}_INVALID`);
  }
  return trimmed;
}

export function buildStorefrontAssetGcsPath(input: { merchantId: string; assetId: string; contentType: string }) {
  const merchantId = safeIdSegment("MERCHANT_ID", input.merchantId);
  const assetId = safeIdSegment("ASSET_ID", input.assetId);
  const extension = extensionForContentType(normalizeStorefrontAssetContentType(input.contentType));
  return `merchants/${merchantId}/storefront/${assetId}.${extension}`;
}

function secondsUntil(expiresAt: Date, nowMs = Date.now()) {
  return Math.max(1, Math.ceil((expiresAt.getTime() - nowMs) / 1000));
}

export function sha256Hex(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Real GCS-backed adapter. Requires either a service-account key file
 * (GOOGLE_APPLICATION_CREDENTIALS) or a runtime identity with
 * roles/iam.serviceAccountTokenCreator on itself (Cloud Run default compute SA
 * usually needs this granted explicitly to self-sign V4 URLs — see the
 * shipping-weight-proof-storage.ts runtime-signer fallback in this codebase for
 * the proven pattern if bare getSignedUrl() fails with a signing-permission error
 * in production; not duplicated here to keep this module focused).
 */
export class GcsStorefrontAssetStorageAdapter implements StorefrontAssetStorageAdapter {
  private readonly bucketName: string;
  private readonly storage: Storage;

  constructor(config: { bucket: string; projectId: string; storage?: Storage }) {
    this.bucketName = config.bucket;
    this.storage = config.storage ?? new Storage({ projectId: config.projectId });
  }

  async createSignedPutUrl(input: { gcsPath: string; contentType: string; expiresAt: Date }): Promise<StorefrontAssetSignedPutUrl> {
    const contentType = normalizeStorefrontAssetContentType(input.contentType);
    try {
      const [uploadUrl] = await this.storage
        .bucket(this.bucketName)
        .file(input.gcsPath)
        .getSignedUrl({
          version: "v4",
          action: "write",
          expires: input.expiresAt,
          contentType,
          extensionHeaders: {
            [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
            [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
          }
        });
      return {
        uploadUrl,
        method: "PUT",
        headers: {
          "content-type": contentType,
          [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
          [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
        },
        expiresAt: input.expiresAt
      };
    } catch (error) {
      logger.error({ err: error, bucket: this.bucketName }, "Failed to create storefront asset signed PUT URL");
      throw new HttpError(503, "STOREFRONT_ASSET_UPLOAD_URL_FAILED");
    }
  }

  async headObject(input: { gcsPath: string }): Promise<StorefrontAssetHeadResult> {
    try {
      const [metadata] = await this.storage.bucket(this.bucketName).file(input.gcsPath).getMetadata();
      return {
        exists: true,
        contentLength: metadata.size === undefined ? null : Number(metadata.size),
        contentType: metadata.contentType ?? null,
        updatedAt: metadata.updated ? new Date(metadata.updated) : null
      };
    } catch (error) {
      const candidate = error as { code?: number | string };
      if (candidate.code === 404 || candidate.code === "404") {
        return { exists: false, contentLength: null, contentType: null, updatedAt: null };
      }
      logger.error({ err: error, bucket: this.bucketName }, "Failed to HEAD storefront asset object");
      throw new HttpError(503, "STOREFRONT_ASSET_HEAD_FAILED");
    }
  }

  async deleteObject(input: { gcsPath: string }): Promise<{ deleted: boolean }> {
    try {
      await this.storage.bucket(this.bucketName).file(input.gcsPath).delete({ ignoreNotFound: true });
      return { deleted: true };
    } catch (error) {
      logger.error({ err: error, bucket: this.bucketName }, "Failed to delete storefront asset object");
      throw new HttpError(503, "STOREFRONT_ASSET_DELETE_FAILED");
    }
  }

  async downloadForHashing(input: { gcsPath: string; maxBytes: number }): Promise<Buffer> {
    try {
      const [buffer] = await this.storage.bucket(this.bucketName).file(input.gcsPath).download();
      if (buffer.byteLength > input.maxBytes) {
        throw new HttpError(413, "STOREFRONT_ASSET_TOO_LARGE");
      }
      return buffer;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      logger.error({ err: error, bucket: this.bucketName }, "Failed to download storefront asset for hashing");
      throw new HttpError(503, "STOREFRONT_ASSET_DOWNLOAD_FAILED");
    }
  }
}

/** Used when STOREFRONT_ASSETS_GCS_BUCKET is not configured — fails closed, not silently. */
export class DisabledStorefrontAssetStorageAdapter implements StorefrontAssetStorageAdapter {
  async createSignedPutUrl(): Promise<StorefrontAssetSignedPutUrl> {
    throw new HttpError(503, "STOREFRONT_ASSET_STORAGE_DISABLED");
  }
  async headObject(): Promise<StorefrontAssetHeadResult> {
    throw new HttpError(503, "STOREFRONT_ASSET_STORAGE_DISABLED");
  }
  async deleteObject(): Promise<{ deleted: boolean }> {
    throw new HttpError(503, "STOREFRONT_ASSET_STORAGE_DISABLED");
  }
  async downloadForHashing(): Promise<Buffer> {
    throw new HttpError(503, "STOREFRONT_ASSET_STORAGE_DISABLED");
  }
}

/** In-memory adapter for tests — no network, deterministic. */
export class InMemoryStorefrontAssetStorageAdapter implements StorefrontAssetStorageAdapter {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string; updatedAt: Date }>();

  seedObject(gcsPath: string, bytes: Buffer, contentType: string) {
    this.objects.set(gcsPath, { bytes, contentType, updatedAt: new Date() });
  }

  async createSignedPutUrl(input: { gcsPath: string; contentType: string; expiresAt: Date }): Promise<StorefrontAssetSignedPutUrl> {
    const contentType = normalizeStorefrontAssetContentType(input.contentType);
    return {
      uploadUrl: `mock://storefront-asset-put/${encodeURIComponent(input.gcsPath)}`,
      method: "PUT",
      headers: {
        "content-type": contentType,
        [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
        [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
      },
      expiresAt: input.expiresAt
    };
  }

  async headObject(input: { gcsPath: string }): Promise<StorefrontAssetHeadResult> {
    const object = this.objects.get(input.gcsPath);
    if (!object) return { exists: false, contentLength: null, contentType: null, updatedAt: null };
    return {
      exists: true,
      contentLength: object.bytes.byteLength,
      contentType: object.contentType,
      updatedAt: object.updatedAt
    };
  }

  async deleteObject(input: { gcsPath: string }): Promise<{ deleted: boolean }> {
    return { deleted: this.objects.delete(input.gcsPath) };
  }

  async downloadForHashing(input: { gcsPath: string; maxBytes: number }): Promise<Buffer> {
    const object = this.objects.get(input.gcsPath);
    if (!object) throw new HttpError(404, "STOREFRONT_ASSET_NOT_FOUND");
    if (object.bytes.byteLength > input.maxBytes) throw new HttpError(413, "STOREFRONT_ASSET_TOO_LARGE");
    return object.bytes;
  }
}

export type StorefrontAssetStorageEnvSource = {
  STOREFRONT_ASSETS_GCS_BUCKET?: string | undefined;
  STOREFRONT_ASSETS_GCS_PROJECT_ID?: string | undefined;
  GCP_PROJECT_ID?: string | undefined;
  STOREFRONT_ASSETS_CDN_HOST?: string | undefined;
  NODE_ENV?: string | undefined;
};

let cachedAdapter: StorefrontAssetStorageAdapter | null = null;

export function getStorefrontAssetStorageAdapter(env: StorefrontAssetStorageEnvSource = process.env): StorefrontAssetStorageAdapter {
  if (cachedAdapter) return cachedAdapter;

  const bucket = String(env.STOREFRONT_ASSETS_GCS_BUCKET ?? "").trim();
  const projectId = String(env.STOREFRONT_ASSETS_GCS_PROJECT_ID ?? env.GCP_PROJECT_ID ?? "").trim();

  if (!bucket || !projectId) {
    logger.warn("STOREFRONT_ASSETS_GCS_BUCKET/PROJECT_ID not configured — storefront asset uploads are disabled");
    cachedAdapter = new DisabledStorefrontAssetStorageAdapter();
    return cachedAdapter;
  }

  cachedAdapter = new GcsStorefrontAssetStorageAdapter({ bucket, projectId });
  return cachedAdapter;
}

export function resetStorefrontAssetStorageAdapterForTests(adapter?: StorefrontAssetStorageAdapter) {
  cachedAdapter = adapter ?? null;
}

export function getStorefrontAssetsCdnHost(env: StorefrontAssetStorageEnvSource = process.env) {
  return String(env.STOREFRONT_ASSETS_CDN_HOST ?? "").trim() || null;
}

/** Builds the public, CDN-served URL for a ready asset. Null if no CDN host is configured. */
export function buildStorefrontAssetPublicUrl(gcsPath: string, env: StorefrontAssetStorageEnvSource = process.env) {
  const cdnHost = getStorefrontAssetsCdnHost(env);
  if (!cdnHost) return null;
  return `https://${cdnHost.replace(/\/+$/, "")}/${gcsPath}`;
}
