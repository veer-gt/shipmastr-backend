import { z } from "zod";
import { normalizeCourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.providers.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import { courierArbitrationCapabilities } from "../arbitration/courier-arbitration.types.js";

export function parseCourierReadinessAutopilotProvider(value: string | string[] | undefined): CourierLiveProviderKey | null {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return normalizeCourierLiveProviderKey(raw);
}

export const courierReadinessAutopilotQuerySchema = z.object({
  pickup_location_id: z.string().trim().min(1).max(120).optional(),
  requested_capability: z.preprocess(
    (value) => String(value || "AWB").trim().toUpperCase(),
    z.enum(courierArbitrationCapabilities)
  ).default("AWB"),
  include_arbitration: z.coerce.boolean().optional().default(false),
  include_pickup_learning: z.coerce.boolean().optional().default(false),
  include_sandboxes: z.coerce.boolean().optional().default(false)
}).strict();

export type CourierReadinessAutopilotQuery = z.infer<typeof courierReadinessAutopilotQuerySchema>;
