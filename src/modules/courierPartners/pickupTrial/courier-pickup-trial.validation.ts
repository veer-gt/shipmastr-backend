import { z } from "zod";

export const createCourierPickupTrialSchema = z.object({
  pickup_location_id: z.string().trim().min(1),
  mode: z.literal("DRY_RUN").default("DRY_RUN")
}).strict();

export const refreshCourierPickupTrialRatesSchema = z.object({
  pickup_location_id: z.string().trim().min(1),
  mode: z.literal("CONTROLLED_REFRESH").default("CONTROLLED_REFRESH")
}).strict();

export const confirmCourierPickupTrialSchema = z.object({
  pickup_location_id: z.string().trim().min(1),
  trial_id: z.string().trim().min(1),
  operator_note: z.string().trim().max(240).optional()
}).strict();

export const confirmedPickupRateRefreshSchema = z.object({
  pickup_location_id: z.string().trim().min(1),
  mode: z.literal("CONFIRMED_PICKUP_REFRESH").default("CONFIRMED_PICKUP_REFRESH")
}).strict();

export function parseCourierPickupTrialProvider(value: string | string[] | undefined) {
  const providerKey = (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toUpperCase();
  if (!providerKey) return null;
  if (providerKey !== "SHIPROCKET") return null;
  return providerKey as "SHIPROCKET";
}
