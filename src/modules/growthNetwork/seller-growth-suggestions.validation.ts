import { z } from "zod";

import { sellerGrowthSuggestionEventTypes } from "./seller-growth-suggestions.types.js";

const optionalId = z.string().trim().min(1).max(180).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();

export const resolveSellerGrowthSuggestionsQuerySchema = z.object({
  merchantId: optionalId,
  sellerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  max: z.coerce.number().int().min(1).max(6).default(3)
});

export const recordSellerGrowthSuggestionEventSchema = z.object({
  suggestionId: z.string().trim().min(1).max(200),
  offerId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  shipmentId: optionalId,
  orderId: optionalId,
  eventType: z.enum(sellerGrowthSuggestionEventTypes),
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable(),
  metadata: jsonObject
});

export type ResolveSellerGrowthSuggestionsQueryInput = z.infer<typeof resolveSellerGrowthSuggestionsQuerySchema>;
export type RecordSellerGrowthSuggestionEventInput = z.infer<typeof recordSellerGrowthSuggestionEventSchema>;
