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
const GCS_XML_HOST = "storage.googleapis.com";
const GCS_METADATA_SERVICE_ACCOUNT_EMAIL_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const GCS_METADATA_ACCESS_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const GCS_SERVICE_ACCOUNT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export type GcsStorefrontAssetRuntimeSignInput = {
  serviceAccountEmail: string;
  stringToSign: string;
};

export type GcsStorefrontAssetRuntimeSigner = (input: GcsStorefrontAssetRuntimeSignInput) => Promise<string>;
export type GcsStorefrontAssetServiceAccountEmailResolver = () => Promise<string | null | undefined>;
export type GcsStorefrontAssetAccessTokenProvider = () => Promise<string | { token?: string | null | undefined } | null | undefined>;
export type GcsStorefrontAssetIamSignBlobRequest = (input: {
  url: string;
  accessToken: string;
  payload: string;
}) => Promise<{ signedBlob?: string | undefined }>;
export type GcsStorefrontAssetAuthClient = {
  getCredentials?: () => Promise<{ client_email?: string | null | undefined }>;
  getAccessToken?: GcsStorefrontAssetAccessTokenProvider;
};

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

export function sha256Hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeGcsComponent(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeGcsPathSegment(value: string) {
  const segment = String(value ?? "");
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment)) {
    throw new HttpError(400, "STOREFRONT_ASSET_GCS_PATH_INVALID");
  }
  return encodeGcsComponent(segment);
}

function buildGcsXmlPathStyleObjectPath(gcsPath: string) {
  const trimmed = String(gcsPath ?? "").trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\") || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, "STOREFRONT_ASSET_GCS_PATH_INVALID");
  }
  return trimmed.split("/").map(encodeGcsPathSegment).join("/");
}

function buildGcsXmlPathStyleCanonicalUri(bucketName: string, gcsPath: string) {
  return `/${encodeGcsComponent(bucketName)}/${buildGcsXmlPathStyleObjectPath(gcsPath)}`;
}

function gcsTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function gcsDateStamp(date: Date) {
  return gcsTimestamp(date).slice(0, 8);
}

function canonicalGcsQuery(params: Record<string, string>) {
  return Object.keys(params).sort().map((key) => `${encodeGcsComponent(key)}=${encodeGcsComponent(params[key]!)}`).join("&");
}

function validateGcsSigningServiceAccount(value: string) {
  const email = String(value ?? "").trim();
  if (!email || !GCS_SERVICE_ACCOUNT_EMAIL_SHAPE.test(email)) {
    throw Object.assign(new Error("STOREFRONT_ASSET_GCS_SIGNER_MISCONFIGURED"), {
      code: "STOREFRONT_ASSET_GCS_SIGNER_MISCONFIGURED"
    });
  }
  return email;
}

function normalizeAccessToken(value: string | { token?: string | null | undefined } | null | undefined) {
  const token = typeof value === "string" ? value : value?.token;
  const trimmed = String(token ?? "").trim();
  return trimmed || null;
}

async function resolveCloudRunServiceAccountEmail() {
  if (typeof fetch !== "function") return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 1000) : null;
  try {
    const response = await fetch(GCS_METADATA_SERVICE_ACCOUNT_EMAIL_URL, {
      headers: { "Metadata-Flavor": "Google" },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) return null;
    const email = String(await response.text()).trim();
    return email.includes("@") ? email : null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchGcsMetadataAccessToken() {
  if (typeof fetch !== "function") return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 1000) : null;
  try {
    const response = await fetch(GCS_METADATA_ACCESS_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) return null;
    const body = await response.json() as { access_token?: string | undefined };
    return normalizeAccessToken(body.access_token);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function defaultIamCredentialsSignBlobRequest(input: {
  url: string;
  accessToken: string;
  payload: string;
}) {
  if (typeof fetch !== "function") {
    throw new Error("STOREFRONT_ASSET_GCS_SIGN_BLOB_FETCH_UNAVAILABLE");
  }
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ payload: input.payload })
  });
  if (!response.ok) {
    throw Object.assign(new Error(`STOREFRONT_ASSET_GCS_IAM_SIGN_BLOB_FAILED_${response.status}`), {
      code: response.status
    });
  }
  const data = await response.json() as { signedBlob?: string | undefined };
  return { signedBlob: data.signedBlob };
}

/**
 * Real GCS-backed adapter. Requires either a service-account key file
 * (GOOGLE_APPLICATION_CREDENTIALS) or a runtime identity with
 * roles/iam.serviceAccountTokenCreator on itself. Cloud Run uses the official
 * library first, then falls back to IAM Credentials signBlob when metadata-based
 * signing is unavailable.
 */
export class GcsStorefrontAssetStorageAdapter implements StorefrontAssetStorageAdapter {
  private readonly bucketName: string;
  private readonly storage: Storage;
  private readonly signingServiceAccount?: string | undefined;
  private readonly authClient?: GcsStorefrontAssetAuthClient | undefined;
  private readonly accessTokenProvider?: GcsStorefrontAssetAccessTokenProvider | undefined;
  private readonly iamSignBlobRequest: GcsStorefrontAssetIamSignBlobRequest;
  private readonly runtimeSigner?: GcsStorefrontAssetRuntimeSigner | undefined;
  private readonly serviceAccountEmailResolver: GcsStorefrontAssetServiceAccountEmailResolver;

  constructor(config: {
    bucket: string;
    projectId: string;
    signingServiceAccount?: string | undefined;
    storage?: Storage;
    authClient?: GcsStorefrontAssetAuthClient | undefined;
    accessTokenProvider?: GcsStorefrontAssetAccessTokenProvider | undefined;
    iamSignBlobRequest?: GcsStorefrontAssetIamSignBlobRequest | undefined;
    runtimeSigner?: GcsStorefrontAssetRuntimeSigner | undefined;
    serviceAccountEmailResolver?: GcsStorefrontAssetServiceAccountEmailResolver | undefined;
  }) {
    this.bucketName = config.bucket;
    this.storage = config.storage ?? new Storage({ projectId: config.projectId });
    this.signingServiceAccount = String(config.signingServiceAccount ?? "").trim() || undefined;
    this.authClient = config.authClient ?? (this.storage as unknown as { authClient?: GcsStorefrontAssetAuthClient }).authClient;
    this.accessTokenProvider = config.accessTokenProvider;
    this.iamSignBlobRequest = config.iamSignBlobRequest ?? defaultIamCredentialsSignBlobRequest;
    this.runtimeSigner = config.runtimeSigner;
    this.serviceAccountEmailResolver = config.serviceAccountEmailResolver ?? resolveCloudRunServiceAccountEmail;
  }

  private requiredPutHeaders(contentType: string) {
    return {
      "content-type": contentType,
      [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
      [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
    };
  }

  private async resolveSigningServiceAccount() {
    if (this.signingServiceAccount) return validateGcsSigningServiceAccount(this.signingServiceAccount);
    const credentials = await this.authClient?.getCredentials?.();
    const email = String(credentials?.client_email ?? "").trim();
    if (email) return validateGcsSigningServiceAccount(email);
    const runtimeEmail = String(await this.serviceAccountEmailResolver().catch(() => null) ?? "").trim();
    if (runtimeEmail) return validateGcsSigningServiceAccount(runtimeEmail);
    throw new Error("STOREFRONT_ASSET_GCS_SIGNING_SERVICE_ACCOUNT_UNAVAILABLE");
  }

  private async resolveRuntimeAccessToken() {
    const fromInjectedProvider = normalizeAccessToken(await this.accessTokenProvider?.().catch(() => null));
    if (fromInjectedProvider) return fromInjectedProvider;

    const fromAuthClient = normalizeAccessToken(await this.authClient?.getAccessToken?.().catch(() => null));
    if (fromAuthClient) return fromAuthClient;

    const fromMetadata = await fetchGcsMetadataAccessToken();
    if (fromMetadata) return fromMetadata;

    throw new Error("STOREFRONT_ASSET_GCS_RUNTIME_ACCESS_TOKEN_UNAVAILABLE");
  }

  private async signRuntimeBlob(stringToSign: string, serviceAccountEmail: string) {
    if (this.runtimeSigner) {
      const signedBlob = await this.runtimeSigner({ serviceAccountEmail, stringToSign });
      if (!signedBlob) throw new Error("STOREFRONT_ASSET_GCS_SIGNING_EMPTY_SIGNATURE");
      return signedBlob;
    }

    const payload = Buffer.from(stringToSign, "utf8").toString("base64");
    const encodedEmail = encodeURIComponent(serviceAccountEmail);
    const accessToken = await this.resolveRuntimeAccessToken();
    const response = await this.iamSignBlobRequest({
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodedEmail}:signBlob`,
      accessToken,
      payload
    });
    const signedBlob = response.signedBlob;
    if (!signedBlob) throw new Error("STOREFRONT_ASSET_GCS_SIGNING_EMPTY_SIGNATURE");
    return signedBlob;
  }

  private async createRuntimeSignedPutUrl(input: { gcsPath: string; contentType: string; expiresAt: Date }): Promise<StorefrontAssetSignedPutUrl> {
    const requestDate = new Date();
    const dateTime = gcsTimestamp(requestDate);
    const dateStamp = gcsDateStamp(requestDate);
    const method = "PUT";
    const canonicalUri = buildGcsXmlPathStyleCanonicalUri(this.bucketName, input.gcsPath);
    const headers = {
      ...this.requiredPutHeaders(input.contentType),
      host: GCS_XML_HOST
    };
    const sortedHeaderKeys = Object.keys(headers).sort();
    const signedHeaders = sortedHeaderKeys.join(";");
    const canonicalHeaders = sortedHeaderKeys.map((key) => `${key}:${headers[key as keyof typeof headers].trim()}\n`).join("");
    const serviceAccountEmail = await this.resolveSigningServiceAccount();
    const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
    const query = {
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential": `${serviceAccountEmail}/${credentialScope}`,
      "X-Goog-Date": dateTime,
      "X-Goog-Expires": String(secondsUntil(input.expiresAt)),
      "X-Goog-SignedHeaders": signedHeaders
    };
    const canonicalQuery = canonicalGcsQuery(query);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD"
    ].join("\n");
    const stringToSign = [
      "GOOG4-RSA-SHA256",
      dateTime,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const signatureBase64 = await this.signRuntimeBlob(stringToSign, serviceAccountEmail);
    const signatureHex = Buffer.from(signatureBase64, "base64").toString("hex");
    return {
      uploadUrl: `https://${GCS_XML_HOST}${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${signatureHex}`,
      method: "PUT",
      headers: this.requiredPutHeaders(input.contentType),
      expiresAt: input.expiresAt
    };
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
        headers: this.requiredPutHeaders(contentType),
        expiresAt: input.expiresAt
      };
    } catch (error) {
      try {
        const fallback = await this.createRuntimeSignedPutUrl({
          gcsPath: input.gcsPath,
          contentType,
          expiresAt: input.expiresAt
        });
        logger.warn({ err: error, bucket: this.bucketName }, "Storefront asset signed PUT URL used runtime IAM fallback");
        return fallback;
      } catch (runtimeError) {
        logger.error({ err: runtimeError, originalErr: error, bucket: this.bucketName }, "Failed to create storefront asset signed PUT URL");
        throw new HttpError(503, "STOREFRONT_ASSET_UPLOAD_URL_FAILED");
      }
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
  STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT?: string | undefined;
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

  cachedAdapter = new GcsStorefrontAssetStorageAdapter({
    bucket,
    projectId,
    signingServiceAccount: String(env.STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT ?? "").trim() || undefined
  });
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
