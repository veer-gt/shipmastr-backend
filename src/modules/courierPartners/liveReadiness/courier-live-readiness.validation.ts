import { z } from "zod";
import {
  courierLiveProbeTypes,
  courierLiveReadinessModes,
  forbiddenCourierLiveProbeTypes,
  type CourierLiveProbeType,
  type CourierLiveReadinessMode
} from "./courier-live-readiness.types.js";
import { normalizeCourierLiveProviderKey } from "./courier-live-readiness.providers.js";

export function parseCourierLiveProviderKey(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return normalizeCourierLiveProviderKey(raw || "");
}

const modeSchema = z.preprocess(
  (value) => String(value || "DRY_RUN").trim().toUpperCase(),
  z.enum(courierLiveReadinessModes)
);

const credentialRefSchema = z.string()
  .trim()
  .min(8)
  .max(240)
  .regex(/^(vault|runtime|kms|env|courier-provider-credential):[A-Za-z0-9._:/-]+$/, "Use a vault/runtime credential reference, not a plaintext secret.");

const safeMetaSchema = z.record(z.string().trim().min(1).max(64), z.union([
  z.string().max(160),
  z.number(),
  z.boolean(),
  z.null()
])).default({});

export const courierCredentialInputSchema = z.object({
  merchant_id: z.string().trim().min(1).optional(),
  mode: modeSchema.default("DRY_RUN" as CourierLiveReadinessMode),
  credential_ref: credentialRefSchema.optional(),
  required_fields_present: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  safe_meta: safeMetaSchema.optional(),
  notes: z.string().trim().max(500).optional()
}).strict();

export const courierCredentialQuerySchema = z.object({
  merchant_id: z.string().trim().min(1).optional(),
  mode: modeSchema.optional()
}).strict();

export const courierProbeInputSchema = z.object({
  probe_type: z.preprocess(
    (value) => String(value || "PINCODE_SERVICEABILITY").trim().toUpperCase(),
    z.enum([...courierLiveProbeTypes, ...forbiddenCourierLiveProbeTypes])
  ),
  mode: modeSchema.optional(),
  safe_context: safeMetaSchema.optional()
}).strict();

export const courierReadinessQuerySchema = z.object({
  merchant_id: z.string().trim().min(1).optional()
}).strict();

export function isAllowedProbeType(value: string): value is CourierLiveProbeType {
  return (courierLiveProbeTypes as readonly string[]).includes(value);
}

export type CourierCredentialInput = z.infer<typeof courierCredentialInputSchema>;
export type CourierCredentialQuery = z.infer<typeof courierCredentialQuerySchema>;
export type CourierProbeInput = z.infer<typeof courierProbeInputSchema>;
export type CourierReadinessQuery = z.infer<typeof courierReadinessQuerySchema>;

