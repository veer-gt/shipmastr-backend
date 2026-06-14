import { z } from "zod";

export const courierPickupServiceabilityQuerySchema = z.object({
  shipment_id: z.string().trim().min(1).optional(),
  pickup_location_id: z.string().trim().min(1).optional(),
  delivery_pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/).optional()
}).strict();

export function parseCourierPickupServiceabilityProvider(value: string | string[] | undefined) {
  const providerKey = (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toUpperCase();
  if (!providerKey) return null;
  if (providerKey !== "SHIPROCKET") return null;
  return providerKey as "SHIPROCKET";
}
