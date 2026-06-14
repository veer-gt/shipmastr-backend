import { z } from "zod";
import { courierLiveProviderKeys } from "../liveReadiness/courier-live-readiness.types.js";
import { normalizeCourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.providers.js";
import { courierAwbCertificationTiers } from "./courier-awb-certification.types.js";

export function parseCourierAwbCertificationProvider(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const providerKey = normalizeCourierLiveProviderKey(raw || "");
  return providerKey && (courierLiveProviderKeys as readonly string[]).includes(providerKey) ? providerKey : null;
}

export const courierAwbCertificationDryRunSchema = z.object({
  pickup_location_id: z.string().trim().min(1).max(120).optional(),
  requested_tier: z.enum(courierAwbCertificationTiers).nullable().optional()
}).strict();

export type CourierAwbCertificationDryRunInput = z.infer<typeof courierAwbCertificationDryRunSchema>;

export const courierAwbCertificationLiveOneShotSchema = z.object({
  pickup_location_id: z.string().trim().min(1).max(120).optional(),
  requested_tier: z.enum(courierAwbCertificationTiers).default("smart"),
  operator_note: z.string().trim().min(1).max(240).optional()
}).strict();

export type CourierAwbCertificationLiveOneShotInput = z.infer<typeof courierAwbCertificationLiveOneShotSchema>;
