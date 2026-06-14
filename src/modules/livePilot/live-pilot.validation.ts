import { z } from "zod";
import { LIVE_PILOT_CAPABILITIES } from "./live-pilot.types.js";

export const livePilotMerchantActionSchema = z.object({
  notes: z.string().trim().max(500).optional(),
  actorId: z.string().trim().max(120).optional()
});

export const livePilotCapabilityActionSchema = z.object({
  notes: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(500).optional(),
  actorId: z.string().trim().max(120).optional()
});

export const livePilotAuditLogQuerySchema = z.object({
  merchantId: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
});

export function parseLivePilotCapability(value: string) {
  const normalized = String(value || "").trim().toUpperCase();
  const parsed = z.enum(LIVE_PILOT_CAPABILITIES).safeParse(normalized);
  if (!parsed.success) return null;
  return parsed.data;
}

export type LivePilotMerchantActionInput = z.infer<typeof livePilotMerchantActionSchema>;
export type LivePilotCapabilityActionInput = z.infer<typeof livePilotCapabilityActionSchema>;
export type LivePilotAuditLogQueryInput = z.infer<typeof livePilotAuditLogQuerySchema>;
