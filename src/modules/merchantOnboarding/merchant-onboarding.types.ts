export const MERCHANT_STORE_ONBOARDING_STEPS = [
  "WELCOME",
  "CHOOSE_PLATFORM",
  "CONNECT_STORE",
  "ADD_CREDENTIALS",
  "TEST_CONNECTION",
  "FETCH_ORDERS",
  "REVIEW_RECONCILIATION",
  "CONVERT_ELIGIBLE",
  "OPEN_SHIPPING_WORKSPACE",
  "COMPLETE"
] as const;

export type MerchantStoreOnboardingStep = typeof MERCHANT_STORE_ONBOARDING_STEPS[number];

export type MerchantOnboardingMilestoneKey =
  | "store_connected"
  | "credentials_ready"
  | "first_fetch_completed"
  | "reconciliation_viewed"
  | "first_conversion_completed"
  | "shipping_workspace_ready";

export type MerchantOnboardingMilestone = {
  key: MerchantOnboardingMilestoneKey;
  label: string;
  complete: boolean;
};
