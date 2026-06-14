import type { MerchantOnboardingState } from "@prisma/client";
import type { MerchantOnboardingMilestone, MerchantStoreOnboardingStep } from "./merchant-onboarding.types.js";

function timestamp(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeMerchantOnboardingState(
  record: MerchantOnboardingState,
  input: {
    currentStep: MerchantStoreOnboardingStep;
    progressPercent: number;
    milestones: MerchantOnboardingMilestone[];
    nextActions: string[];
  }
) {
  return {
    onboarding_state_id: record.id,
    merchant_id: record.merchantId,
    current_step: input.currentStep,
    progress_percent: input.progressPercent,
    milestones: input.milestones,
    store_connected: record.storeConnected,
    credentials_ready: record.credentialsReady,
    first_fetch_completed: record.firstFetchCompleted,
    reconciliation_viewed: record.reconciliationViewed,
    first_conversion_completed: record.firstConversionCompleted,
    shipping_workspace_ready: record.shippingWorkspaceReady,
    completed_at: timestamp(record.completedAt),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt),
    next_actions: input.nextActions,
    safety: {
      read_only_import: true,
      creates_shipments: false,
      creates_awb: false,
      creates_labels: false,
      updates_store: false
    }
  };
}
