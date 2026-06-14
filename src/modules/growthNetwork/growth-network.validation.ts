import { z } from "zod";

import {
  growthEventTypes,
  growthManageableOfferStatuses,
  growthOfferLevelEventTypes,
  growthOfferStatuses,
  growthOfferTypes,
  growthPlacementSurfaces
} from "./growth-network.types.js";

const optionalId = z.string().trim().min(1).max(160).optional().nullable();
const optionalLongString = z.string().trim().max(2000).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();
const offerLevelEventSet = new Set<string>(growthOfferLevelEventTypes);

function hasValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

export const createGrowthOfferSchema = z.object({
  merchantId: optionalId,
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(240).optional().nullable(),
  description: optionalLongString,
  type: z.enum(growthOfferTypes),
  status: z.enum(growthOfferStatuses).default("DRAFT"),
  isSponsored: z.boolean().default(false),
  sponsorName: z.string().trim().max(160).optional().nullable(),
  ctaLabel: z.string().trim().min(1).max(80),
  ctaUrl: z.string().trim().max(2048).optional().nullable(),
  metadata: jsonObject,
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable()
}).superRefine((value, ctx) => {
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "endsAt must be after startsAt"
    });
  }
});

export const listGrowthOffersQuerySchema = z.object({
  merchantId: optionalId,
  type: z.enum(growthOfferTypes).optional(),
  status: z.enum(growthOfferStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const updateGrowthOfferStatusSchema = z.object({
  status: z.enum(growthManageableOfferStatuses)
});

export const createGrowthOfferPlacementSchema = z.object({
  surface: z.enum(growthPlacementSurfaces),
  priority: z.coerce.number().int().min(1).max(10_000).default(100),
  rulesJson: jsonObject
});

export const resolveGrowthOffersQuerySchema = z.object({
  merchantId: optionalId,
  sellerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  anonymousBuyerRef: optionalId,
  sessionRef: optionalId,
  max: z.coerce.number().int().min(1).max(12).default(3)
});

export const recordGrowthEventSchema = z.object({
  offerId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  eventType: z.enum(growthEventTypes),
  surface: z.enum(growthPlacementSurfaces),
  anonymousBuyerRef: optionalId,
  sessionRef: optionalId,
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (offerLevelEventSet.has(value.eventType) && !hasValue(value.offerId)) {
    ctx.addIssue({
      code: "custom",
      path: ["offerId"],
      message: "offerId is required for offer-level growth events"
    });
  }
});

export const recordOfferEventSchema = recordGrowthEventSchema.superRefine((value, ctx) => {
  if (value.eventType === "VIEW") {
    ctx.addIssue({
      code: "custom",
      path: ["eventType"],
      message: "Use the tracking-page view endpoint for VIEW events"
    });
  }
});

export const recordTrackingPageViewSchema = z.object({
  offerId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  anonymousBuyerRef: optionalId,
  sessionRef: optionalId,
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  metadata: jsonObject
});

export const offerIdParamsSchema = z.object({
  offerId: z.string().trim().min(1).max(160)
});

export const surfaceParamsSchema = z.object({
  surface: z.enum(growthPlacementSurfaces)
});

export type CreateGrowthOfferInput = z.infer<typeof createGrowthOfferSchema>;
export type ListGrowthOffersQueryInput = z.infer<typeof listGrowthOffersQuerySchema>;
export type UpdateGrowthOfferStatusInput = z.infer<typeof updateGrowthOfferStatusSchema>;
export type CreateGrowthOfferPlacementInput = z.infer<typeof createGrowthOfferPlacementSchema>;
export type ResolveGrowthOffersQueryInput = z.infer<typeof resolveGrowthOffersQuerySchema>;
export type RecordGrowthEventInput = z.infer<typeof recordGrowthEventSchema>;
export type RecordTrackingPageViewInput = z.infer<typeof recordTrackingPageViewSchema>;
