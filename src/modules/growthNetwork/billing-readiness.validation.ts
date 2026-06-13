import { z } from "zod";

import {
  growthBillingEventTypes,
  growthBillingReadinessStatuses
} from "./billing-readiness.types.js";

const optionalId = z.string().trim().min(1).max(160).optional().nullable();
const optionalLongString = z.string().trim().max(2000).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();

function hasValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function requireMerchantOrPartner(
  value: { merchantId?: string | null | undefined; partnerId?: string | null | undefined },
  ctx: z.RefinementCtx
) {
  if (!hasValue(value.merchantId) && !hasValue(value.partnerId)) {
    ctx.addIssue({
      code: "custom",
      path: ["merchantId"],
      message: "merchantId or partnerId is required"
    });
  }
}

export const upsertBillingReadinessProfileSchema = z.object({
  merchantId: optionalId,
  partnerId: optionalId,
  readinessStatus: z.enum(growthBillingReadinessStatuses).default("NOT_READY"),
  legalReviewRef: optionalId,
  financeReviewRef: optionalId,
  notes: optionalLongString,
  metadata: jsonObject
}).superRefine(requireMerchantOrPartner);

export const listBillingReadinessProfilesQuerySchema = z.object({
  merchantId: optionalId,
  partnerId: optionalId,
  readinessStatus: z.enum(growthBillingReadinessStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const updateBillingReadinessProfileStatusSchema = z.object({
  readinessStatus: z.enum(growthBillingReadinessStatuses),
  legalReviewRef: optionalId,
  financeReviewRef: optionalId,
  notes: optionalLongString,
  metadata: jsonObject
});

export const createBillingSimulationEventSchema = z.object({
  merchantId: optionalId,
  partnerId: optionalId,
  campaignId: optionalId,
  leadId: optionalId,
  eventType: z.enum(growthBillingEventTypes),
  amountPaise: z.coerce.number().int().min(0).max(100_000_000).optional().nullable(),
  currency: z.string().trim().length(3).toUpperCase().default("INR"),
  simulationSnapshot: z.record(z.string(), z.unknown()).default({})
}).superRefine((value, ctx) => {
  if (!hasValue(value.merchantId) && !hasValue(value.partnerId) && !hasValue(value.campaignId) && !hasValue(value.leadId)) {
    ctx.addIssue({
      code: "custom",
      path: ["merchantId"],
      message: "merchantId, partnerId, campaignId, or leadId is required"
    });
  }
});

export const listBillingSimulationEventsQuerySchema = z.object({
  merchantId: optionalId,
  partnerId: optionalId,
  campaignId: optionalId,
  leadId: optionalId,
  eventType: z.enum(growthBillingEventTypes).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const billingReadinessProfileIdParamsSchema = z.object({
  profileId: z.string().trim().min(1).max(160)
});

export type UpsertBillingReadinessProfileInput = z.infer<typeof upsertBillingReadinessProfileSchema>;
export type ListBillingReadinessProfilesQueryInput = z.infer<typeof listBillingReadinessProfilesQuerySchema>;
export type UpdateBillingReadinessProfileStatusInput = z.infer<typeof updateBillingReadinessProfileStatusSchema>;
export type CreateBillingSimulationEventInput = z.infer<typeof createBillingSimulationEventSchema>;
export type ListBillingSimulationEventsQueryInput = z.infer<typeof listBillingSimulationEventsQuerySchema>;
