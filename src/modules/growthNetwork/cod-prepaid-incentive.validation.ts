import { z } from "zod";

import {
  prepaidIncentiveStatuses,
  prepaidIncentiveTypes,
  prepaidManageablePolicyStatuses,
  prepaidOfferSurfaces
} from "./cod-prepaid-incentive.types.js";

const optionalId = z.string().trim().min(1).max(180).optional().nullable();
const optionalText = z.string().trim().max(2000).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();
const optionalAmount = z.coerce.number().int().min(0).optional().nullable();

function hasValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

export const createPrepaidIncentivePolicySchema = z.object({
  merchantId: z.string().trim().min(1).max(180),
  title: z.string().trim().min(1).max(160),
  description: optionalText,
  status: z.enum(prepaidIncentiveStatuses).default("DRAFT"),
  incentiveType: z.enum(prepaidIncentiveTypes),
  discountAmountPaise: optionalAmount,
  discountPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  maxDiscountAmountPaise: optionalAmount,
  minOrderAmountPaise: optionalAmount,
  maxOrderAmountPaise: optionalAmount,
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (value.incentiveType === "FLAT_DISCOUNT" && !value.discountAmountPaise) {
    ctx.addIssue({
      code: "custom",
      path: ["discountAmountPaise"],
      message: "discountAmountPaise must be greater than 0 for flat discounts"
    });
  }

  if (value.incentiveType === "PERCENT_DISCOUNT" && !value.discountPercent) {
    ctx.addIssue({
      code: "custom",
      path: ["discountPercent"],
      message: "discountPercent must be greater than 0 for percent discounts"
    });
  }

  if (value.minOrderAmountPaise != null && value.maxOrderAmountPaise != null && value.maxOrderAmountPaise < value.minOrderAmountPaise) {
    ctx.addIssue({
      code: "custom",
      path: ["maxOrderAmountPaise"],
      message: "maxOrderAmountPaise must be greater than or equal to minOrderAmountPaise"
    });
  }

  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "endsAt must be after startsAt"
    });
  }
});

export const listPrepaidIncentivePoliciesQuerySchema = z.object({
  merchantId: optionalId,
  status: z.enum(prepaidIncentiveStatuses).optional(),
  incentiveType: z.enum(prepaidIncentiveTypes).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const updatePrepaidIncentivePolicyStatusSchema = z.object({
  status: z.enum(prepaidManageablePolicyStatuses)
});

export const resolvePrepaidIncentiveSchema = z.object({
  merchantId: z.string().trim().min(1).max(180),
  sellerId: optionalId,
  orderId: optionalId,
  shipmentId: optionalId,
  paymentMode: z.string().trim().max(80).optional().nullable(),
  paymentStatus: z.string().trim().max(80).optional().nullable(),
  isPaid: z.boolean().optional().nullable(),
  codAmountPaise: optionalAmount,
  orderAmountPaise: optionalAmount,
  orderStatus: z.string().trim().max(80).optional().nullable(),
  shipmentStatus: z.string().trim().max(80).optional().nullable(),
  surface: z.enum(prepaidOfferSurfaces).default("TRACKING_PAGE"),
  anonymousBuyerRef: optionalId,
  sessionRef: optionalId
}).superRefine((value, ctx) => {
  if (!hasValue(value.orderId) && !hasValue(value.shipmentId) && !hasValue(value.paymentMode) && !value.codAmountPaise) {
    ctx.addIssue({
      code: "custom",
      path: ["orderId"],
      message: "order, shipment, or direct payment context is required"
    });
  }
});

export const createPrepaidConversionIntentSchema = z.object({
  policyId: z.string().trim().min(1).max(180),
  merchantId: z.string().trim().min(1).max(180),
  sellerId: optionalId,
  orderId: optionalId,
  shipmentId: optionalId,
  growthOfferId: optionalId,
  originalPaymentMode: z.string().trim().max(80).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (!hasValue(value.orderId) && !hasValue(value.shipmentId)) {
    ctx.addIssue({
      code: "custom",
      path: ["orderId"],
      message: "orderId or shipmentId is required for prepaid conversion intent"
    });
  }
});

export const prepaidPolicyIdParamsSchema = z.object({
  policyId: z.string().trim().min(1).max(180)
});

export const prepaidIntentIdParamsSchema = z.object({
  intentId: z.string().trim().min(1).max(180)
});

export type CreatePrepaidIncentivePolicyInput = z.infer<typeof createPrepaidIncentivePolicySchema>;
export type ListPrepaidIncentivePoliciesQueryInput = z.infer<typeof listPrepaidIncentivePoliciesQuerySchema>;
export type UpdatePrepaidIncentivePolicyStatusInput = z.infer<typeof updatePrepaidIncentivePolicyStatusSchema>;
export type ResolvePrepaidIncentiveInput = z.infer<typeof resolvePrepaidIncentiveSchema>;
export type CreatePrepaidConversionIntentInput = z.infer<typeof createPrepaidConversionIntentSchema>;
