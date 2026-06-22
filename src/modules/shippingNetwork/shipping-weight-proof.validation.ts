import { z } from "zod";

const awbNumberSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "AWB may contain only letters, numbers, underscore, and hyphen.");

const dimensionCmSchema = z.number().finite().nonnegative();

export const weightProofDimensionsSchema = z.object({
  lengthCm: dimensionCmSchema,
  widthCm: dimensionCmSchema,
  heightCm: dimensionCmSchema
}).strict();

export const initWeightProofCaptureSchema = z.object({
  awbNumber: awbNumberSchema,
  shipmentId: z.string().trim().min(1).optional(),
  contentType: z.literal("image/jpeg").default("image/jpeg"),
  expectedByteSize: z.number().int().positive().optional(),
  deviceId: z.string().trim().min(1).max(120).optional()
}).strict();

export const finalizeWeightProofCaptureSchema = z.object({
  captureSessionId: z.string().trim().min(1),
  awbNumber: awbNumberSchema,
  declaredWeightGrams: z.number().int().positive(),
  dimensions: weightProofDimensionsSchema,
  deviceId: z.string().trim().min(1).max(120).optional(),
  capturedAt: z.coerce.date().optional()
}).strict();

export const weightProofAwbParamSchema = z.object({
  awbNumber: awbNumberSchema
}).strict();

export type InitWeightProofCaptureRequest = z.infer<typeof initWeightProofCaptureSchema>;
export type FinalizeWeightProofCaptureRequest = z.infer<typeof finalizeWeightProofCaptureSchema>;
export type WeightProofDimensionsRequest = z.infer<typeof weightProofDimensionsSchema>;
export type WeightProofAwbParam = z.infer<typeof weightProofAwbParamSchema>;
