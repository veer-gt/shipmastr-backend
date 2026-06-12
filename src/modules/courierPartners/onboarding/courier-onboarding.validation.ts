import { z } from "zod";
import { normalizeCourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.providers.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";

export function parseCourierOnboardingProvider(value: string | string[] | undefined): CourierLiveProviderKey | null {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return normalizeCourierLiveProviderKey(raw);
}

export const courierOnboardingQuerySchema = z.object({
  merchant_id: z.string().trim().min(1).max(120).optional(),
  provider_key: z.string().trim().min(1).max(40).optional(),
  shipment_id: z.string().trim().min(1).max(120).optional(),
  pickup_location_id: z.string().trim().min(1).max(120).optional(),
  include_pickup_probe: z.coerce.boolean().optional().default(false)
});
