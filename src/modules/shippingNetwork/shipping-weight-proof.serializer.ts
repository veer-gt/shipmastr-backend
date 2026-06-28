import { decimalToNumber } from "./shipping-public-serializers.js";

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function serializeWeightProofCaptureSession(session: {
  id: string;
  awbNumber: string;
  status: string;
  expiresAt?: Date | string | null;
  finalizedAt?: Date | string | null;
  createdAt?: Date | string | null;
}) {
  return {
    status: session.status,
    capture_session_id: session.id,
    awb_number: session.awbNumber,
    proof_status: session.status === "FINALIZED" ? "captured" : "capture_pending",
    expires_at: timestamp(session.expiresAt),
    finalized_at: timestamp(session.finalizedAt),
    created_at: timestamp(session.createdAt)
  };
}

export function serializeWeightProofSellerSafe(proof: {
  id: string;
  captureSessionId: string;
  awbNumber: string;
  declaredWeightGrams: number;
  volumetricWeightGrams: number;
  chargeableWeightGrams: number;
  imageRetentionStatus?: string | null;
  imageDeletedAt?: Date | string | null;
  imageDeletionReason?: string | null;
  imageSizeBytes?: number | null;
  imageQualityStatus?: string | null;
  imageQualityReasonCodes?: string[] | null;
  lengthCm?: unknown;
  widthCm?: unknown;
  heightCm?: unknown;
  capturedAt?: Date | string | null;
  createdAt?: Date | string | null;
}) {
  const retentionStatus = String(proof.imageRetentionStatus ?? "ACTIVE").trim().toUpperCase() || "ACTIVE";
  const archivedAfterPayout = retentionStatus === "DELETED_AFTER_PAYOUT" || Boolean(proof.imageDeletedAt);
  return {
    status: archivedAfterPayout ? "archived" : "available",
    proof_id: proof.id,
    capture_session_id: proof.captureSessionId,
    awb_number: proof.awbNumber,
    proof_status: archivedAfterPayout ? "archived_after_payout" : "captured",
    declared_weight_grams: proof.declaredWeightGrams,
    volumetric_weight_grams: proof.volumetricWeightGrams,
    chargeable_weight_grams: proof.chargeableWeightGrams,
    dimensions: {
      length_cm: decimalToNumber(proof.lengthCm) ?? 0,
      width_cm: decimalToNumber(proof.widthCm) ?? 0,
      height_cm: decimalToNumber(proof.heightCm) ?? 0
    },
    image_retention_status: retentionStatus,
    image_deleted_at: timestamp(proof.imageDeletedAt),
    image_deletion_reason: proof.imageDeletionReason ?? null,
    image_size_bytes: proof.imageSizeBytes ?? null,
    image_quality_status: proof.imageQualityStatus ?? null,
    image_quality_reason_codes: proof.imageQualityReasonCodes ?? [],
    captured_at: timestamp(proof.capturedAt),
    created_at: timestamp(proof.createdAt)
  };
}

export function serializeWeightProofInternalEvidence(proof: {
  id: string;
  captureSessionId: string;
  awbNumber: string;
  declaredWeightGrams: number;
  volumetricWeightGrams: number;
  chargeableWeightGrams: number;
  imageObjectKey: string;
  contentType: string;
  deviceId?: string | null;
  capturedAt?: Date | string | null;
  createdAt?: Date | string | null;
}) {
  return {
    proof_id: proof.id,
    capture_session_id: proof.captureSessionId,
    awb_number: proof.awbNumber,
    declared_weight_grams: proof.declaredWeightGrams,
    volumetric_weight_grams: proof.volumetricWeightGrams,
    chargeable_weight_grams: proof.chargeableWeightGrams,
    image_object_key: proof.imageObjectKey,
    content_type: proof.contentType,
    device_id: proof.deviceId ?? null,
    captured_at: timestamp(proof.capturedAt),
    created_at: timestamp(proof.createdAt)
  };
}
