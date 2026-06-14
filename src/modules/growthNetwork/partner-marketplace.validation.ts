import { z } from "zod";

import { growthPlacementSurfaces } from "./growth-network.types.js";
import {
  growthAttributionEventTypes,
  growthManageablePartnerStatuses,
  growthPartnerCategories,
  growthPartnerLeadStatuses,
  growthPartnerStatuses
} from "./partner-marketplace.types.js";

const optionalId = z.string().trim().min(1).max(160).optional().nullable();
const optionalLongString = z.string().trim().max(2000).optional().nullable();
const optionalUrl = z.string().trim().max(2048).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();

function hasValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function dateWindowRefinement(
  value: { startsAt?: Date | null | undefined; endsAt?: Date | null | undefined },
  ctx: z.RefinementCtx
) {
  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    ctx.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "endsAt must be after startsAt"
    });
  }
}

export const createGrowthPartnerSchema = z.object({
  name: z.string().trim().min(2).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  displayName: z.string().trim().min(1).max(160),
  category: z.enum(growthPartnerCategories),
  status: z.enum(growthPartnerStatuses).default("DRAFT"),
  description: optionalLongString,
  websiteUrl: optionalUrl,
  isSponsored: z.boolean().default(false),
  metadata: jsonObject
});

export const listGrowthPartnersQuerySchema = z.object({
  category: z.enum(growthPartnerCategories).optional(),
  status: z.enum(growthPartnerStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const updateGrowthPartnerStatusSchema = z.object({
  status: z.enum(growthManageablePartnerStatuses)
});

export const createGrowthPartnerPlacementSchema = z.object({
  offerId: optionalId,
  surface: z.enum(growthPlacementSurfaces),
  priority: z.coerce.number().int().min(1).max(10_000).default(100),
  rulesJson: jsonObject,
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable()
}).superRefine(dateWindowRefinement);

export const resolveGrowthPartnerSuggestionsQuerySchema = z.object({
  merchantId: optionalId,
  sellerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  attributionRef: optionalId,
  sessionRef: optionalId,
  max: z.coerce.number().int().min(1).max(12).default(3)
});

export const captureGrowthPartnerLeadSchema = z.object({
  partnerId: z.string().trim().min(1).max(160),
  merchantId: optionalId,
  sellerId: optionalId,
  offerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  status: z.enum(growthPartnerLeadStatuses).default("CAPTURED"),
  sourceSurface: z.enum(growthPlacementSurfaces),
  attributionRef: optionalId,
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  metadata: jsonObject
});

export const recordGrowthPartnerAttributionEventSchema = z.object({
  partnerId: optionalId,
  offerId: optionalId,
  leadId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  eventType: z.enum(growthAttributionEventTypes),
  surface: z.enum(growthPlacementSurfaces),
  attributionRef: optionalId,
  sessionRef: optionalId,
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (!hasValue(value.partnerId) && !hasValue(value.offerId) && !hasValue(value.leadId)) {
    ctx.addIssue({
      code: "custom",
      path: ["partnerId"],
      message: "partnerId, offerId, or leadId is required for attribution events"
    });
  }
});

export const partnerIdParamsSchema = z.object({
  partnerId: z.string().trim().min(1).max(160)
});

export const partnerSuggestionSurfaceParamsSchema = z.object({
  surface: z.enum(growthPlacementSurfaces)
});

export type CreateGrowthPartnerInput = z.infer<typeof createGrowthPartnerSchema>;
export type ListGrowthPartnersQueryInput = z.infer<typeof listGrowthPartnersQuerySchema>;
export type UpdateGrowthPartnerStatusInput = z.infer<typeof updateGrowthPartnerStatusSchema>;
export type CreateGrowthPartnerPlacementInput = z.infer<typeof createGrowthPartnerPlacementSchema>;
export type ResolveGrowthPartnerSuggestionsQueryInput = z.infer<typeof resolveGrowthPartnerSuggestionsQuerySchema>;
export type CaptureGrowthPartnerLeadInput = z.infer<typeof captureGrowthPartnerLeadSchema>;
export type RecordGrowthPartnerAttributionEventInput = z.infer<typeof recordGrowthPartnerAttributionEventSchema>;
