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

export type UpsertConnectionCredentialInput = z.infer<typeof upsertConnectionCredentialSchema>;
export type RotateConnectionCredentialInput = z.infer<typeof rotateConnectionCredentialSchema>;
