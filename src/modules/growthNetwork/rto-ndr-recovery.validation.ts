import { z } from "zod";

import {
  rtoNdrManageablePolicyStatuses,
  rtoNdrRecoveryActionTypes,
  rtoNdrRecoveryPolicyStatuses,
  rtoNdrRecoverySurfaces
} from "./rto-ndr-recovery.types.js";

const optionalId = z.string().trim().min(1).max(180).optional().nullable();
const optionalText = z.string().trim().max(2000).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();
const optionalAmount = z.coerce.number().int().min(0).optional().nullable();
const failureReasons = z.array(z.string().trim().min(1).max(120)).max(30).optional().nullable();

function hasValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

export const createRtoNdrRecoveryPolicySchema = z.object({
  merchantId: z.string().trim().min(1).max(180),
  title: z.string().trim().min(1).max(160),
  description: optionalText,
  status: z.enum(rtoNdrRecoveryPolicyStatuses).default("DRAFT"),
  actionType: z.enum(rtoNdrRecoveryActionTypes),
  incentiveAmountPaise: optionalAmount,
  maxIncentiveAmountPaise: optionalAmount,
  minOrderAmountPaise: optionalAmount,
  maxOrderAmountPaise: optionalAmount,
  allowedFailureReasons: failureReasons,
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (value.maxIncentiveAmountPaise != null && value.incentiveAmountPaise != null && value.maxIncentiveAmountPaise < value.incentiveAmountPaise) {
    ctx.addIssue({
      code: "custom",
      path: ["maxIncentiveAmountPaise"],
      message: "maxIncentiveAmountPaise must be greater than or equal to incentiveAmountPaise"
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

export const listRtoNdrRecoveryPoliciesQuerySchema = z.object({
  merchantId: optionalId,
  status: z.enum(rtoNdrRecoveryPolicyStatuses).optional(),
  actionType: z.enum(rtoNdrRecoveryActionTypes).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const updateRtoNdrRecoveryPolicyStatusSchema = z.object({
  status: z.enum(rtoNdrManageablePolicyStatuses)
});

export const resolveRtoNdrRecoverySchema = z.object({
  merchantId: z.string().trim().min(1).max(180),
  sellerId: optionalId,
  orderId: optionalId,
  shipmentId: optionalId,
  orderStatus: z.string().trim().max(80).optional().nullable(),
  shipmentStatus: z.string().trim().max(80).optional().nullable(),
  ndrStatus: z.string().trim().max(120).optional().nullable(),
  rtoStatus: z.string().trim().max(120).optional().nullable(),
  failureReason: z.string().trim().max(120).optional().nullable(),
  orderAmountPaise: optionalAmount,
  surface: z.enum(rtoNdrRecoverySurfaces).default("NDR_ACTION"),
  anonymousBuyerRef: optionalId,
  sessionRef: optionalId
}).superRefine((value, ctx) => {
  if (
    !hasValue(value.orderId)
    && !hasValue(value.shipmentId)
    && !hasValue(value.orderStatus)
    && !hasValue(value.shipmentStatus)
    && !hasValue(value.ndrStatus)
    && !hasValue(value.rtoStatus)
    && !hasValue(value.failureReason)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["shipmentId"],
      message: "shipment, order, or direct NDR/RTO recovery context is required"
    });
  }
});

export const createRtoNdrRecoveryIntentSchema = z.object({
  policyId: z.string().trim().min(1).max(180),
  merchantId: z.string().trim().min(1).max(180),
  sellerId: optionalId,
  orderId: optionalId,
  shipmentId: optionalId,
  growthOfferId: optionalId,
  actionType: z.enum(rtoNdrRecoveryActionTypes).optional().nullable(),
  failureReason: z.string().trim().max(120).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (!hasValue(value.orderId) && !hasValue(value.shipmentId)) {
    ctx.addIssue({
      code: "custom",
      path: ["shipmentId"],
      message: "orderId or shipmentId is required for recovery intent"
    });
  }
});

export const rtoNdrRecoveryPolicyIdParamsSchema = z.object({
  policyId: z.string().trim().min(1).max(180)
});

export const rtoNdrRecoveryIntentIdParamsSchema = z.object({
  intentId: z.string().trim().min(1).max(180)
});

export type CreateRtoNdrRecoveryPolicyInput = z.infer<typeof createRtoNdrRecoveryPolicySchema>;
export type ListRtoNdrRecoveryPoliciesQueryInput = z.infer<typeof listRtoNdrRecoveryPoliciesQuerySchema>;
export type UpdateRtoNdrRecoveryPolicyStatusInput = z.infer<typeof updateRtoNdrRecoveryPolicyStatusSchema>;
export type ResolveRtoNdrRecoveryInput = z.infer<typeof resolveRtoNdrRecoverySchema>;
export type CreateRtoNdrRecoveryIntentInput = z.infer<typeof createRtoNdrRecoveryIntentSchema>;
