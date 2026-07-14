import { z } from "zod";

export const H2A_FIXTURE_KIND = "H2A_STAGING_CROSS_TENANT" as const;
export const H2A_FIXTURE_HEADER = "h2a-staging-tenant-v1" as const;
export const H2A_CREATE_CONFIRMATION = "CREATE H2A STAGING SYNTHETIC TENANT" as const;
export const H2A_CLEANUP_CONFIRMATION = "CLEAN H2A STAGING SYNTHETIC TENANT" as const;
export const H2A_MERCHANT_MARKER = "H2A STAGING SYNTHETIC TENANT B — DO NOT USE" as const;
export const H2A_CONNECTION_MARKER = "H2A STAGING SYNTHETIC CROSS-TENANT — DO NOT USE" as const;
export const H2A_STORE_URL = "https://h2a-tenant-b.example" as const;
export const H2A_ACTIVE_SLOT = "H2A_STAGING_TENANT_B" as const;

const syntheticEmail = /^h2a-tenant-b-[0-9]{8}T[0-9]{6}Z@shipmastr[.]invalid$/;

export const h2aCreateSchema = z.object({
  fixtureType: z.literal(H2A_FIXTURE_KIND),
  confirmation: z.literal(H2A_CREATE_CONFIRMATION),
  merchantName: z.literal(H2A_MERCHANT_MARKER),
  ownerName: z.literal("H2A Synthetic Tenant B Owner"),
  email: z.string().regex(syntheticEmail),
  storeUrl: z.literal(H2A_STORE_URL),
  password: z.string().min(24).max(128),
  expiresInMinutes: z.number().int().min(15).max(120).default(60)
}).strict();

export const h2aCleanupSchema = z.object({
  confirmation: z.literal(H2A_CLEANUP_CONFIRMATION)
}).strict();

export type H2ACreateInput = z.infer<typeof h2aCreateSchema>;

export function isH2ALifecycleHeader(value: string | undefined) {
  return value === H2A_FIXTURE_HEADER;
}
