import {
  COD_HIGH_VALUE_THRESHOLD_PAISE,
  NEEDS_ATTENTION_REASONS,
  type ShippingOrderValidationStatus
} from "./shipping-order-foundation.types.js";
import { scoreAddress } from "./shipping-address-quality.js";

const INDIAN_MOBILE = /^[6-9][0-9]{9}$/;
const INDIAN_PINCODE = /^[1-9][0-9]{5}$/;

export type OrderValidationInput = {
  buyerName?: string | null | undefined;
  buyerPhone?: string | null | undefined;
  addressLine1?: string | null | undefined;
  addressLine2?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  pincode?: string | null | undefined;
  landmark?: string | null | undefined;
  packageWeightGrams?: number | null | undefined;
  paymentMode: string;
  codAmountPaise?: number | null | undefined;
  pickupLocationId?: string | null | undefined;
};

export type OrderValidationResult = {
  status: ShippingOrderValidationStatus;
  needsAttentionReasons: string[];
  addressQualityScore: number;
  addressQualityFlags: string[];
  volumetricWeight: number | null;
};

export function normalizeIndianPhone(raw: string | null | undefined) {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

export function validateOrder(
  input: OrderValidationInput,
  dimensions?: {
    lengthMm?: number | null | undefined;
    widthMm?: number | null | undefined;
    heightMm?: number | null | undefined;
  }
): OrderValidationResult {
  const reasons: string[] = [];

  if (!input.buyerName || input.buyerName.trim().length < 2) {
    reasons.push(NEEDS_ATTENTION_REASONS.MISSING_BUYER_NAME);
  }

  const phone = normalizeIndianPhone(input.buyerPhone);
  if (!input.buyerPhone || phone.length < 10) {
    reasons.push(NEEDS_ATTENTION_REASONS.MISSING_PHONE);
  } else if (!INDIAN_MOBILE.test(phone)) {
    reasons.push(NEEDS_ATTENTION_REASONS.INVALID_PHONE);
  }

  const pincode = input.pincode?.trim() ?? "";
  if (!pincode) {
    reasons.push(NEEDS_ATTENTION_REASONS.MISSING_PINCODE);
  } else if (!INDIAN_PINCODE.test(pincode)) {
    reasons.push(NEEDS_ATTENTION_REASONS.INVALID_PINCODE);
  }

  const quality = scoreAddress({
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    state: input.state,
    pincode: input.pincode,
    landmark: input.landmark
  });

  if (!quality.passed) {
    reasons.push(NEEDS_ATTENTION_REASONS.ADDRESS_QUALITY_LOW);
  }

  if (input.packageWeightGrams === null || input.packageWeightGrams === undefined) {
    reasons.push(NEEDS_ATTENTION_REASONS.MISSING_PACKAGE_WEIGHT);
  } else if (input.packageWeightGrams <= 0) {
    reasons.push(NEEDS_ATTENTION_REASONS.ZERO_PACKAGE_WEIGHT);
  }

  if (!input.pickupLocationId) {
    reasons.push(NEEDS_ATTENTION_REASONS.MISSING_PICKUP_LOCATION);
  }

  if (
    String(input.paymentMode).toUpperCase() === "COD"
    && Number(input.codAmountPaise ?? 0) > COD_HIGH_VALUE_THRESHOLD_PAISE
  ) {
    reasons.push(NEEDS_ATTENTION_REASONS.COD_AMOUNT_OVER_LIMIT);
  }

  let volumetricWeight: number | null = null;
  if (dimensions?.lengthMm && dimensions.widthMm && dimensions.heightMm) {
    volumetricWeight = Math.ceil((dimensions.lengthMm * dimensions.widthMm * dimensions.heightMm) / 5_000_000 * 1000);
  }

  return {
    status: reasons.length === 0 ? "ready_to_ship" : "needs_attention",
    needsAttentionReasons: Array.from(new Set(reasons)),
    addressQualityScore: quality.score,
    addressQualityFlags: quality.flags,
    volumetricWeight
  };
}
