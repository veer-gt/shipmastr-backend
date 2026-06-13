import { z } from "zod";
import { courierLiveProviderKeys, type CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import { courierArbitrationCapabilities } from "./courier-arbitration.types.js";

export const courierArbitrationQuerySchema = z.object({
  provider_key: z.enum(courierLiveProviderKeys).optional(),
  pickup_location_id: z.string().trim().min(1).optional(),
  requested_capability: z.enum(courierArbitrationCapabilities).default("AWB")
}).strict();

export function parseCourierArbitrationProvider(value: string | string[] | undefined): CourierLiveProviderKey | undefined {
  const normalized = (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toUpperCase();
  if (!normalized) return undefined;
  return courierLiveProviderKeys.includes(normalized as CourierLiveProviderKey)
    ? normalized as CourierLiveProviderKey
    : undefined;
}
