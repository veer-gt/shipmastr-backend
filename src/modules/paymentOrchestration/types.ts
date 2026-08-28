export type PaymentProvider = 'MOCK' | 'CASHFREE' | 'PAYTM';
export type ProviderEnvironment = 'TEST' | 'LIVE';
export type OutcomeStatus = 'PENDING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED_TERMINAL' | 'NOT_FOUND_TERMINAL';
export type ReviewStatus = 'NOT_REQUIRED' | 'REQUIRED' | 'IN_PROGRESS' | 'COMPLETED';
export type ObligationStatus = 'OPEN' | 'SATISFIED' | 'EXPIRED' | 'CANCELLED';
export type ObligationPurpose = 'FULL_ONLINE' | 'COD_ADVANCE' | 'COD_DELIVERY_BALANCE';
export type CollectionRail = 'ONLINE' | 'COD';
export type RefundDueReason = 'LATE_SUCCESS_AFTER_CLOSURE' | 'SURPLUS_DOUBLE_SUCCESS';
export type CanonicalObservationSource = 'WEBHOOK' | 'STATUS_QUERY' | 'PROVIDER_RECORD' | 'MOCK';
export type SignatureVerification = 'VERIFIED' | 'FAILED' | 'NOT_APPLICABLE' | 'UNAVAILABLE';
export type BindingVerification = 'VERIFIED' | 'FAILED';
export type EvidenceAuthority = 'ELIGIBLE' | 'ACTIVATION_GATED' | 'INELIGIBLE';
export type MatchFailureReason =
  | 'MERCHANT_MISMATCH'
  | 'PROVIDER_MISMATCH'
  | 'ENVIRONMENT_MISMATCH'
  | 'CREDENTIAL_BINDING_MISMATCH'
  | 'UNAUTHENTICATED'
  | 'EVIDENCE_NOT_AUTHORIZED'
  | 'ORDER_REFERENCE_MISMATCH'
  | 'MISSING_TRANSACTION_REFERENCE'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'UNMAPPED_STATUS'
  | 'MAPPING_VERSION_MISMATCH'
  | 'INTERNAL_REFERENCE_MISMATCH'
  | 'IDEMPOTENCY_KEY_MISMATCH';
export type ReductionFactType = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'REFUND_DUE_DETECTED';
export type ReductionAttentionType =
  | 'INTEGRITY_CONFLICT'
  | 'CONTRADICTORY_EVIDENCE'
  | 'DOUBLE_SUCCESS_DETECTED'
  | 'MAPPING_GAP';
export type RelatedAttemptAction = 'KEEP_UNRESOLVED_LOCKED' | 'PRESERVE_TERMINAL';

export interface RefundDueEntry {
  providerTransactionRef: string;
  reason: RefundDueReason;
  sourceAttemptId: string;
  sourceObservationId: string;
  provider: PaymentProvider;
}

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

export interface CanonicalObservation {
  id: string;
  attemptId: string;
  obligationId: string;
  merchantId: string;
  provider: PaymentProvider;
  environment: ProviderEnvironment;
  credentialBindingId: string;
  credentialVersionId: string;
  source: CanonicalObservationSource;
  providerEventId: string | null;
  providerOrderRef: string;
  providerTransactionRef: string | null;
  nativeStatus: string;
  nativeReasonCode: string | null;
  amountPaise: bigint | null;
  nativeAmountText: string | null;
  nativeCurrency: string | null;
  rawBodyHash: string;
  hashAlgorithm: 'SHA-256';
  signatureVerification: SignatureVerification;
  bindingVerification: BindingVerification;
  evidenceAuthority: EvidenceAuthority;
  mappedOutcome: OutcomeStatus | 'UNMAPPED';
  adapterVersion: string;
  mappingVersion: string;
  providerApiVersion: string;
  providerOccurredAt: Date | null;
  receivedAt: Date;
  reductionDisposition: string;
}

export type ObservationCandidate = CanonicalObservation;

export interface IngestionResult {
  observationId: string;
  disposition: string;
  outcomeStatus: OutcomeStatus;
  reviewStatus: ReviewStatus;
  resolvedAt: Date | null;
}

export interface ReductionPlan {
  attemptId: string;
  outcomeStatus: OutcomeStatus;
  resolved: boolean;
  satisfyObligation: boolean;
  reviewStatus: ReviewStatus;
  completedByType: 'SYSTEM' | null;
  disposition: string;
  factTypes: ReductionFactType[];
  refundDue: RefundDueEntry[];
  attention: Array<{ type: ReductionAttentionType }>;
  relatedAttemptActions: Array<{ attemptId: string; action: RelatedAttemptAction }>;
}

export type ShadowMutationCategory =
  | 'journal'
  | 'wallet'
  | 'settlement'
  | 'payout'
  | 'refund'
  | 'custody';

export interface ShadowMutationBoundary {
  assertNoMutationAuthority(input: {
    merchantId: string;
    obligationId: string;
    attemptId: string;
    categories: readonly ShadowMutationCategory[];
  }): void | Promise<void>;
}

export interface MatchInput {
  observation: CanonicalObservation;
  obligation: {
    id: string;
    merchantId: string;
    amountPaise: bigint;
    currency: 'INR';
    status: ObligationStatus;
  };
  attempt: {
    id: string;
    obligationId: string;
    merchantId: string;
    provider: PaymentProvider;
    environment: ProviderEnvironment;
    credentialBindingId: string;
    providerOrderRef: string | null;
    requestIdempotencyKey: string;
    adapterVersion: string;
    mappingVersion: string;
  };
  returnedIdempotencyKey?: string | null;
}

export type MatchResult =
  | { matched: true }
  | {
      matched: false;
      reason: MatchFailureReason;
    };

export interface ReduceEvidenceInput {
  obligation: MatchInput['obligation'];
  targetAttemptId: string;
  attempts: Array<
    MatchInput['attempt'] & {
      outcomeStatus: OutcomeStatus;
      reviewStatus: ReviewStatus;
      resolvedAt: Date | null;
    }
  >;
  observations: CanonicalObservation[];
}

export interface ReductionPersistenceContext {
  obligation: ReduceEvidenceInput['obligation'] & {
    collectionRail: CollectionRail;
    satisfiedAt: Date | null;
  };
  attempts: Array<
    ReduceEvidenceInput['attempts'][number] & {
      credentialVersionId: string;
      lastObservationAt: Date | null;
      lastOutcomeChangedAt: Date;
      createdAt: Date;
    }
  >;
  targetAttempt: ReductionPersistenceContext['attempts'][number];
  observations: CanonicalObservation[];
  triggeringObservation: CanonicalObservation;
  mutationBoundary?: ShadowMutationBoundary | undefined;
}
