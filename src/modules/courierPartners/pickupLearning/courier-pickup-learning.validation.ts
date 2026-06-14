import { z } from "zod";

export const pickupLearningQuerySchema = z.object({
  delivery_pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/).optional(),
  shipment_id: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
}).strict();

export function parsePickupLearningProvider(value: string | string[] | undefined) {
  const providerKey = (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toUpperCase();
  if (!providerKey) return null;
  if (providerKey !== "SHIPROCKET") return null;
  return providerKey as "SHIPROCKET";
}
