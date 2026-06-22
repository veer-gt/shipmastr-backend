import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { HttpError } from "../../lib/httpError.js";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_AWB_LENGTH = 64;
const MAX_SEGMENT_LENGTH = 160;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

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

export type BuildWeightProofObjectKeyInput = {
  sellerOrMerchantId: string;
  awbNumber: string;
  captureSessionId: string;
  capturedAt?: Date | undefined;
  contentType?: string | undefined;
};

export interface WeightProofStorageAdapter {
  createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult>;
  headObject(input: HeadObjectInput): Promise<HeadObjectResult>;
  createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult>;
}

export type WeightProofStorageProvider = "disabled" | "mock" | "r2";

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

function secondsUntil(expiresAt: Date) {
  const seconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
  return Math.max(1, seconds);
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

export class InMemoryWeightProofStorageAdapter implements WeightProofStorageAdapter {
  private readonly objects = new Map<string, {
    contentLength: number;
    contentType: string;
    updatedAt: Date;
  }>();

  async createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult> {
    const objectKey = validateWeightProofObjectKey(input.objectKey);
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
    const objectKey = validateWeightProofObjectKey(input.objectKey);
    const object = this.objects.get(objectKey);
    if (!object) return { exists: false };
    return {
      exists: true,
      contentLength: object.contentLength,
      contentType: object.contentType,
      updatedAt: object.updatedAt
    };
  }

  async createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult> {
    const objectKey = validateWeightProofObjectKey(input.objectKey);
    return {
      downloadUrl: `mock://weight-proof-get/${encodeURIComponent(objectKey)}`,
      expiresAt: input.expiresAt
    };
  }

  putObject(input: {
    objectKey: string;
    contentLength?: number | undefined;
    contentType?: string | undefined;
    updatedAt?: Date | undefined;
  }) {
    const objectKey = validateWeightProofObjectKey(input.objectKey);
    this.objects.set(objectKey, {
      contentLength: input.contentLength ?? 1,
      contentType: input.contentType ?? "image/jpeg",
      updatedAt: input.updatedAt ?? new Date()
    });
  }
}

export class DisabledWeightProofStorageAdapter implements WeightProofStorageAdapter {
  async createPresignedPutUrl(): Promise<CreatePresignedPutUrlResult> {
    throw new HttpError(503, "WEIGHT_GUARD_STORAGE_DISABLED");
  }

  async headObject(): Promise<HeadObjectResult> {
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
    const objectKey = validateWeightProofObjectKey(input.objectKey);
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
    const objectKey = validateWeightProofObjectKey(input.objectKey);
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

  async createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult> {
    const objectKey = validateWeightProofObjectKey(input.objectKey);
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
  if (normalized === "mock" || normalized === "r2" || normalized === "disabled") return normalized;
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
    maxImageBytes: numberInRange(source.WEIGHT_GUARD_MAX_IMAGE_BYTES, 10 * 1024 * 1024, 1, 50 * 1024 * 1024)
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
  const maxImageBytes = numberInRange(source.WEIGHT_GUARD_MAX_IMAGE_BYTES, 10 * 1024 * 1024, 1, 50 * 1024 * 1024);
  const storage = selectedProvider === "mock"
    ? routeMockStorage
    : selectedProvider === "r2"
      ? new R2WeightProofStorageAdapter(resolveR2WeightProofStorageConfig(source))
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
