import { z } from "zod";

export const createCourierPickupTrialSchema = z.object({
  pickup_location_id: z.string().trim().min(1),
  mode: z.literal("DRY_RUN").default("DRY_RUN")
}).strict();

export function parseCourierPickupTrialProvider(value: string | string[] | undefined) {
  const providerKey = (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toUpperCase();
  if (!providerKey) return null;
  if (providerKey !== "SHIPROCKET") return null;
  return providerKey as "SHIPROCKET";
}
