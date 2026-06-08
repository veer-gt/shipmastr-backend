import { z } from "zod";

export const platformHealthCheckQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  per_page: z.coerce.number().int().positive().max(100).default(20)
});

export type PlatformHealthCheckQueryInput = z.infer<typeof platformHealthCheckQuerySchema>;
