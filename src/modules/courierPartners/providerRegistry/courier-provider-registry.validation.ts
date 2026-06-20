import { z } from "zod";
import {
  courierProviderCapabilities,
  courierProviderCodes,
  courierProviderLaneCodes,
  courierProviderLaneStatuses,
  courierProviderRuntimeModes,
  type CourierProviderCapability,
  type CourierProviderCode,
  type CourierProviderLaneCode
} from "./courier-provider-registry.types.js";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function parseCourierProviderLaneCode(value: string | string[] | undefined): CourierProviderLaneCode | null {
  const normalized = firstParam(value).trim().toUpperCase();
  return courierProviderLaneCodes.includes(normalized as CourierProviderLaneCode)
    ? normalized as CourierProviderLaneCode
    : null;
}

export function parseCourierProviderCapability(value: string | string[] | undefined): CourierProviderCapability | null {
  const normalized = firstParam(value).trim().toUpperCase();
  return courierProviderCapabilities.includes(normalized as CourierProviderCapability)
    ? normalized as CourierProviderCapability
    : null;
}

export function parseCourierProviderCode(value: string | undefined): CourierProviderCode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  return courierProviderCodes.includes(normalized as CourierProviderCode)
    ? normalized as CourierProviderCode
    : undefined;
}

export const courierProviderLaneListQuerySchema = z.object({
  provider_code: z.string().trim().min(1).max(40).optional().transform(parseCourierProviderCode),
  status: z.enum(courierProviderLaneStatuses).optional(),
  mode: z.enum(courierProviderRuntimeModes).optional(),
  capability: z.enum(courierProviderCapabilities).optional()
});

export const courierProviderWorkflowGuardSchema = z.object({
  merchant_id: z.string().trim().min(1).max(120).optional(),
  capability: z.enum(courierProviderCapabilities),
  mode: z.enum(courierProviderRuntimeModes).optional().default("LIVE")
});

export const courierProviderReadinessQuerySchema = z.object({
  merchant_id: z.string().trim().min(1).max(120).optional(),
  provider_code: z.string().trim().min(1).max(40).optional().transform(parseCourierProviderCode),
  status: z.enum(courierProviderLaneStatuses).optional(),
  mode: z.enum(courierProviderRuntimeModes).optional().default("LIVE"),
  capability: z.enum(courierProviderCapabilities).optional()
});
