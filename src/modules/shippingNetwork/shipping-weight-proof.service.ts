import { randomUUID } from "node:crypto";
import { WeightProofCaptureStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getSellerShipment } from "./shipping-shipments.service.js";
import {
  buildWeightProofObjectKey,
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
  awbNumber: string;
  declaredWeightGrams: number;
  dimensions: ProofDimensionsInput;
  deviceId?: string | undefined;
  capturedAt?: Date | undefined;
};

export type WeightProofServiceContext = {
  merchantId: string;
  storage: WeightProofStorageAdapter;
  client?: Db | undefined;
  now?: (() => Date) | undefined;
  uploadTtlMs?: number | undefined;
  idFactory?: (() => string) | undefined;
};

const SAFE_AWB = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;

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
  if (contentType !== "image/jpeg") throw new HttpError(400, "WEIGHT_PROOF_CONTENT_TYPE_INVALID");
  return contentType;
}

function validateExpectedByteSize(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, "WEIGHT_PROOF_EXPECTED_SIZE_INVALID");
  return value;
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

async function resolveShipment(client: Db, merchantId: string, shipmentId: string | undefined, awbNumber: string) {
  if (shipmentId) {
    const shipment = await getSellerShipment(merchantId, shipmentId, client);
    if (shipment.awbNumber && shipment.awbNumber !== awbNumber) {
      throw new HttpError(409, "WEIGHT_PROOF_AWB_SHIPMENT_MISMATCH");
    }
    return shipment;
  }
  return shipmentForAwb(client, merchantId, awbNumber);
}

async function runInTransaction<T>(client: Db, operation: (tx: Db) => Promise<T>) {
  const txClient = client as typeof prisma;
  if (typeof txClient.$transaction === "function") {
    return txClient.$transaction((tx) => operation(tx));
  }
  return operation(client);
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
    const upload = await context.storage.createPresignedPutUrl({
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
    capturedAt: createdAt
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
  const upload = await context.storage.createPresignedPutUrl({
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

export async function finalizeWeightProofCapture(input: FinalizeWeightProofCaptureInput, context: WeightProofServiceContext) {
  const client = db(context);
  const merchantId = requireMerchantId(context.merchantId);
  const awbNumber = validateWeightProofAwbNumber(input.awbNumber);
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

  const object = await context.storage.headObject({ objectKey: session.imageObjectKey });
  if (!object.exists) throw new HttpError(409, "WEIGHT_PROOF_OBJECT_NOT_FOUND");

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
