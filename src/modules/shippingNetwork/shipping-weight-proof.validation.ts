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
  contentType: z.enum(["image/jpeg", "image/png"]).default("image/jpeg"),
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

export const initWeightProofCaptureRouteSchema = z.object({
  shipment_id: z.string().trim().min(1).optional(),
  awb_number: awbNumberSchema,
  content_type: z.enum(["image/jpeg", "image/png"]).default("image/jpeg"),
  expected_byte_size: z.number().int().positive().optional(),
  device_id: z.string().trim().min(1).max(120).optional()
}).strict();

export const finalizeWeightProofCaptureRouteSchema = z.object({
  capture_session_id: z.string().trim().min(1),
  declared_weight_grams: z.number().int().positive(),
  length_cm: dimensionCmSchema,
  width_cm: dimensionCmSchema,
  height_cm: dimensionCmSchema,
  device_id: z.string().trim().min(1).max(120).optional(),
  captured_at: z.coerce.date().optional()
}).strict();

export const uploadWeightProofCaptureRouteSchema = z.object({
  capture_session_id: z.string().trim().min(1),
  awb_number: awbNumberSchema.optional()
}).strict();

export const weightProofAwbRouteParamSchema = z.object({
  awbNumber: awbNumberSchema
}).strict();

export type InitWeightProofCaptureRequest = z.infer<typeof initWeightProofCaptureSchema>;
export type FinalizeWeightProofCaptureRequest = z.infer<typeof finalizeWeightProofCaptureSchema>;
export type WeightProofDimensionsRequest = z.infer<typeof weightProofDimensionsSchema>;
export type WeightProofAwbParam = z.infer<typeof weightProofAwbParamSchema>;
export type InitWeightProofCaptureRouteRequest = z.infer<typeof initWeightProofCaptureRouteSchema>;
export type FinalizeWeightProofCaptureRouteRequest = z.infer<typeof finalizeWeightProofCaptureRouteSchema>;
export type UploadWeightProofCaptureRouteRequest = z.infer<typeof uploadWeightProofCaptureRouteSchema>;
