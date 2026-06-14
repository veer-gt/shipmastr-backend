import { z } from "zod";

export const productionReadinessQuerySchema = z.object({
  include_plan: z.coerce.boolean().optional().default(true)
});

export type ProductionReadinessQueryInput = z.infer<typeof productionReadinessQuerySchema>;
