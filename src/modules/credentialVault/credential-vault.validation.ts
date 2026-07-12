import { z } from "zod";
import { platformCredentialTypeSchema } from "../platformIntegrations/credentials/platform-credentials.validation.js";

const credentialsSchema = z.record(z.string(), z.unknown());

export const upsertConnectionCredentialSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  credentialType: platformCredentialTypeSchema.optional(),
  credentials: credentialsSchema,
  expiresAt: z.string().datetime().nullable().optional()
}).strict();

export const rotateConnectionCredentialSchema = z.object({
  credentials: credentialsSchema,
  expiresAt: z.string().datetime().nullable().optional()
}).strict();

export const testConnectionCredentialReadinessSchema = z.object({}).strict();

export const platformWebhookCredentialPlatformSchema = z.enum(["SHOPIFY", "WOOCOMMERCE", "MAGENTO"]);

export const configurePlatformWebhookCredentialSchema = z.object({
  platform: platformWebhookCredentialPlatformSchema,
  secret: z.string().min(16).max(4096)
}).strict();

export const rotatePlatformWebhookCredentialSchema = z.object({
  replacementSecret: z.string().min(16).max(4096),
  gracePeriodSeconds: z.coerce.number().int().min(0).max(7 * 24 * 60 * 60).default(24 * 60 * 60)
}).strict();

export type UpsertConnectionCredentialInput = z.infer<typeof upsertConnectionCredentialSchema>;
export type RotateConnectionCredentialInput = z.infer<typeof rotateConnectionCredentialSchema>;
export type ConfigurePlatformWebhookCredentialInput = z.infer<typeof configurePlatformWebhookCredentialSchema>;
export type RotatePlatformWebhookCredentialInput = z.infer<typeof rotatePlatformWebhookCredentialSchema>;
