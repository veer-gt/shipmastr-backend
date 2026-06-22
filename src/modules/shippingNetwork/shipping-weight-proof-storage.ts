import { HttpError } from "../../lib/httpError.js";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_AWB_LENGTH = 64;
const MAX_SEGMENT_LENGTH = 160;

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
};

export interface WeightProofStorageAdapter {
  createPresignedPutUrl(input: CreatePresignedPutUrlInput): Promise<CreatePresignedPutUrlResult>;
  headObject(input: HeadObjectInput): Promise<HeadObjectResult>;
  createPresignedGetUrl(input: CreatePresignedGetUrlInput): Promise<CreatePresignedGetUrlResult>;
}

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
  if (!fileName.endsWith(".jpg")) {
    throw new HttpError(400, "WEIGHT_PROOF_OBJECT_KEY_INVALID");
  }
  safeSegment("CAPTURE_SESSION_ID", fileName.slice(0, -4));
  return trimmed;
}

export function buildWeightProofObjectKey(input: BuildWeightProofObjectKeyInput) {
  const sellerOrMerchantId = safeSegment("MERCHANT_ID", input.sellerOrMerchantId);
  const awbNumber = safeSegment("AWB_NUMBER", input.awbNumber, MAX_AWB_LENGTH);
  const captureSessionId = safeSegment("CAPTURE_SESSION_ID", input.captureSessionId);
  const capturedAt = input.capturedAt ?? new Date();
  const year = String(capturedAt.getUTCFullYear());
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");

  return validateWeightProofObjectKey(`weight-proofs/${sellerOrMerchantId}/${year}/${month}/${awbNumber}/${captureSessionId}.jpg`);
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
