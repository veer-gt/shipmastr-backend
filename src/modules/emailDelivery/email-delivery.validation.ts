import { z } from "zod";

export const listEmailDeliveryAttemptsQuerySchema = z.object({
  status: z.enum(["BLOCKED", "SANDBOX_RECORDED", "FAILED", "SKIPPED"]).optional(),
  notification_id: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20)
});

export const sandboxEmailRequestSchema = z.object({
  recipient_email: z.string().trim().email().max(320).optional(),
  subject: z.string().trim().min(1).max(160).optional()
});

export type ListEmailDeliveryAttemptsQueryInput = z.infer<typeof listEmailDeliveryAttemptsQuerySchema>;
export type SandboxEmailRequestInput = z.infer<typeof sandboxEmailRequestSchema>;
