import { createHash, randomUUID } from "node:crypto";
import { WeightProofCaptureStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildWeightProofObjectKey,
  DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES,
  getWeightProofObjectKeyDiagnostics,
  normalizeWeightProofContentType,
  type WeightProofStorageAdapter
} from "./shipping-weight-proof-storage.js";
import {
  serializeWeightProofCaptureSession,
  serializeWeightProofSellerSafe
} from "./shipping-weight-proof.serializer.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ProofDimensionsInput = {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export type InitWeightProofCaptureInput = {
  awbNumber: string;
  shipmentId?: string | undefined;
  contentType?: string | undefined;
  expectedByteSize?: number | undefined;
  deviceId?: string | undefined;
};

export type FinalizeWeightProofCaptureInput = {
  captureSessionId: string;
  awbNumber?: string | undefined;
  declaredWeightGrams: number;
  dimensions: ProofDimensionsInput;
  deviceId?: string | undefined;
  capturedAt?: Date | undefined;
};

export type UploadWeightProofImageInput = {
  captureSessionId: string;
  awbNumber?: string | undefined;
  file: {
    buffer: Buffer;
    contentType?: string | undefined;
    sizeBytes: number;
  };
};

export type WeightProofQualityStatus = "PASS" | "WARN" | "FAIL";
export type WeightProofQualityReasonCode =
  | "IMAGE_TOO_LARGE"
  | "IMAGE_UNSUPPORTED_TYPE"
  | "IMAGE_TOO_BLURRY"
  | "IMAGE_TOO_DARK"
  | "IMAGE_LOW_CONTRAST"
  | "IMAGE_TOO_SMALL"
  | "SCALE_OR_LABEL_NOT_CLEAR_ENOUGH"
  | "QUALITY_CHECK_UNAVAILABLE";

export type WeightProofImageQualityResult = {
  status: WeightProofQualityStatus;
  reasonCodes: WeightProofQualityReasonCode[];
  width?: number | null | undefined;
  height?: number | null | undefined;
};

export type DeleteWeightProofImageAfterAwbPaidInput = {
  awbNumber: string;
  paidEntityType: "SELLER" | "MERCHANT" | string;
  settlementRef?: string | null | undefined;
};

export type WeightProofUploadMode = "DIRECT_SIGNED_URL" | "BACKEND_MEDIATED";

export type WeightProofServiceContext = {
  merchantId: string;
  storage: WeightProofStorageAdapter;
  client?: Db | undefined;
  now?: (() => Date) | undefined;
  uploadTtlMs?: number | undefined;
  maxImageBytes?: number | undefined;
  uploadMode?: WeightProofUploadMode | undefined;
  idFactory?: (() => string) | undefined;
  headObjectRetryDelaysMs?: number[] | undefined;
};

const SAFE_AWB = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HEAD_OBJECT_RETRY_DELAYS_MS = [150, 350];
const MIN_QUALITY_WIDTH = 640;
const MIN_QUALITY_HEIGHT = 480;
const OPEN_WEIGHT_DISPUTE_STATUSES = ["detected", "evidence_needed", "dispute_ready", "submitted"];
const RETENTION_STATUS_ACTIVE = "ACTIVE";
const RETENTION_STATUS_DELETED_AFTER_PAYOUT = "DELETED_AFTER_PAYOUT";
const RETENTION_DELETION_REASON_FINANCIALLY_CLOSED = "AWB_FINANCIALLY_CLOSED";

function db(context: WeightProofServiceContext): Db {
  return context.client ?? prisma;
}

function now(context: WeightProofServiceContext) {
  return context.now?.() ?? new Date();
}

function id(context: WeightProofServiceContext) {
  return context.idFactory?.() ?? randomUUID();
}

function requireMerchantId(value: string) {
  const merchantId = String(value ?? "").trim();
  if (!merchantId) throw new HttpError(401, "MERCHANT_CONTEXT_REQUIRED");
  return merchantId;
}

function nullable(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function validateContentType(value: string | null | undefined) {
  const contentType = String(value ?? "image/jpeg").trim().toLowerCase();
  if (contentType !== "image/jpeg" && contentType !== "image/png") throw new HttpError(400, "WEIGHT_PROOF_CONTENT_TYPE_INVALID");
  return contentType;
}

function validateUploadImageContentType(value: string | null | undefined) {
  try {
    return normalizeWeightProofContentType(value ?? undefined);
  } catch {
    throw new HttpError(400, "WEIGHT_GUARD_UNSUPPORTED_IMAGE_TYPE");
  }
}

function validateExpectedByteSize(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, "WEIGHT_PROOF_EXPECTED_SIZE_INVALID");
  return value;
}

function validateUploadImageSize(value: number, context: WeightProofServiceContext) {
  const sizeBytes = Number(value);
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new HttpError(400, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  const maxImageBytes = context.maxImageBytes ?? DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES;
  if (sizeBytes > maxImageBytes) throw new HttpError(413, "WEIGHT_GUARD_UPLOAD_TOO_LARGE");
  return sizeBytes;
}

function sha256Hex(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readPngDimensions(buffer: Buffer) {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegDimensions(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    const isStartOfFrame = (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    );
    if (isStartOfFrame && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

export function analyzeWeightProofImageQuality(input: {
  buffer: Buffer;
  contentType: string;
  sizeBytes: number;
  maxImageBytes?: number | undefined;
}): WeightProofImageQualityResult {
  const maxImageBytes = input.maxImageBytes ?? DEFAULT_WEIGHT_GUARD_MAX_IMAGE_BYTES;
  if (input.sizeBytes > maxImageBytes) {
    return { status: "FAIL", reasonCodes: ["IMAGE_TOO_LARGE"] };
  }
  const contentType = validateUploadImageContentType(input.contentType);
  const dimensions = contentType === "image/png"
    ? readPngDimensions(input.buffer)
    : readJpegDimensions(input.buffer);
  if (!dimensions) {
    return { status: "FAIL", reasonCodes: ["SCALE_OR_LABEL_NOT_CLEAR_ENOUGH"] };
  }
  if (dimensions.width < MIN_QUALITY_WIDTH || dimensions.height < MIN_QUALITY_HEIGHT) {
    return {
      status: "FAIL",
      reasonCodes: ["IMAGE_TOO_SMALL", "SCALE_OR_LABEL_NOT_CLEAR_ENOUGH"],
      width: dimensions.width,
      height: dimensions.height
    };
  }
  return {
    status: "PASS",
    reasonCodes: [],
    width: dimensions.width,
    height: dimensions.height
  };
}

function assertWeightProofImageQuality(result: WeightProofImageQualityResult) {
  if (result.status === "FAIL") {
    const primary = result.reasonCodes[0] ?? "SCALE_OR_LABEL_NOT_CLEAR_ENOUGH";
    throw new HttpError(400, primary);
  }
}

export function validateWeightProofAwbNumber(awbNumber: string) {
  const value = String(awbNumber ?? "").trim();
  if (!SAFE_AWB.test(value) || value.includes("..") || value.includes("/") || value.includes("\\") || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, "WEIGHT_PROOF_AWB_INVALID");
  }
  return value;
}

function validateDeclaredWeightGrams(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, "WEIGHT_PROOF_DECLARED_WEIGHT_INVALID");
  }
  return value;
}

function normalizeDimension(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new HttpError(400, "WEIGHT_PROOF_DIMENSIONS_INVALID");
  }
  return Math.round(value * 100) / 100;
}

export function normalizeProofDimensions(input: ProofDimensionsInput) {
  return {
    lengthCm: normalizeDimension(input.lengthCm),
    widthCm: normalizeDimension(input.widthCm),
    heightCm: normalizeDimension(input.heightCm)
  };
}

export function calculateVolumetricWeightGrams(lengthCm: number, widthCm: number, heightCm: number) {
  const dimensions = normalizeProofDimensions({ lengthCm, widthCm, heightCm });
  return Math.round(((dimensions.lengthCm * dimensions.widthCm * dimensions.heightCm) / 5000) * 1000);
}

export function calculateChargeableWeightGrams(declaredWeightGrams: number, volumetricWeightGrams: number) {
  const declared = validateDeclaredWeightGrams(declaredWeightGrams);
  if (!Number.isInteger(volumetricWeightGrams) || volumetricWeightGrams < 0) {
    throw new HttpError(400, "WEIGHT_PROOF_VOLUMETRIC_WEIGHT_INVALID");
  }
  return Math.max(declared, volumetricWeightGrams);
}

async function shipmentForAwb(client: Db, merchantId: string, awbNumber: string) {
  return client.shipment.findFirst({
    where: {
      sellerId: merchantId,
      awbNumber
    }
  });
}

async function shipmentForId(client: Db, merchantId: string, shipmentId: string) {
  return client.shipment.findFirst({
    where: {
      id: shipmentId,
      sellerId: merchantId
    }
  });
}

async function resolveShipment(client: Db, merchantId: string, shipmentId: string | undefined, awbNumber: string) {
  const normalizedShipmentId = nullable(shipmentId);
  const shipmentById = normalizedShipmentId
    ? await shipmentForId(client, merchantId, normalizedShipmentId)
    : null;

  if (shipmentById?.awbNumber === awbNumber) {
    return shipmentById;
  }

  const shipmentByAwb = await shipmentForAwb(client, merchantId, awbNumber);
  if (shipmentByAwb) {
    if (shipmentById && shipmentById.id !== shipmentByAwb.id) {
      throw new HttpError(409, "WEIGHT_PROOF_AWB_SHIPMENT_MISMATCH");
    }
    return shipmentByAwb;
  }

  if (shipmentById) {
    throw new HttpError(409, "WEIGHT_PROOF_AWB_SHIPMENT_MISMATCH");
  }
  if (normalizedShipmentId) {
    throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  }

  return null;
}

async function runInTransaction<T>(client: Db, operation: (tx: Db) => Promise<T>) {
  const txClient = client as typeof prisma;
  if (typeof txClient.$transaction === "function") {
    return txClient.$transaction((tx) => operation(tx));
  }
  return operation(client);
}

function wait(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isObjectMissingError(error: unknown) {
  return error instanceof HttpError && (
    error.message === "WEIGHT_GUARD_OBJECT_NOT_FOUND"
    || error.message === "WEIGHT_GUARD_GCS_OBJECT_NOT_FOUND"
    || error.status === 404
  );
}

function logUploadVerificationFailure(category: string, status: number, objectKey: string) {
  logger.warn({
    weightGuardFinalize: {
      category,
      status,
      ...getWeightProofObjectKeyDiagnostics(objectKey)
    }
  }, "Weight Guard upload verification failed");
}

function uploadVerificationErrorDetails(category: string, objectKey: string) {
  return {
    category,
    ...getWeightProofObjectKeyDiagnostics(objectKey)
  };
}

function isBackendUploadFailureCategory(value: string): value is "BACKEND_UPLOAD_STORAGE_PUT_FAILED" | "BACKEND_UPLOAD_METADATA_VERIFY_FAILED" {
  return value === "BACKEND_UPLOAD_STORAGE_PUT_FAILED"
    || value === "BACKEND_UPLOAD_METADATA_VERIFY_FAILED";
}

function throwBackendUploadFailure(category: "BACKEND_UPLOAD_STORAGE_PUT_FAILED" | "BACKEND_UPLOAD_METADATA_VERIFY_FAILED", objectKey: string): never {
  logUploadVerificationFailure(category, 503, objectKey);
  throw new HttpError(503, category, uploadVerificationErrorDetails(category, objectKey));
}

async function verifyUploadedObject(context: WeightProofServiceContext, objectKey: string) {
  const retryDelays = context.headObjectRetryDelaysMs ?? DEFAULT_HEAD_OBJECT_RETRY_DELAYS_MS;
  const attempts = retryDelays.length + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const object = await context.storage.headObject({ objectKey });
      if (object.exists) return object;
    } catch (error) {
      if (!isObjectMissingError(error)) {
        logUploadVerificationFailure("WEIGHT_GUARD_UPLOAD_NOT_VERIFIED", 503, objectKey);
        throw new HttpError(503, "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED", uploadVerificationErrorDetails(
          "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED",
          objectKey
        ));
      }
    }

    const delayMs = retryDelays[attempt];
    if (delayMs !== undefined) await wait(delayMs);
  }

  logUploadVerificationFailure("WEIGHT_GUARD_UPLOAD_NOT_VERIFIED", 503, objectKey);
  throw new HttpError(503, "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED", uploadVerificationErrorDetails(
    "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED",
    objectKey
  ));
}

async function createUploadInstruction(input: {
  context: WeightProofServiceContext;
  objectKey: string;
  contentType: string;
  expectedByteSize: number | null;
  expiresAt: Date;
}) {
  if (input.context.uploadMode === "BACKEND_MEDIATED") {
    return {
      uploadMode: "BACKEND_MEDIATED" as const,
      uploadEndpoint: "/api/v1/shipping/weight-proofs/upload",
      method: "POST" as const,
      headers: {},
      expiresAt: input.expiresAt
    };
  }

  const direct = await input.context.storage.createPresignedPutUrl({
    objectKey: input.objectKey,
    contentType: input.contentType,
    expectedByteSize: input.expectedByteSize,
    expiresAt: input.expiresAt
  });
  return {
    uploadMode: "DIRECT_SIGNED_URL" as const,
    ...direct
  };
}

export async function initWeightProofCapture(input: InitWeightProofCaptureInput, context: WeightProofServiceContext) {
  const client = db(context);
  const merchantId = requireMerchantId(context.merchantId);
  const awbNumber = validateWeightProofAwbNumber(input.awbNumber);
  const contentType = validateContentType(input.contentType);
  const expectedByteSize = validateExpectedByteSize(input.expectedByteSize);
  const createdAt = now(context);
  const expiresAt = new Date(createdAt.getTime() + (context.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS));
  const existingProof = await client.shippingWeightProof.findFirst({
    where: {
      merchantId,
      awbNumber
    }
  });
  if (existingProof) {
    return {
      created: false,
      already_finalized: true,
      proof: serializeWeightProofSellerSafe(existingProof),
      capture: null,
      upload: null
    };
  }

  const existingSession = await client.shippingWeightProofCaptureSession.findFirst({
    where: {
      merchantId,
      awbNumber,
      status: WeightProofCaptureStatus.CREATED,
      expiresAt: { gt: createdAt }
    },
    orderBy: { createdAt: "desc" }
  });
  if (existingSession) {
    const upload = await createUploadInstruction({
      context,
      objectKey: existingSession.imageObjectKey,
      contentType: existingSession.contentType,
      expectedByteSize: existingSession.expectedByteSize,
      expiresAt
    });
    return {
      created: false,
      already_finalized: false,
      proof: null,
      capture: serializeWeightProofCaptureSession(existingSession),
      upload
    };
  }

  const shipment = await resolveShipment(client, merchantId, input.shipmentId, awbNumber);
  const captureSessionId = id(context);
  const imageObjectKey = buildWeightProofObjectKey({
    sellerOrMerchantId: merchantId,
    awbNumber,
    captureSessionId,
    capturedAt: createdAt,
    contentType
  });
  const session = await client.shippingWeightProofCaptureSession.create({
    data: {
      id: captureSessionId,
      merchantId,
      shipmentId: shipment?.id ?? input.shipmentId ?? null,
      awbNumber,
      imageObjectKey,
      contentType,
      expectedByteSize,
      deviceId: nullable(input.deviceId),
      status: WeightProofCaptureStatus.CREATED,
      expiresAt
    }
  });
  const upload = await createUploadInstruction({
    context,
    objectKey: session.imageObjectKey,
    contentType: session.contentType,
    expectedByteSize: session.expectedByteSize,
    expiresAt
  });

  return {
    created: true,
    already_finalized: false,
    proof: null,
    capture: serializeWeightProofCaptureSession(session),
    upload
  };
}

export async function uploadWeightProofImage(input: UploadWeightProofImageInput, context: WeightProofServiceContext) {
  const client = db(context);
  const merchantId = requireMerchantId(context.merchantId);
  const captureSessionId = String(input.captureSessionId ?? "").trim();
  if (!captureSessionId) throw new HttpError(400, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  const session = await client.shippingWeightProofCaptureSession.findFirst({
    where: {
      id: captureSessionId
    }
  });
  if (!session) throw new HttpError(404, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  if (session.merchantId !== merchantId) throw new HttpError(403, "WEIGHT_GUARD_UPLOAD_FORBIDDEN");
  const awbNumber = validateWeightProofAwbNumber(input.awbNumber ?? session.awbNumber);
  if (session.awbNumber !== awbNumber) throw new HttpError(409, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  if (session.status !== WeightProofCaptureStatus.CREATED) throw new HttpError(409, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  if (session.expiresAt.getTime() <= now(context).getTime()) {
    await client.shippingWeightProofCaptureSession.update({
      where: { id: session.id },
      data: { status: WeightProofCaptureStatus.EXPIRED }
    });
    throw new HttpError(409, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  }
  if (!input.file?.buffer) throw new HttpError(400, "WEIGHT_GUARD_UPLOAD_SESSION_INVALID");
  const contentType = validateUploadImageContentType(input.file.contentType ?? session.contentType);
  if (session.contentType !== contentType) throw new HttpError(400, "WEIGHT_GUARD_UNSUPPORTED_IMAGE_TYPE");
  const sizeBytes = validateUploadImageSize(input.file.sizeBytes, context);
  const body = Buffer.isBuffer(input.file.buffer) ? input.file.buffer : Buffer.from(input.file.buffer);
  const quality = analyzeWeightProofImageQuality({
    buffer: body,
    contentType,
    sizeBytes,
    maxImageBytes: context.maxImageBytes
  });
  assertWeightProofImageQuality(quality);
  const imageChecksum = sha256Hex(body);
  let object;
  try {
    object = await context.storage.putObject({
      objectKey: session.imageObjectKey,
      body,
      contentType,
      sizeBytes
    });
  } catch (error) {
    if (error instanceof HttpError && isBackendUploadFailureCategory(error.message)) {
      throwBackendUploadFailure(error.message, session.imageObjectKey);
    }
    throw error;
  }
  if (!object.exists) throwBackendUploadFailure("BACKEND_UPLOAD_METADATA_VERIFY_FAILED", session.imageObjectKey);
  await client.shippingWeightProofCaptureSession.update({
    where: { id: session.id },
    data: {
      imageChecksum,
      imageSizeBytes: sizeBytes,
      qualityStatus: quality.status,
      qualityReasonCodes: quality.reasonCodes
    }
  });
  return {
    uploadVerified: true,
    proofStatus: "UPLOAD_VERIFIED",
    nextAction: "FINALIZE",
    quality
  };
}

export async function finalizeWeightProofCapture(input: FinalizeWeightProofCaptureInput, context: WeightProofServiceContext) {
  const client = db(context);
  const merchantId = requireMerchantId(context.merchantId);
  const declaredWeightGrams = validateDeclaredWeightGrams(input.declaredWeightGrams);
  const dimensions = normalizeProofDimensions(input.dimensions);
  const volumetricWeightGrams = calculateVolumetricWeightGrams(dimensions.lengthCm, dimensions.widthCm, dimensions.heightCm);
  const chargeableWeightGrams = calculateChargeableWeightGrams(declaredWeightGrams, volumetricWeightGrams);
  const capturedAt = input.capturedAt ?? now(context);
  const session = await client.shippingWeightProofCaptureSession.findFirst({
    where: {
      id: input.captureSessionId,
      merchantId
    }
  });
  if (!session) throw new HttpError(404, "WEIGHT_PROOF_CAPTURE_SESSION_NOT_FOUND");
  const awbNumber = validateWeightProofAwbNumber(input.awbNumber ?? session.awbNumber);
  if (session.awbNumber !== awbNumber) throw new HttpError(409, "WEIGHT_PROOF_AWB_SESSION_MISMATCH");

  const existingProof = await client.shippingWeightProof.findFirst({
    where: {
      merchantId,
      awbNumber
    }
  });
  if (existingProof) {
    return {
      finalized: false,
      idempotent: true,
      proof: serializeWeightProofSellerSafe(existingProof)
    };
  }

  if (session.status !== WeightProofCaptureStatus.CREATED) {
    throw new HttpError(409, "WEIGHT_PROOF_CAPTURE_SESSION_NOT_ACTIVE");
  }
  if (session.expiresAt.getTime() <= now(context).getTime()) {
    await client.shippingWeightProofCaptureSession.update({
      where: { id: session.id },
      data: { status: WeightProofCaptureStatus.EXPIRED }
    });
    throw new HttpError(409, "WEIGHT_PROOF_CAPTURE_SESSION_EXPIRED");
  }

  const object = await verifyUploadedObject(context, session.imageObjectKey);

  const proof = await runInTransaction(client, async (tx) => {
    const created = await tx.shippingWeightProof.create({
      data: {
        captureSessionId: session.id,
        merchantId,
        shipmentId: session.shipmentId,
        awbNumber,
        declaredWeightGrams,
        lengthCm: dimensions.lengthCm,
        widthCm: dimensions.widthCm,
        heightCm: dimensions.heightCm,
        volumetricWeightGrams,
        chargeableWeightGrams,
        imageObjectKey: session.imageObjectKey,
        contentType: object.contentType ?? session.contentType,
        imageChecksum: session.imageChecksum ?? null,
        imageSizeBytes: session.imageSizeBytes ?? object.contentLength ?? null,
        imageQualityStatus: session.qualityStatus ?? null,
        imageQualityReasonCodes: session.qualityReasonCodes ?? [],
        imageRetentionStatus: RETENTION_STATUS_ACTIVE,
        deviceId: nullable(input.deviceId) ?? session.deviceId ?? null,
        capturedAt
      }
    });
    await tx.shippingWeightProofCaptureSession.update({
      where: { id: session.id },
      data: {
        status: WeightProofCaptureStatus.FINALIZED,
        finalizedAt: capturedAt
      }
    });
    return created;
  });

  return {
    finalized: true,
    idempotent: false,
    proof: serializeWeightProofSellerSafe(proof)
  };
}

export async function getWeightProofByAwb(input: { awbNumber: string }, context: WeightProofServiceContext) {
  const client = db(context);
  const merchantId = requireMerchantId(context.merchantId);
  const awbNumber = validateWeightProofAwbNumber(input.awbNumber);
  const proof = await client.shippingWeightProof.findFirst({
    where: {
      merchantId,
      awbNumber
    }
  });
  if (!proof) throw new HttpError(404, "WEIGHT_PROOF_NOT_FOUND");
  return serializeWeightProofSellerSafe(proof);
}

function normalizePaidEntityType(value: string) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized !== "SELLER" && normalized !== "MERCHANT") {
    throw new HttpError(400, "WEIGHT_GUARD_PAID_ENTITY_INVALID");
  }
  return normalized;
}

function normalizeSettlementRef(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

async function hasOpenWeightDispute(client: Db, proof: { merchantId: string; shipmentId?: string | null }) {
  if (!proof.shipmentId) return false;
  const openCase = await client.weightDiscrepancyCase.findFirst({
    where: {
      merchantId: proof.merchantId,
      shipmentId: proof.shipmentId,
      status: { in: OPEN_WEIGHT_DISPUTE_STATUSES }
    }
  });
  return Boolean(openCase);
}

export async function deleteWeightProofImageAfterAwbPaid(
  input: DeleteWeightProofImageAfterAwbPaidInput,
  context: WeightProofServiceContext
) {
  const client = db(context);
  const merchantId = requireMerchantId(context.merchantId);
  const awbNumber = validateWeightProofAwbNumber(input.awbNumber);
  const paidEntityType = normalizePaidEntityType(input.paidEntityType);
  const settlementRef = normalizeSettlementRef(input.settlementRef);
  if (!settlementRef) {
    return {
      deleted: false,
      skipped: true,
      reason: "AWB_NOT_FINANCIALLY_CLOSED" as const,
      awbNumber,
      paidEntityType
    };
  }

  const proof = await client.shippingWeightProof.findFirst({
    where: {
      merchantId,
      awbNumber
    }
  });
  if (!proof) {
    return {
      deleted: false,
      skipped: true,
      reason: "WEIGHT_PROOF_NOT_FOUND" as const,
      awbNumber,
      paidEntityType,
      settlementRef
    };
  }

  if (proof.imageRetentionStatus === RETENTION_STATUS_DELETED_AFTER_PAYOUT || proof.imageDeletedAt) {
    return {
      deleted: false,
      idempotent: true,
      reason: RETENTION_DELETION_REASON_FINANCIALLY_CLOSED,
      proof: serializeWeightProofSellerSafe(proof)
    };
  }

  if (await hasOpenWeightDispute(client, proof)) {
    return {
      deleted: false,
      skipped: true,
      reason: "WEIGHT_DISPUTE_OPEN" as const,
      proof: serializeWeightProofSellerSafe(proof)
    };
  }

  await context.storage.deleteObject({ objectKey: proof.imageObjectKey });
  const deletedAt = now(context);
  const updated = await client.shippingWeightProof.update({
    where: { id: proof.id },
    data: {
      imageDeletedAt: deletedAt,
      imageDeletionReason: RETENTION_DELETION_REASON_FINANCIALLY_CLOSED,
      imageRetentionStatus: RETENTION_STATUS_DELETED_AFTER_PAYOUT,
      deletedAfterSettlementRef: settlementRef,
      imageSizeBytes: proof.imageSizeBytes ?? null,
      imageChecksum: proof.imageChecksum ?? null
    }
  });

  return {
    deleted: true,
    idempotent: false,
    reason: RETENTION_DELETION_REASON_FINANCIALLY_CLOSED,
    paidEntityType,
    proof: serializeWeightProofSellerSafe(updated)
  };
}
