import { z } from "zod";

import {
  partnerLeadConsentStatuses,
  partnerLeadManageableConsentStatuses,
  partnerLeadRoutingStatuses
} from "./partner-routing.types.js";

const optionalId = z.string().trim().min(1).max(160).optional().nullable();
const optionalLongString = z.string().trim().max(2000).optional().nullable();
const jsonObject = z.record(z.string(), z.unknown()).optional().nullable();

function hasValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

export const createPartnerLeadConsentSchema = z.object({
  partnerId: optionalId,
  merchantId: z.string().trim().min(1).max(160),
  sellerId: optionalId,
  consentStatus: z.enum(partnerLeadConsentStatuses).default("GRANTED"),
  consentScope: z.record(z.string(), z.unknown()).default({ scope: "partner_lead_routing_simulation" }),
  consentText: z.string().trim().min(12).max(2000),
  grantedAt: z.coerce.date().optional().nullable(),
  revokedAt: z.coerce.date().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  metadata: jsonObject
}).superRefine((value, ctx) => {
  if (value.expiresAt && value.grantedAt && value.expiresAt <= value.grantedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after grantedAt"
    });
  }
});

export const listPartnerLeadConsentsQuerySchema = z.object({
  partnerId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  consentStatus: z.enum(partnerLeadConsentStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const updatePartnerLeadConsentStatusSchema = z.object({
  consentStatus: z.enum(partnerLeadManageableConsentStatuses),
  consentText: optionalLongString,
  consentScope: jsonObject,
  grantedAt: z.coerce.date().optional().nullable(),
  revokedAt: z.coerce.date().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  metadata: jsonObject
});

export const createPartnerLeadRoutingIntentSchema = z.object({
  partnerId: optionalId,
  leadId: optionalId,
  consentId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  routingSnapshot: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable()
}).superRefine((value, ctx) => {
  if (!hasValue(value.partnerId) && !hasValue(value.leadId)) {
    ctx.addIssue({
      code: "custom",
      path: ["partnerId"],
      message: "partnerId or leadId is required for simulated routing intents"
    });
  }
});

export const listPartnerLeadRoutingIntentsQuerySchema = z.object({
  partnerId: optionalId,
  leadId: optionalId,
  consentId: optionalId,
  merchantId: optionalId,
  sellerId: optionalId,
  routingStatus: z.enum(partnerLeadRoutingStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});

export const simulatePartnerLeadRoutingSchema = z.object({
  routingSnapshot: jsonObject
});

export const consentIdParamsSchema = z.object({
  consentId: z.string().trim().min(1).max(160)
});

export const routingIntentIdParamsSchema = z.object({
  intentId: z.string().trim().min(1).max(160)
});

export type CreatePartnerLeadConsentInput = z.infer<typeof createPartnerLeadConsentSchema>;
export type ListPartnerLeadConsentsQueryInput = z.infer<typeof listPartnerLeadConsentsQuerySchema>;
export type UpdatePartnerLeadConsentStatusInput = z.infer<typeof updatePartnerLeadConsentStatusSchema>;
export type CreatePartnerLeadRoutingIntentInput = z.infer<typeof createPartnerLeadRoutingIntentSchema>;
export type ListPartnerLeadRoutingIntentsQueryInput = z.infer<typeof listPartnerLeadRoutingIntentsQuerySchema>;
export type SimulatePartnerLeadRoutingInput = z.infer<typeof simulatePartnerLeadRoutingSchema>;
