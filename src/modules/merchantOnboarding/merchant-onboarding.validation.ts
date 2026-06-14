import { z } from "zod";
import { MERCHANT_STORE_ONBOARDING_STEPS } from "./merchant-onboarding.types.js";

export const merchantOnboardingStatePatchSchema = z.object({
  currentStep: z.enum(MERCHANT_STORE_ONBOARDING_STEPS).optional(),
  storeConnected: z.boolean().optional(),
  credentialsReady: z.boolean().optional(),
  firstFetchCompleted: z.boolean().optional(),
  reconciliationViewed: z.boolean().optional(),
  firstConversionCompleted: z.boolean().optional(),
  shippingWorkspaceReady: z.boolean().optional()
});

export const merchantOnboardingConnectionActionSchema = z.object({
  connectionId: z.string().trim().min(1)
});

export const merchantOnboardingFirstFetchSchema = z.object({
  connectionId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

export type MerchantOnboardingStatePatchInput = z.infer<typeof merchantOnboardingStatePatchSchema>;
export type MerchantOnboardingConnectionActionInput = z.infer<typeof merchantOnboardingConnectionActionSchema>;
export type MerchantOnboardingFirstFetchInput = z.infer<typeof merchantOnboardingFirstFetchSchema>;
