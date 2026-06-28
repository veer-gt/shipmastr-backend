import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Storage } from "@google-cloud/storage";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_AWB_LENGTH = 64;
const MAX_SEGMENT_LENGTH = 160;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
export const DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const OFFICIAL_GCS_FALLBACK_UPLOAD_CONTENT_TYPE = "application/octet-stream";
const SUPPORTED_OFFICIAL_GCS_WRITE_SIGNED_URL_OPTION_KEYS = new Set(["version", "action", "expires", "contentType"]);
export const WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX = "weight-guard-diagnostics";

export type CreatePresignedPutUrlInput = {
  objectKey: string;
  contentType: string;
  expectedByteSize?: number | null | undefined;
  expiresAt: Date;
};

export type CreatePresignedPutUrlResult = {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
};

export type HeadObjectInput = {
  objectKey: string;
};

export type HeadObjectResult = {
  exists: boolean;
  contentLength?: number | null | undefined;
  contentType?: string | null | undefined;
  updatedAt?: Date | null | undefined;
};

export type CreatePresignedGetUrlInput = {
  objectKey: string;
  expiresAt: Date;
};

export type CreatePresignedGetUrlResult = {
  downloadUrl: string;
  expiresAt: Date;
};

export type PutObjectInput = {
  objectKey: string;
  body: Buffer | Uint8Array;
  contentType: string;
  sizeBytes: number;
};

export type DeleteObjectInput = {
  objectKey: string;
};

export type DeleteObjectResult = {
  deleted: boolean;
  missing?: boolean | undefined;
};

export type BuildWeightProofObjectKeyInput = {
  sellerOrMerchantId: string;
  awbNumber: string;
  captureSessionId: string;
  capturedAt?: Date | undefined;
  contentType?: string | undefined;
};

export interface WeightProofStorageAdapter {
  createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult>;
  putObject(input: PutObjectInput): Promise<HeadObjectResult>;
  headObject(input: HeadObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: DeleteObjectInput): Promise<DeleteObjectResult>;
  createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult>;
}

export type WeightProofStorageProvider = "disabled" | "mock" | "r2" | "gcs";

export type WeightProofStorageRuntime = {
  enabled: boolean;
  provider: WeightProofStorageProvider;
  storage: WeightProofStorageAdapter;
  uploadTtlMs: number;
  signedGetTtlMs: number;
  maxImageBytes: number;
};

export type WeightProofStorageEnvSource = {
  WEIGHT_GUARD_PROOF_STORAGE_ENABLED?: string | boolean | undefined;
  WEIGHT_GUARD_STORAGE_PROVIDER?: string | undefined;
  WEIGHT_GUARD_UPLOAD_TTL_SECONDS?: string | number | undefined;
  WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS?: string | number | undefined;
  WEIGHT_GUARD_MAX_IMAGE_BYTES?: string | number | undefined;
  WEIGHT_GUARD_R2_ACCOUNT_ID?: string | undefined;
  WEIGHT_GUARD_R2_ACCESS_KEY_ID?: string | undefined;
  WEIGHT_GUARD_R2_SECRET_ACCESS_KEY?: string | undefined;
  WEIGHT_GUARD_R2_BUCKET?: string | undefined;
  WEIGHT_GUARD_R2_REGION?: string | undefined;
  WEIGHT_GUARD_R2_ENDPOINT?: string | undefined;
  WEIGHT_GUARD_GCS_BUCKET?: string | undefined;
  WEIGHT_GUARD_GCS_PROJECT_ID?: string | undefined;
  WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT?: string | undefined;
};

export type R2WeightProofStorageConfig = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  signedGetTtlMs: number;
  maxImageBytes: number;
  client?: S3Client | undefined;
  presigner?: R2Presigner | undefined;
};

export type GcsSignedUrlAction = "read" | "write";

export type GcsWeightProofFile = {
  getSignedUrl(config: {
    version: "v4";
    action: GcsSignedUrlAction;
    expires: Date | number;
    contentType?: string | undefined;
  }): Promise<[string]>;
  save(data: Buffer | Uint8Array, options: {
    resumable?: boolean | undefined;
    contentType?: string | undefined;
    metadata?: {
      contentType?: string | undefined;
    } | undefined;
  }): Promise<unknown>;
  getMetadata(): Promise<[{
    size?: string | number | undefined;
    contentType?: string | undefined;
    updated?: string | Date | undefined;
    timeCreated?: string | Date | undefined;
  }]>;
  delete?(options?: { ignoreNotFound?: boolean | undefined }): Promise<unknown>;
};

export type GcsWeightProofListedFile = {
  name?: string | undefined;
};

export type GcsWeightProofBucket = {
  file(objectKey: string): GcsWeightProofFile;
  getFiles?(options: {
    prefix: string;
    autoPaginate?: boolean | undefined;
    maxResults?: number | undefined;
  }): Promise<[GcsWeightProofListedFile[]]>;
};

export type GcsRuntimeSignInput = {
  serviceAccountEmail: string;
  stringToSign: string;
};

export type GcsRuntimeSigner = (input: GcsRuntimeSignInput) => Promise<string>;
export type GcsServiceAccountEmailResolver = () => Promise<string | null | undefined>;
export type GcsAccessTokenProvider = () => Promise<string | { token?: string | null | undefined } | null | undefined>;
export type GcsMediaUploadRequest = (input: {
  url: string;
  accessToken: string;
  body: Buffer;
  contentType: string;
  sizeBytes: number;
}) => Promise<{
  ok: boolean;
  status: number;
  metadata?: {
    name?: string | undefined;
    size?: string | number | undefined;
    contentType?: string | undefined;
    updated?: string | Date | undefined;
    timeCreated?: string | Date | undefined;
  } | null | undefined;
}>;
export type GcsMetadataRequest = (input: {
  url: string;
  accessToken: string;
  objectKey: string;
}) => Promise<{
  ok: boolean;
  status: number;
  metadata?: {
    name?: string | undefined;
    size?: string | number | undefined;
    contentType?: string | undefined;
    updated?: string | Date | undefined;
    timeCreated?: string | Date | undefined;
  } | null | undefined;
}>;
export type GcsDeleteRequest = (input: {
  url: string;
  accessToken: string;
  objectKey: string;
}) => Promise<{
  ok: boolean;
  status: number;
}>;
export type GcsIamSignBlobRequest = (input: {
  url: string;
  accessToken: string;
  payload: string;
}) => Promise<{ signedBlob?: string | undefined }>;

export type GcsWeightProofAuthClient = {
  getCredentials?: () => Promise<{ client_email?: string | null | undefined }>;
  getAccessToken?: GcsAccessTokenProvider;
};

export type GcsSignedUrlDiagnostic = {
  provider: "gcs";
  operation: "signed_put" | "signed_get";
  category: string;
  errorClass: string;
  errorName: string | null;
  errorCode: string | number | null;
  sanitizedMessage: string;
  bucketConfigured: boolean;
  projectConfigured: boolean;
  signingServiceAccountConfigured: boolean;
  contentTypeAccepted: boolean;
  runtimeSignerConfigured: boolean;
  expiresFormat?: "timestamp_ms" | "date" | "unknown" | undefined;
  ttlSeconds?: number | null | undefined;
  contentTypePresent?: boolean | undefined;
  officialConfigShapeValid?: boolean | undefined;
  hasUnsupportedOfficialSignedUrlOptions?: boolean | undefined;
};

export type GcsWeightProofDiagnosticsReporter = (diagnostic: GcsSignedUrlDiagnostic) => void;

export type GcsWeightProofStorageConfig = {
  bucket: string;
  projectId: string;
  signingServiceAccount?: string | undefined;
  signedGetTtlMs: number;
  maxImageBytes: number;
  authClient?: GcsWeightProofAuthClient | undefined;
  accessTokenProvider?: GcsAccessTokenProvider | undefined;
  bucketClient?: GcsWeightProofBucket | undefined;
  diagnostics?: GcsWeightProofDiagnosticsReporter | undefined;
  iamSignBlobRequest?: GcsIamSignBlobRequest | undefined;
  metadataRequest?: GcsMetadataRequest | undefined;
  mediaUploadRequest?: GcsMediaUploadRequest | undefined;
  deleteRequest?: GcsDeleteRequest | undefined;
  runtimeSigner?: GcsRuntimeSigner | undefined;
  serviceAccountEmailResolver?: GcsServiceAccountEmailResolver | undefined;
  storage?: Storage | undefined;
};

type R2PresignableCommand = PutObjectCommand | GetObjectCommand;
export type R2Presigner = (
  client: S3Client,
  command: R2PresignableCommand,
  options: { expiresIn: number }
) => Promise<string>;

function safeSegment(label: string, value: string, maxLength = MAX_SEGMENT_LENGTH) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length > maxLength || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || /\s|[\u0000-\u001f\u007f]/.test(trimmed) || !SAFE_SEGMENT.test(trimmed)) {
    throw new HttpError(400, `${label}_INVALID`);
  }
  return trimmed;
}

export function validateWeightProofObjectKey(objectKey: string) {
  const trimmed = String(objectKey ?? "").trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\") || /\s|[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, "WEIGHT_PROOF_OBJECT_KEY_INVALID");
  }
  const parts = trimmed.split("/");
  if (parts.length !== 6 || parts[0] !== "weight-proofs") {
    throw new HttpError(400, "WEIGHT_PROOF_OBJECT_KEY_INVALID");
  }
  const prefix = parts[0]!;
  const merchantId = parts[1]!;
  const year = parts[2]!;
  const month = parts[3]!;
  const awbNumber = parts[4]!;
  const fileName = parts[5]!;
  void prefix;
  safeSegment("MERCHANT_ID", merchantId);
  if (!/^[0-9]{4}$/.test(year) || !/^[0-9]{2}$/.test(month)) {
    throw new HttpError(400, "WEIGHT_PROOF_OBJECT_KEY_INVALID");
  }
  safeSegment("AWB_NUMBER", awbNumber, MAX_AWB_LENGTH);
  if (!fileName.endsWith(".jpg") && !fileName.endsWith(".png")) {
    throw new HttpError(400, "WEIGHT_PROOF_OBJECT_KEY_INVALID");
  }
  const extensionLength = fileName.endsWith(".jpg") ? 4 : 4;
  safeSegment("CAPTURE_SESSION_ID", fileName.slice(0, -extensionLength));
  return trimmed;
}

export function validateWeightGuardDiagnosticObjectKey(objectKey: string) {
  const trimmed = String(objectKey ?? "").trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\\") || /\s|[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, "WEIGHT_GUARD_DIAGNOSTIC_OBJECT_KEY_INVALID");
  }
  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts[0] !== WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX) {
    throw new HttpError(400, "WEIGHT_GUARD_DIAGNOSTIC_OBJECT_KEY_INVALID");
  }
  const fileName = parts[1]!;
  if (!fileName.endsWith(".jpg") && !fileName.endsWith(".png")) {
    throw new HttpError(400, "WEIGHT_GUARD_DIAGNOSTIC_OBJECT_KEY_INVALID");
  }
  const extensionLength = fileName.endsWith(".jpg") ? 4 : 4;
  safeSegment("DIAGNOSTIC_OBJECT_ID", fileName.slice(0, -extensionLength));
  return trimmed;
}

export function validateWeightProofStorageObjectKey(objectKey: string) {
  const trimmed = String(objectKey ?? "").trim();
  if (trimmed.startsWith(`${WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX}/`)) {
    return validateWeightGuardDiagnosticObjectKey(trimmed);
  }
  return validateWeightProofObjectKey(trimmed);
}

export function validateWeightGuardDiagnosticObjectPrefix(prefix: string) {
  const trimmed = String(prefix ?? "").trim();
  if (trimmed !== `${WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX}/`) {
    throw new HttpError(400, "WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX_INVALID");
  }
  return trimmed;
}

function extensionForContentType(contentType: string | undefined) {
  const normalized = normalizeWeightProofContentType(contentType);
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  throw new HttpError(400, "WEIGHT_PROOF_CONTENT_TYPE_INVALID");
}

export function normalizeWeightProofContentType(contentType: string | undefined) {
  const normalized = String(contentType ?? "image/jpeg").trim().toLowerCase();
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(normalized)) {
    throw new HttpError(400, "WEIGHT_PROOF_CONTENT_TYPE_INVALID");
  }
  return normalized;
}

function validateExpectedByteSizeForStorage(value: number | null | undefined, maxImageBytes: number) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, "WEIGHT_PROOF_EXPECTED_SIZE_INVALID");
  if (value > maxImageBytes) throw new HttpError(400, "WEIGHT_GUARD_IMAGE_TOO_LARGE");
}

function validateBackendUploadSizeForStorage(value: number, maxImageBytes: number) {
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  if (value > maxImageBytes) throw new HttpError(413, "WEIGHT_GUARD_UPLOAD_TOO_LARGE");
}

function normalizeBackendUploadBody(body: Buffer | Uint8Array) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new HttpError(400, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
}

function secondsUntil(expiresAt: Date, nowMs = Date.now()) {
  const seconds = Math.ceil((expiresAt.getTime() - nowMs) / 1000);
  return Math.max(1, seconds);
}

function normalizeOfficialGcsWriteContentType(contentType: string | undefined) {
  const normalized = String(contentType ?? "").trim().toLowerCase();
  if (!normalized) return OFFICIAL_GCS_FALLBACK_UPLOAD_CONTENT_TYPE;
  if (ALLOWED_IMAGE_CONTENT_TYPES.has(normalized) || normalized === OFFICIAL_GCS_FALLBACK_UPLOAD_CONTENT_TYPE) {
    return normalized;
  }
  throw new HttpError(400, "WEIGHT_PROOF_CONTENT_TYPE_INVALID");
}

export function buildOfficialGcsWriteSignedUrlConfig(input: {
  expiresAt: Date;
  contentType?: string | undefined;
  nowMs?: number | undefined;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const ttlSeconds = secondsUntil(input.expiresAt, nowMs);
  const contentType = normalizeOfficialGcsWriteContentType(input.contentType);
  const expires = nowMs + ttlSeconds * 1000;
  const config = {
    version: "v4" as const,
    action: "write" as const,
    expires,
    contentType
  };
  const hasUnsupportedOfficialSignedUrlOptions = Object.keys(config).some((key) => !SUPPORTED_OFFICIAL_GCS_WRITE_SIGNED_URL_OPTION_KEYS.has(key));
  return {
    config,
    diagnostics: {
      expiresFormat: "timestamp_ms" as const,
      ttlSeconds,
      contentTypePresent: Boolean(contentType),
      officialConfigShapeValid: Number.isFinite(expires)
        && expires > 0
        && contentType.length > 0
        && config.version === "v4"
        && config.action === "write"
        && !hasUnsupportedOfficialSignedUrlOptions,
      hasUnsupportedOfficialSignedUrlOptions
    }
  };
}

function encodeGcsComponent(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeGcsXmlPathSegment(value: string) {
  const segment = String(value ?? "");
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || /[\u0000-\u001f\u007f]/.test(segment)) {
    throw new HttpError(400, "WEIGHT_GUARD_GCS_OBJECT_PATH_INVALID");
  }
  return encodeGcsComponent(segment);
}

export function buildGcsXmlPathStyleObjectPath(objectKey: string) {
  const rawObjectKey = validateWeightProofStorageObjectKey(objectKey);
  return rawObjectKey.split("/").map(encodeGcsXmlPathSegment).join("/");
}

function buildGcsXmlPathStyleCanonicalUri(bucketName: string, objectKey: string) {
  return `/${encodeGcsComponent(bucketName)}/${buildGcsXmlPathStyleObjectPath(objectKey)}`;
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

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function getWeightProofObjectKeyDiagnostics(objectKey: string | null | undefined) {
  const trimmed = String(objectKey ?? "").trim();
  const objectKeyPrefixCategory = trimmed.startsWith("weight-proofs/")
    ? "weight-proofs"
    : trimmed.startsWith(`${WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX}/`)
      ? WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX
      : "unknown";
  return {
    objectKeyPresent: Boolean(trimmed),
    objectKeyHash: trimmed ? sha256Hex(trimmed).slice(0, 16) : null,
    objectKeyPrefixCategory
  };
}

export function getGcsSignedUrlObjectPathDiagnostics(input: {
  rawObjectKey: string | null | undefined;
  signedUrl: string | null | undefined;
  bucketName: string | null | undefined;
}) {
  const rawObjectKey = String(input.rawObjectKey ?? "").trim();
  const rawKeyHash = rawObjectKey ? sha256Hex(rawObjectKey).slice(0, 16) : null;
  let signedPathKeyHash: string | null = null;
  let signedPathPresent = false;
  let signedPathHasEncodedSlash = false;

  try {
    const bucketName = String(input.bucketName ?? "").trim();
    const signedUrl = String(input.signedUrl ?? "").trim();
    if (bucketName && signedUrl) {
      const url = new URL(signedUrl);
      const pathSegments = url.pathname.replace(/^\/+/, "").split("/");
      const bucketSegment = pathSegments.shift();
      if (bucketSegment && decodeURIComponent(bucketSegment) === bucketName && pathSegments.length > 0) {
        signedPathPresent = true;
        signedPathHasEncodedSlash = pathSegments.some((segment) => /%2f/i.test(segment));
        const signedPathKey = signedPathHasEncodedSlash
          ? pathSegments.join("/")
          : pathSegments.map((segment) => decodeURIComponent(segment)).join("/");
        signedPathKeyHash = sha256Hex(signedPathKey).slice(0, 16);
      }
    }
  } catch {
    signedPathPresent = false;
  }

  return {
    rawKeyHash,
    signedPathKeyHash,
    signedPathPresent,
    signedPathHasEncodedSlash,
    sameObjectKeyHash: Boolean(rawKeyHash && signedPathKeyHash && rawKeyHash === signedPathKeyHash)
  };
}

export function getWeightProofObjectKeyPrefix(objectKey: string) {
  const rawObjectKey = validateWeightProofStorageObjectKey(objectKey);
  const lastSlash = rawObjectKey.lastIndexOf("/");
  return rawObjectKey.slice(0, lastSlash + 1);
}

function safeErrorField(value: unknown, maxLength = 180, redactedValues: Array<string | undefined> = []) {
  let safe = String(value ?? "")
    .replace(/https?:\/\/[^\s")]+/gi, "[redacted-url]")
    .replace(/storage[.]googleapis[.]com/gi, "[redacted-storage-host]")
    .replace(/\b(imageObjectKey|image_object_key|objectKey)\b\s*[:=]\s*["']?weight-proofs\/[A-Za-z0-9_./=-]+["']?/gi, "$1=object-key-redacted")
    .replace(/weight-proofs\/[A-Za-z0-9_./=-]+/g, "object-key-redacted")
    .replace(/\b(imageObjectKey|image_object_key|objectKey)\b\s*[:=]\s*["']?weight-guard-diagnostics\/[A-Za-z0-9_./=-]+["']?/gi, "$1=diagnostic-object-key-redacted")
    .replace(/weight-guard-diagnostics\/[A-Za-z0-9_./=-]+/g, "diagnostic-object-key-redacted")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/([?&](?:X-Goog-Signature|X-Goog-Credential|X-Goog-Security-Token|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(private[_-]?key|client[_-]?secret|secret|token)\b/gi, "[redacted-sensitive-word]")
    .slice(0, maxLength);
  for (const valueToRedact of redactedValues) {
    if (valueToRedact) safe = safe.split(valueToRedact).join("[redacted-config]");
  }
  return safe;
}

function safeGcsErrorCategory(error: unknown) {
  const candidate = error as { code?: string | number; message?: string; name?: string; status?: string | number };
  const combined = `${candidate.code ?? ""} ${candidate.status ?? ""} ${candidate.name ?? ""} ${candidate.message ?? ""}`.toLowerCase();
  if (combined.includes("weight_guard_gcs_signer_misconfigured") || combined.includes("signer misconfigured")) return "WEIGHT_GUARD_GCS_SIGNER_MISCONFIGURED";
  if (combined.includes("permission") || combined.includes("denied") || combined.includes("forbidden") || combined.includes("403")) return "GCS_PERMISSION_DENIED";
  if (combined.includes("sign") || combined.includes("iamcredentials") || combined.includes("service account")) return "GCS_SIGNING_FAILED";
  if (combined.includes("not found") || combined.includes("404")) return "GCS_RESOURCE_NOT_FOUND";
  if (combined.includes("credential") || combined.includes("auth")) return "GCS_AUTH_FAILED";
  return "GCS_SIGNED_URL_FAILED";
}

export function buildWeightProofObjectKey(input: BuildWeightProofObjectKeyInput) {
  const sellerOrMerchantId = safeSegment("MERCHANT_ID", input.sellerOrMerchantId);
  const awbNumber = safeSegment("AWB_NUMBER", input.awbNumber, MAX_AWB_LENGTH);
  const captureSessionId = safeSegment("CAPTURE_SESSION_ID", input.captureSessionId);
  const capturedAt = input.capturedAt ?? new Date();
  const year = String(capturedAt.getUTCFullYear());
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  const extension = extensionForContentType(input.contentType);

  return validateWeightProofObjectKey(`weight-proofs/${sellerOrMerchantId}/${year}/${month}/${awbNumber}/${captureSessionId}.${extension}`);
}

export function buildWeightGuardDiagnosticObjectKey(input: { diagnosticId: string; contentType?: string | undefined }) {
  const diagnosticId = safeSegment("DIAGNOSTIC_OBJECT_ID", input.diagnosticId);
  const extension = extensionForContentType(input.contentType);
  return validateWeightGuardDiagnosticObjectKey(`${WEIGHT_GUARD_DIAGNOSTIC_OBJECT_PREFIX}/${diagnosticId}.${extension}`);
}

export class InMemoryWeightProofStorageAdapter implements WeightProofStorageAdapter {
  private readonly objects = new Map<string, {
    contentLength: number;
    contentType: string;
    updatedAt: Date;
  }>();

  async createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    return {
      uploadUrl: `mock://weight-proof-put/${encodeURIComponent(objectKey)}`,
      method: "PUT",
      headers: {
        "content-type": input.contentType
      },
      expiresAt: input.expiresAt
    };
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const object = this.objects.get(objectKey);
    if (!object) return { exists: false };
    return {
      exists: true,
      contentLength: object.contentLength,
      contentType: object.contentType,
      updatedAt: object.updatedAt
    };
  }

  async putObject(input: PutObjectInput | {
    objectKey: string;
    contentLength?: number | undefined;
    contentType?: string | undefined;
    updatedAt?: Date | undefined;
  }): Promise<HeadObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    if (!("body" in input)) {
      this.objects.set(objectKey, {
        contentLength: input.contentLength ?? 1,
        contentType: input.contentType ?? "image/jpeg",
        updatedAt: input.updatedAt ?? new Date()
      });
      return this.headObject({ objectKey });
    }
    const contentType = normalizeWeightProofContentType(input.contentType);
    const body = normalizeBackendUploadBody(input.body);
    validateBackendUploadSizeForStorage(input.sizeBytes, Number.MAX_SAFE_INTEGER);
    this.objects.set(objectKey, {
      contentLength: body.byteLength,
      contentType,
      updatedAt: new Date()
    });
    return this.headObject({ objectKey });
  }

  async createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    return {
      downloadUrl: `mock://weight-proof-get/${encodeURIComponent(objectKey)}`,
      expiresAt: input.expiresAt
    };
  }

  async deleteObject(input: DeleteObjectInput): Promise<DeleteObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const deleted = this.objects.delete(objectKey);
    return {
      deleted,
      missing: !deleted
    };
  }

}

export class DisabledWeightProofStorageAdapter implements WeightProofStorageAdapter {
  async createPresignedPutUrl(): Promise<CreatePresignedPutUrlResult> {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  }

  async headObject(): Promise<HeadObjectResult> {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  }

  async putObject(): Promise<HeadObjectResult> {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  }

  async deleteObject(): Promise<DeleteObjectResult> {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  }

  async createPresignedGetUrl(): Promise<CreatePresignedGetUrlResult> {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  }
}

function objectNotFound(error: unknown) {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

function gcsObjectNotFound(error: unknown) {
  const candidate = error as { code?: number | string; name?: string; message?: string };
  return candidate.code === 404
    || candidate.code === "404"
    || candidate.name === "NotFound"
    || /not\s*found/i.test(candidate.message ?? "");
}

const GCS_METADATA_SERVICE_ACCOUNT_EMAIL_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const GCS_METADATA_ACCESS_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const GCS_SERVICE_ACCOUNT_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function validateGcsSigningServiceAccount(value: string) {
  const email = String(value ?? "").trim();
  if (!email || !GCS_SERVICE_ACCOUNT_EMAIL_SHAPE.test(email)) {
    throw Object.assign(new Error("WEIGHT_GUARD_GCS_SIGNER_MISCONFIGURED"), {
      code: "WEIGHT_GUARD_GCS_SIGNER_MISCONFIGURED"
    });
  }
  return email;
}

function normalizeAccessToken(value: string | { token?: string | null | undefined } | null | undefined) {
  const token = typeof value === "string" ? value : value?.token;
  const trimmed = String(token ?? "").trim();
  return trimmed || null;
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
    throw new Error("GCS_SIGN_BLOB_FETCH_UNAVAILABLE");
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
    throw Object.assign(new Error(`GCS_IAM_SIGN_BLOB_FAILED_${response.status}`), {
      code: response.status
    });
  }
  const data = await response.json() as { signedBlob?: string | undefined };
  return { signedBlob: data.signedBlob };
}

async function defaultGcsMediaUploadRequest(input: Parameters<GcsMediaUploadRequest>[0]) {
  if (typeof fetch !== "function") {
    throw new Error("GCS_MEDIA_UPLOAD_FETCH_UNAVAILABLE");
  }
  const uploadBody = input.body.buffer.slice(
    input.body.byteOffset,
    input.body.byteOffset + input.body.byteLength
  ) as ArrayBuffer;
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": input.contentType
    },
    body: uploadBody
  });
  const metadata = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    metadata
  };
}

async function defaultGcsMetadataRequest(input: Parameters<GcsMetadataRequest>[0]) {
  if (typeof fetch !== "function") {
    throw new Error("GCS_METADATA_FETCH_UNAVAILABLE");
  }
  const response = await fetch(input.url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`
    }
  });
  const metadata = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    metadata
  };
}

async function defaultGcsDeleteRequest(input: Parameters<GcsDeleteRequest>[0]) {
  if (typeof fetch !== "function") {
    throw new Error("GCS_DELETE_FETCH_UNAVAILABLE");
  }
  const response = await fetch(input.url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${input.accessToken}`
    }
  });
  return {
    ok: response.ok,
    status: response.status
  };
}

function headObjectFromGcsMetadata(metadata: Awaited<ReturnType<GcsMediaUploadRequest>>["metadata"], expectedObjectKey: string): HeadObjectResult | null {
  if (!metadata || (metadata.name && metadata.name !== expectedObjectKey)) return null;
  const updatedAt = metadata.updated ?? metadata.timeCreated;
  return {
    exists: true,
    contentLength: metadata.size === undefined ? null : Number(metadata.size),
    contentType: metadata.contentType ?? null,
    updatedAt: updatedAt ? new Date(updatedAt) : null
  };
}

type GcsSignedUrlResult = {
  signedUrl: string;
  requiredHeaders: Record<string, string>;
};

export class R2WeightProofStorageAdapter implements WeightProofStorageAdapter {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly presigner: R2Presigner;
  private readonly signedGetTtlMs: number;
  private readonly maxImageBytes: number;

  constructor(config: R2WeightProofStorageConfig) {
    this.bucket = config.bucket;
    this.client = config.client ?? new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
    this.presigner = config.presigner ?? ((client, command, options) => getSignedUrl(client, command, options));
    this.signedGetTtlMs = config.signedGetTtlMs;
    this.maxImageBytes = config.maxImageBytes;
  }

  async createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const contentType = normalizeWeightProofContentType(input.contentType);
    validateExpectedByteSizeForStorage(input.expectedByteSize, this.maxImageBytes);
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: contentType,
        ...(input.expectedByteSize ? { ContentLength: input.expectedByteSize } : {})
      });
      const uploadUrl = await this.presigner(this.client, command, { expiresIn: secondsUntil(input.expiresAt) });
      return {
        uploadUrl,
        method: "PUT",
        headers: {
          "content-type": contentType
        },
        expiresAt: input.expiresAt
      };
    } catch {
      throw new HttpError(503, "WEIGHT_GUARD_UPLOAD_URL_FAILED");
    }
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    try {
      const object = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: objectKey
      }));
      return {
        exists: true,
        contentLength: object.ContentLength ?? null,
        contentType: object.ContentType ?? null,
        updatedAt: object.LastModified ?? null
      };
    } catch (error) {
      if (objectNotFound(error)) return { exists: false };
      throw new HttpError(503, "WEIGHT_GUARD_OBJECT_HEAD_FAILED");
    }
  }

  async putObject(input: PutObjectInput): Promise<HeadObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const contentType = normalizeWeightProofContentType(input.contentType);
    const body = normalizeBackendUploadBody(input.body);
    validateBackendUploadSizeForStorage(input.sizeBytes, this.maxImageBytes);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        ContentLength: input.sizeBytes
      }));
    } catch {
      throw new HttpError(503, "BACKEND_UPLOAD_STORAGE_PUT_FAILED");
    }

    try {
      const object = await this.headObject({ objectKey });
      if (!object.exists) throw new HttpError(503, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
      return object;
    } catch {
      throw new HttpError(503, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
    }
  }

  async deleteObject(input: DeleteObjectInput): Promise<DeleteObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey
      }));
      return { deleted: true };
    } catch (error) {
      if (objectNotFound(error)) return { deleted: false, missing: true };
      throw new HttpError(503, "WEIGHT_GUARD_OBJECT_DELETE_FAILED");
    }
  }

  async createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + this.signedGetTtlMs);
    try {
      const downloadUrl = await this.presigner(this.client, new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey
      }), { expiresIn: secondsUntil(expiresAt) });
      return { downloadUrl, expiresAt };
    } catch {
      throw new HttpError(503, "WEIGHT_GUARD_UPLOAD_URL_FAILED");
    }
  }
}

export class GcsWeightProofStorageAdapter implements WeightProofStorageAdapter {
  private readonly bucket: GcsWeightProofBucket;
  private readonly bucketName: string;
  private readonly projectId: string;
  private readonly signingServiceAccount?: string | undefined;
  private readonly authClient?: GcsWeightProofAuthClient | undefined;
  private readonly accessTokenProvider?: GcsAccessTokenProvider | undefined;
  private readonly iamSignBlobRequest: GcsIamSignBlobRequest;
  private readonly metadataRequest: GcsMetadataRequest;
  private readonly mediaUploadRequest: GcsMediaUploadRequest;
  private readonly deleteRequest: GcsDeleteRequest;
  private readonly runtimeSigner?: GcsRuntimeSigner | undefined;
  private readonly serviceAccountEmailResolver: GcsServiceAccountEmailResolver;
  private readonly diagnostics: GcsWeightProofDiagnosticsReporter;
  private readonly signedGetTtlMs: number;
  private readonly maxImageBytes: number;

  constructor(config: GcsWeightProofStorageConfig) {
    const storage = config.storage ?? new Storage({
      projectId: config.projectId
    });
    this.bucket = config.bucketClient ?? storage.bucket(config.bucket) as unknown as GcsWeightProofBucket;
    this.bucketName = config.bucket;
    this.projectId = config.projectId;
    this.signingServiceAccount = String(config.signingServiceAccount ?? "").trim() || undefined;
    this.authClient = config.authClient ?? (storage as unknown as { authClient?: GcsWeightProofAuthClient }).authClient;
    this.accessTokenProvider = config.accessTokenProvider;
    this.iamSignBlobRequest = config.iamSignBlobRequest ?? defaultIamCredentialsSignBlobRequest;
    this.metadataRequest = config.metadataRequest ?? defaultGcsMetadataRequest;
    this.mediaUploadRequest = config.mediaUploadRequest ?? defaultGcsMediaUploadRequest;
    this.deleteRequest = config.deleteRequest ?? defaultGcsDeleteRequest;
    this.runtimeSigner = config.runtimeSigner;
    this.serviceAccountEmailResolver = config.serviceAccountEmailResolver ?? resolveCloudRunServiceAccountEmail;
    this.diagnostics = config.diagnostics ?? ((diagnostic) => {
      logger.warn({ weightGuardStorage: diagnostic }, "Weight Guard GCS signed URL generation failed");
    });
    this.signedGetTtlMs = config.signedGetTtlMs;
    this.maxImageBytes = config.maxImageBytes;
  }

  private logSignedUrlFailure(
    operation: GcsSignedUrlDiagnostic["operation"],
    error: unknown,
    contentTypeAccepted: boolean,
    configDiagnostics: Partial<Pick<
      GcsSignedUrlDiagnostic,
      "expiresFormat" | "ttlSeconds" | "contentTypePresent" | "officialConfigShapeValid" | "hasUnsupportedOfficialSignedUrlOptions"
    >> = {}
  ) {
    const candidate = error as { code?: string | number; message?: string; name?: string };
    const redactedValues = [this.bucketName, this.projectId, this.signingServiceAccount];
    this.diagnostics({
      provider: "gcs",
      operation,
      category: safeGcsErrorCategory(error),
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      errorName: candidate.name ? safeErrorField(candidate.name, 80, redactedValues) : null,
      errorCode: candidate.code ?? null,
      sanitizedMessage: safeErrorField(candidate.message ?? error, 180, redactedValues),
      bucketConfigured: Boolean(this.bucketName),
      projectConfigured: Boolean(this.projectId),
      signingServiceAccountConfigured: Boolean(this.signingServiceAccount),
      contentTypeAccepted,
      runtimeSignerConfigured: Boolean(this.runtimeSigner),
      ...configDiagnostics
    });
  }

  private async resolveSigningServiceAccount() {
    if (this.signingServiceAccount) return validateGcsSigningServiceAccount(this.signingServiceAccount);
    const credentials = await this.authClient?.getCredentials?.();
    const email = String(credentials?.client_email ?? "").trim();
    if (email) return validateGcsSigningServiceAccount(email);
    const runtimeEmail = String(await this.serviceAccountEmailResolver().catch(() => null) ?? "").trim();
    if (runtimeEmail) return validateGcsSigningServiceAccount(runtimeEmail);
    throw new Error("GCS_SIGNING_SERVICE_ACCOUNT_UNAVAILABLE");
  }

  private async resolveRuntimeAccessToken() {
    const fromInjectedProvider = normalizeAccessToken(await this.accessTokenProvider?.().catch(() => null));
    if (fromInjectedProvider) return fromInjectedProvider;

    const fromAuthClient = normalizeAccessToken(await this.authClient?.getAccessToken?.().catch(() => null));
    if (fromAuthClient) return fromAuthClient;

    const fromMetadata = await fetchGcsMetadataAccessToken();
    if (fromMetadata) return fromMetadata;

    throw new Error("GCS_RUNTIME_ACCESS_TOKEN_UNAVAILABLE");
  }

  private async signRuntimeBlob(stringToSign: string, serviceAccountEmail: string) {
    if (this.runtimeSigner) {
      const signedBlob = await this.runtimeSigner({ serviceAccountEmail, stringToSign });
      if (!signedBlob) throw new Error("GCS_SIGNING_EMPTY_SIGNATURE");
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
    if (!signedBlob) throw new Error("GCS_SIGNING_EMPTY_SIGNATURE");
    return signedBlob;
  }

  private async createRuntimeSignedUrl(input: {
    objectKey: string;
    action: GcsSignedUrlAction;
    expiresAt: Date;
    contentType?: string | undefined;
  }): Promise<GcsSignedUrlResult> {
    if (input.action === "write") {
      throw new Error("GCS_RUNTIME_SIGNED_PUT_DISABLED");
    }
    const requestDate = new Date();
    const dateTime = gcsTimestamp(requestDate);
    const dateStamp = gcsDateStamp(requestDate);
    const method = "GET";
    const host = ["storage", "googleapis", "com"].join(".");
    const canonicalUri = buildGcsXmlPathStyleCanonicalUri(this.bucketName, input.objectKey);
    const headers: Record<string, string> = { host };
    const requiredHeaders: Record<string, string> = {};
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]!.trim()}\n`).join("");
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
      signedUrl: `https://${host}${canonicalUri}?${canonicalQuery}&X-Goog-Signature=${signatureHex}`,
      requiredHeaders
    };
  }

  private async createOfficialGcsSignedUrl(input: {
    objectKey: string;
    action: GcsSignedUrlAction;
    expiresAt: Date;
    contentType?: string | undefined;
  }): Promise<GcsSignedUrlResult> {
    if (input.action === "write") {
      const officialWriteConfig = buildOfficialGcsWriteSignedUrlConfig({
        expiresAt: input.expiresAt,
        contentType: input.contentType
      });
      const [signedUrl] = await this.bucket.file(input.objectKey).getSignedUrl(officialWriteConfig.config);
      return {
        signedUrl,
        requiredHeaders: {
          "content-type": officialWriteConfig.config.contentType
        }
      };
    }

    const [signedUrl] = await this.bucket.file(input.objectKey).getSignedUrl({
      version: "v4",
      action: input.action,
      expires: input.expiresAt,
      ...(input.contentType ? { contentType: input.contentType } : {})
    });
    return {
      signedUrl,
      requiredHeaders: {}
    };
  }

  private async createGcsSignedUrl(input: {
    objectKey: string;
    action: GcsSignedUrlAction;
    expiresAt: Date;
    contentType?: string | undefined;
  }): Promise<GcsSignedUrlResult> {
    if (input.action === "write") {
      const configDiagnostics = buildOfficialGcsWriteSignedUrlConfig({
        expiresAt: input.expiresAt,
        contentType: input.contentType
      }).diagnostics;
      try {
        return await this.createOfficialGcsSignedUrl(input);
      } catch (error) {
        this.logSignedUrlFailure("signed_put", error, Boolean(input.contentType), configDiagnostics);
        throw new HttpError(503, "WEIGHT_GUARD_GCS_SIGNED_URL_FAILED");
      }
    }

    try {
      return await this.createOfficialGcsSignedUrl(input);
    } catch {
      try {
        return await this.createRuntimeSignedUrl(input);
      } catch (runtimeError) {
        this.logSignedUrlFailure("signed_get", runtimeError, Boolean(input.contentType));
        throw new HttpError(503, "WEIGHT_GUARD_GCS_SIGNED_URL_FAILED");
      }
    }
  }

  private buildAuthenticatedMediaUploadUrl(objectKey: string) {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucketName)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", objectKey);
    return url.toString();
  }

  private buildAuthenticatedMetadataUrl(objectKey: string) {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucketName)}/o/${encodeURIComponent(objectKey)}`);
    url.searchParams.set("fields", "name,size,contentType,updated,timeCreated");
    return url.toString();
  }

  private buildAuthenticatedDeleteUrl(objectKey: string) {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucketName)}/o/${encodeURIComponent(objectKey)}`;
  }

  async createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const contentType = normalizeWeightProofContentType(input.contentType);
    validateExpectedByteSizeForStorage(input.expectedByteSize, this.maxImageBytes);
    const signed = await this.createGcsSignedUrl({
      objectKey,
      action: "write",
      expiresAt: input.expiresAt,
      contentType
    });
    return {
      uploadUrl: signed.signedUrl,
      method: "PUT",
      headers: signed.requiredHeaders,
      expiresAt: input.expiresAt
    };
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    try {
      const accessToken = await this.resolveRuntimeAccessToken();
      const result = await this.metadataRequest({
        url: this.buildAuthenticatedMetadataUrl(objectKey),
        accessToken,
        objectKey
      });
      if (result.status === 404) return { exists: false };
      if (!result.ok) {
        throw Object.assign(new Error(`GCS_METADATA_STATUS_${result.status}`), {
          code: result.status
        });
      }
      const object = headObjectFromGcsMetadata(result.metadata, objectKey);
      return object?.exists ? object : { exists: false };
    } catch (error) {
      if (gcsObjectNotFound(error)) return { exists: false };
      throw new HttpError(503, "WEIGHT_GUARD_OBJECT_HEAD_FAILED");
    }
  }

  async putObject(input: PutObjectInput): Promise<HeadObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const contentType = normalizeWeightProofContentType(input.contentType);
    const body = normalizeBackendUploadBody(input.body);
    validateBackendUploadSizeForStorage(input.sizeBytes, this.maxImageBytes);
    let uploadedObject: HeadObjectResult | null = null;
    try {
      const accessToken = await this.resolveRuntimeAccessToken();
      const result = await this.mediaUploadRequest({
        url: this.buildAuthenticatedMediaUploadUrl(objectKey),
        accessToken,
        body,
        contentType,
        sizeBytes: input.sizeBytes
      });
      if (!result.ok) throw new Error(`GCS_MEDIA_UPLOAD_STATUS_${result.status}`);
      uploadedObject = headObjectFromGcsMetadata(result.metadata, objectKey);
    } catch {
      throw new HttpError(503, "BACKEND_UPLOAD_STORAGE_PUT_FAILED");
    }

    if (uploadedObject?.exists) return uploadedObject;

    try {
      const object = await this.headObject({ objectKey });
      if (!object.exists) throw new HttpError(503, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
      return object;
    } catch {
      throw new HttpError(503, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
    }
  }

  async deleteObject(input: DeleteObjectInput): Promise<DeleteObjectResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    try {
      const accessToken = await this.resolveRuntimeAccessToken();
      const result = await this.deleteRequest({
        url: this.buildAuthenticatedDeleteUrl(objectKey),
        accessToken,
        objectKey
      });
      if (result.status === 404) return { deleted: false, missing: true };
      if (!result.ok) throw Object.assign(new Error(`GCS_DELETE_STATUS_${result.status}`), { code: result.status });
      return { deleted: true };
    } catch (error) {
      if (gcsObjectNotFound(error)) return { deleted: false, missing: true };
      throw new HttpError(503, "WEIGHT_GUARD_OBJECT_DELETE_FAILED");
    }
  }

  async listObjectKeyDiagnosticsByPrefix(input: { prefix: string; maxResults?: number | undefined }) {
    const prefix = validateWeightGuardDiagnosticObjectPrefix(input.prefix);
    if (!this.bucket.getFiles) return [];
    try {
      const [files] = await this.bucket.getFiles({
        prefix,
        autoPaginate: false,
        maxResults: Math.min(Math.max(input.maxResults ?? 20, 1), 100)
      });
      return files.flatMap((file) => {
        const objectKey = String(file.name ?? "").trim();
        if (!objectKey.startsWith(prefix)) return [];
        try {
          return [getWeightProofObjectKeyDiagnostics(validateWeightGuardDiagnosticObjectKey(objectKey))];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  async createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult> {
    const objectKey = validateWeightProofStorageObjectKey(input.objectKey);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + this.signedGetTtlMs);
    const signed = await this.createGcsSignedUrl({
      objectKey,
      action: "read",
      expiresAt
    });
    return { downloadUrl: signed.signedUrl, expiresAt };
  }
}

const routeMockStorage = new InMemoryWeightProofStorageAdapter();

function bool(value: string | boolean | undefined, defaultValue: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return defaultValue;
}

function numberInRange(value: string | number | undefined, defaultValue: number, min: number, max: number) {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function provider(value: string | undefined): WeightProofStorageProvider {
  const normalized = String(value ?? "disabled").trim().toLowerCase();
  if (normalized === "mock" || normalized === "r2" || normalized === "gcs" || normalized === "disabled") return normalized;
  return "disabled";
}

function stringValue(value: string | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

export function resolveR2WeightProofStorageConfig(source: WeightProofStorageEnvSource = process.env): R2WeightProofStorageConfig {
  const accountId = stringValue(source.WEIGHT_GUARD_R2_ACCOUNT_ID);
  const endpoint = stringValue(source.WEIGHT_GUARD_R2_ENDPOINT)
    ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const publicR2DeveloperHost = ["r2", "dev"].join(".");
  const safeEndpoint = endpoint?.replace(/\/+$/, "");
  const bucket = stringValue(source.WEIGHT_GUARD_R2_BUCKET);
  const accessKeyId = stringValue(source.WEIGHT_GUARD_R2_ACCESS_KEY_ID);
  const secretAccessKey = stringValue(source.WEIGHT_GUARD_R2_SECRET_ACCESS_KEY);
  if (!safeEndpoint || safeEndpoint.toLowerCase().includes(publicR2DeveloperHost) || !bucket || !accessKeyId || !secretAccessKey) {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_MISCONFIGURED");
  }
  return {
    bucket,
    endpoint: safeEndpoint,
    region: stringValue(source.WEIGHT_GUARD_R2_REGION) ?? "auto",
    accessKeyId,
    secretAccessKey,
    signedGetTtlMs: numberInRange(source.WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS, 300, 30, 3600) * 1000,
    maxImageBytes: numberInRange(source.WEIGHT_GUARD_MAX_IMAGE_BYTES, DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES, 1, 50 * 1024 * 1024)
  };
}

export function resolveGcsWeightProofStorageConfig(source: WeightProofStorageEnvSource = process.env): GcsWeightProofStorageConfig {
  const bucket = stringValue(source.WEIGHT_GUARD_GCS_BUCKET);
  if (!bucket) throw new HttpError(503, "WEIGHT_GUARD_GCS_MISCONFIGURED");
  return {
    bucket,
    projectId: stringValue(source.WEIGHT_GUARD_GCS_PROJECT_ID) ?? "shipmastr-core-prod",
    signingServiceAccount: stringValue(source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT),
    signedGetTtlMs: numberInRange(source.WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS, 300, 30, 3600) * 1000,
    maxImageBytes: numberInRange(source.WEIGHT_GUARD_MAX_IMAGE_BYTES, DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES, 1, 50 * 1024 * 1024)
  };
}

export function getRouteMockWeightProofStorageAdapter() {
  return routeMockStorage;
}

export function createWeightProofStorageRuntime(source: WeightProofStorageEnvSource = process.env): WeightProofStorageRuntime {
  const enabled = bool(source.WEIGHT_GUARD_PROOF_STORAGE_ENABLED, false);
  const selectedProvider = enabled ? provider(source.WEIGHT_GUARD_STORAGE_PROVIDER) : "disabled";
  const uploadTtlMs = numberInRange(source.WEIGHT_GUARD_UPLOAD_TTL_SECONDS, 600, 60, 3600) * 1000;
  const signedGetTtlMs = numberInRange(source.WEIGHT_GUARD_SIGNED_GET_TTL_SECONDS, 300, 30, 3600) * 1000;
  const maxImageBytes = numberInRange(source.WEIGHT_GUARD_MAX_IMAGE_BYTES, DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES, 1, 50 * 1024 * 1024);
  const storage = selectedProvider === "mock"
    ? routeMockStorage
    : selectedProvider === "r2"
      ? new R2WeightProofStorageAdapter(resolveR2WeightProofStorageConfig(source))
      : selectedProvider === "gcs"
        ? new GcsWeightProofStorageAdapter(resolveGcsWeightProofStorageConfig(source))
        : new DisabledWeightProofStorageAdapter();

  return {
    enabled: enabled && selectedProvider !== "disabled",
    provider: selectedProvider,
    storage,
    uploadTtlMs,
    signedGetTtlMs,
    maxImageBytes
  };
}

export function assertWeightProofStorageEnabled(runtime: WeightProofStorageRuntime) {
  if (!runtime.enabled) throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  return runtime;
}
