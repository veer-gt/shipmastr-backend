import type {
  IngestionResult,
  ObservationCandidate,
  PaymentProvider,
} from '../types.js';

export interface ObservationParser {
  readonly provider: PaymentProvider;
  readonly adapterVersion: string;
  readonly mappingVersion: string;
  readonly providerApiVersion: string;
  parse(input: RawObservationInput): ParsedObservationFields;
}

export type ParsedObservationFields = Omit<
  ObservationCandidate,
  | 'id'
  | 'attemptId'
  | 'obligationId'
  | 'merchantId'
  | 'credentialBindingId'
  | 'credentialVersionId'
  | 'rawBodyHash'
  | 'hashAlgorithm'
  | 'signatureVerification'
  | 'bindingVerification'
  | 'receivedAt'
  | 'reductionDisposition'
>;

export interface MockExecutableAdapter extends ObservationParser {
  readonly provider: 'MOCK';
  create(input: MockCreateInput): Promise<RawObservationInput>;
  queryStatus(input: MockStatusQueryInput): Promise<RawObservationInput>;
}

export interface RawObservationInput {
  rawBody: Buffer;
  headers: Readonly<Record<string, string>>;
  receivedAt: Date;
}

export interface MockCreateInput {
  attemptId: string;
  obligationId: string;
  merchantId: string;
  amountPaise: bigint;
  currency: 'INR';
  scenario: 'SUCCESS' | 'TERMINAL_FAILURE' | 'TIMEOUT' | 'PENDING' | 'UNKNOWN' | 'INTEGRITY_CONFLICT';
  delivery?: number;
}

export type MockStatusQueryInput = MockCreateInput & { querySequence: number };

export type ReconciliationResult =
  | { kind: 'POLICY_DISABLED' }
  | { kind: 'NOT_DUE' }
  | { kind: 'OBSERVATION_INGESTED'; observationId: string }
  | { kind: 'QUERY_BLOCKED'; reason: string };

export type RawRetentionDecision = 'MOCK_SYNTHETIC' | 'NO_RETENTION_APPROVED' | 'UNAPPROVED';
export type ProviderIngestionMode = 'MOCK_EXECUTABLE' | 'CONTRACT_FIXTURE_ONLY';

export interface RawIngestionDeps {
  parser: ObservationParser;
  environment: ObservationCandidate['environment'];
  source: ObservationCandidate['source'];
  securityContext?: {
    merchantId: string;
    obligationId: string;
    attemptId: string;
    credentialBindingId: string;
  };
  ingestionMode: ProviderIngestionMode;
  retentionDecision: RawRetentionDecision;
  nextObservationId(): string;
  resolveBinding(parsed: ParsedObservationFields): Promise<{
    attemptId: string;
    obligationId: string;
    merchantId: string;
    credentialBindingId: string;
    credentialVersionId: string;
    bindingVerification: 'VERIFIED' | 'FAILED';
  }>;
  verify(input: RawObservationInput): Promise<'VERIFIED' | 'FAILED' | 'NOT_APPLICABLE' | 'UNAVAILABLE'>;
  persist(candidate: ObservationCandidate): Promise<IngestionResult>;
  persistSecurityRejection(evidence: ProviderSecurityRejectionEvidence): Promise<void>;
}

export interface ProviderSecurityRejectionEvidence {
  provider: PaymentProvider;
  environment: ObservationCandidate['environment'];
  source: ObservationCandidate['source'];
  reason: 'UNAUTHENTICATED' | 'BINDING_MISMATCH';
  rawBodyHash: string;
  hashAlgorithm: 'SHA-256';
  signatureVerification: 'FAILED' | 'UNAVAILABLE' | 'VERIFIED' | 'NOT_APPLICABLE';
  bindingVerification: 'FAILED' | null;
  merchantId: string | null;
  obligationId: string | null;
  attemptId: string | null;
  credentialBindingId: string | null;
  adapterVersion: string;
  mappingVersion: string;
  providerApiVersion: string;
  detectedAt: Date;
  securityAlertCode: 'INVALID_PROVIDER_SIGNATURE' | 'PROVIDER_BINDING_MISMATCH';
}

export type RawIngestionRejection = {
  kind: 'REJECTED';
  reason: 'INGESTION_DISABLED' | 'UNAUTHENTICATED' | 'BINDING_MISMATCH' | 'MALFORMED';
};
