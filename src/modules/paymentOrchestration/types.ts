export type PaymentProvider = 'MOCK' | 'CASHFREE' | 'PAYTM';
export type ProviderEnvironment = 'TEST' | 'LIVE';
export type OutcomeStatus = 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED_TERMINAL' | 'NOT_FOUND_TERMINAL';
export type ReviewStatus = 'NOT_REQUIRED' | 'REQUIRED' | 'IN_PROGRESS' | 'COMPLETED';
export type ObligationStatus = 'OPEN' | 'SATISFIED' | 'EXPIRED' | 'CANCELLED';
export type ObligationPurpose = 'FULL_ONLINE' | 'COD_ADVANCE' | 'COD_DELIVERY_BALANCE';
export type CollectionRail = 'ONLINE' | 'COD';
export type RefundDueReason = 'LATE_SUCCESS_AFTER_CLOSURE' | 'SURPLUS_DOUBLE_SUCCESS';

export interface ProviderActivationPolicy {
  version: string;
  approved: boolean;
  merchantId: string;
  provider: PaymentProvider;
  environment: ProviderEnvironment;
  operation: 'CREATE_ATTEMPT' | 'STATUS_QUERY';
  maxAmountPaise: bigint;
}

export interface ActivationPolicyInput {
  merchantId: string;
  provider: PaymentProvider;
  environment: ProviderEnvironment;
  operation: ProviderActivationPolicy['operation'];
  amountPaise: bigint;
  policy?: ProviderActivationPolicy;
}

export type ActivationDecision =
  | { enabled: true; policyVersion: string }
  | { enabled: false; reason: 'POLICY_DISABLED' };
