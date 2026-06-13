import { z } from "zod";
import { normalizeCourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.providers.js";
import { courierLiveProviderKeys } from "../liveReadiness/courier-live-readiness.types.js";

export function parseCourierTrackingCertificationProvider(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const providerKey = normalizeCourierLiveProviderKey(raw || "");
  return providerKey && (courierLiveProviderKeys as readonly string[]).includes(providerKey) ? providerKey : null;
}

export const courierTrackingCertificationDryRunSchema = z.object({
  pickup_location_id: z.string().trim().min(1).max(120).optional()
}).strict();

export type CourierTrackingCertificationDryRunInput = z.infer<typeof courierTrackingCertificationDryRunSchema>;
