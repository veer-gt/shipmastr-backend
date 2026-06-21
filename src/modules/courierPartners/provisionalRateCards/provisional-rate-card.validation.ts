import { z } from "zod";
import {
  provisionalRateCardZoneCodes,
  shipmastrOutcomeTierCodes
} from "./provisional-rate-card.types.js";

export const provisionalRateCardSimulationSchema = z.object({
  outcome_code: z.enum(shipmastrOutcomeTierCodes).default("SHIPMASTR_SMART"),
  zone_code: z.enum(provisionalRateCardZoneCodes),
  weight_kg: z.coerce.number().positive(),
  seller_facing: z.coerce.boolean().default(false)
});

export const provisionalRateCardImportSchema = z.object({
  template: z.unknown()
}).or(z.unknown()).transform((value) => (
  value && typeof value === "object" && !Array.isArray(value) && "template" in value
    ? (value as { template: unknown }).template
    : value
));

export const provisionalRateCardReviewActionSchema = z.object({
  note: z.string().trim().max(500).optional().or(z.literal("")),
  reason: z.string().trim().max(500).optional().or(z.literal(""))
});
