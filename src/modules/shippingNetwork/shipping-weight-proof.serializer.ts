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
  lengthCm?: unknown;
  widthCm?: unknown;
  heightCm?: unknown;
  capturedAt?: Date | string | null;
  createdAt?: Date | string | null;
}) {
  return {
    status: "available",
    proof_id: proof.id,
    capture_session_id: proof.captureSessionId,
    awb_number: proof.awbNumber,
    proof_status: "captured",
    declared_weight_grams: proof.declaredWeightGrams,
    volumetric_weight_grams: proof.volumetricWeightGrams,
    chargeable_weight_grams: proof.chargeableWeightGrams,
    dimensions: {
      length_cm: decimalToNumber(proof.lengthCm) ?? 0,
      width_cm: decimalToNumber(proof.widthCm) ?? 0,
      height_cm: decimalToNumber(proof.heightCm) ?? 0
    },
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
