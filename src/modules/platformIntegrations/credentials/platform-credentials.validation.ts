import { z } from "zod";

export const platformCredentialProviderSchema = z.enum(["SHOPIFY", "WOOCOMMERCE", "MAGENTO", "CUSTOM"]);
export const platformCredentialTypeSchema = z.enum([
  "SHOPIFY_CUSTOM_APP_TOKEN",
  "SHOPIFY_OAUTH_PLACEHOLDER",
  "WOOCOMMERCE_REST_KEYS",
  "MAGENTO_INTEGRATION_TOKEN",
  "CUSTOM_API_KEY",
  "WEBHOOK_SECRET"
]);
export const platformCredentialStatusSchema = z.enum(["ACTIVE", "REVOKED", "ROTATED", "EXPIRED"]);

const credentialsSchema = z.record(z.string(), z.unknown());

export const createPlatformCredentialSchema = z.object({
  platform: platformCredentialProviderSchema,
  credentialType: platformCredentialTypeSchema,
  name: z.string().trim().min(1).max(160),
  credentials: credentialsSchema,
  expiresAt: z.string().datetime().nullable().optional()
}).strict();

export const rotatePlatformCredentialSchema = z.object({
  credentials: credentialsSchema,
  expiresAt: z.string().datetime().nullable().optional()
}).strict();

export const listPlatformCredentialsQuerySchema = z.object({
  platform: platformCredentialProviderSchema.optional(),
  status: platformCredentialStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
}).strict();

export const validateCredentialShapeSchema = z.object({
  platform: platformCredentialProviderSchema,
  credentialType: platformCredentialTypeSchema,
  credentials: credentialsSchema
}).strict();

export type CreatePlatformCredentialInput = z.infer<typeof createPlatformCredentialSchema>;
export type RotatePlatformCredentialInput = z.infer<typeof rotatePlatformCredentialSchema>;
export type ListPlatformCredentialsQueryInput = z.infer<typeof listPlatformCredentialsQuerySchema>;
export type ValidateCredentialShapeInput = z.infer<typeof validateCredentialShapeSchema>;
