import { z } from "zod";
import { courierArbitrationCapabilities } from "../arbitration/courier-arbitration.types.js";
import {
  certifiedProviderRoutingOutcomes,
  certifiedProviderRoutingPublicTiers
} from "./certified-provider-routing.types.js";

const requestedCapabilitySchema = z.preprocess(
  (value) => String(value || "AWB").trim().toUpperCase(),
  z.enum(courierArbitrationCapabilities)
);

const requestedOutcomeSchema = z.preprocess(
  (value) => String(value || "DEFAULT_SMART").trim().toUpperCase(),
  z.enum(certifiedProviderRoutingOutcomes)
);

const publicTierSchema = z.preprocess(
  (value) => String(value || "").trim().toLowerCase(),
  z.enum(certifiedProviderRoutingPublicTiers)
);

export const certifiedProviderRoutingQuerySchema = z.object({
  requested_capability: requestedCapabilitySchema.optional().default("AWB"),
  requested_outcome: requestedOutcomeSchema.optional().default("DEFAULT_SMART"),
  pickup_location_id: z.string().trim().min(1).max(120).optional(),
  preferred_public_tier: publicTierSchema.optional()
}).strict();

export const certifiedProviderRoutingBodySchema = z.object({
  requested_capability: requestedCapabilitySchema.optional().default("AWB"),
  requested_outcome: requestedOutcomeSchema.optional().default("DEFAULT_SMART"),
  pickup_location_id: z.string().trim().min(1).max(120).optional(),
  preferred_public_tier: publicTierSchema.optional()
}).strict();

export type CertifiedProviderRoutingQuery = z.infer<typeof certifiedProviderRoutingQuerySchema>;
export type CertifiedProviderRoutingBody = z.infer<typeof certifiedProviderRoutingBodySchema>;
