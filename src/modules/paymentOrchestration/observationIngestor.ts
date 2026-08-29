import { createHash } from 'node:crypto';
import type {
  RawIngestionDeps,
  RawIngestionRejection,
  RawObservationInput,
  ProviderSecurityRejectionEvidence,
} from './adapters/providerAdapter.js';
import type { IngestionResult, ObservationCandidate } from './types.js';

export async function ingestRawObservation(
  deps: RawIngestionDeps,
  input: RawObservationInput,
): Promise<IngestionResult | RawIngestionRejection> {
  if (
    deps.parser.provider !== 'MOCK' ||
    deps.ingestionMode !== 'MOCK_EXECUTABLE' ||
    deps.retentionDecision !== 'MOCK_SYNTHETIC'
  ) {
    return rejected('INGESTION_DISABLED');
  }

  const rawBodyHash = createHash('sha256').update(input.rawBody).digest('hex');
  const signatureVerification = normalizeVerification(await deps.verify(input));
  const trustedSource = requireTrustedSource(deps);
  if (!isAcceptedVerificationForSource(signatureVerification, trustedSource)) {
    await persistSecurityRejection(deps, {
      provider: deps.parser.provider,
      environment: requireTrustedEnvironment(deps),
      source: trustedSource,
      reason: 'UNAUTHENTICATED',
      rawBodyHash,
      hashAlgorithm: 'SHA-256',
      signatureVerification,
      bindingVerification: null,
      merchantId: deps.securityContext?.merchantId ?? null,
      obligationId: deps.securityContext?.obligationId ?? null,
      attemptId: deps.securityContext?.attemptId ?? null,
      credentialBindingId: deps.securityContext?.credentialBindingId ?? null,
      adapterVersion: deps.parser.adapterVersion,
      mappingVersion: deps.parser.mappingVersion,
      providerApiVersion: deps.parser.providerApiVersion,
      detectedAt: input.receivedAt,
      securityAlertCode: 'INVALID_PROVIDER_SIGNATURE',
    });
    return rejected('UNAUTHENTICATED');
  }

  let parsed;
  try {
    parsed = deps.parser.parse(input);
  } catch {
    return rejected('MALFORMED');
  }

  let binding;
  try {
    binding = await deps.resolveBinding(parsed);
  } catch {
    return rejected('MALFORMED');
  }

  if (binding.bindingVerification === 'FAILED') {
    const trustedSecurityContext = trustedBindingMismatchContext(deps, binding);
    await persistSecurityRejection(deps, {
      provider: deps.parser.provider,
      environment: requireTrustedEnvironment(deps),
      source: requireTrustedSource(deps),
      reason: 'BINDING_MISMATCH',
      rawBodyHash,
      hashAlgorithm: 'SHA-256',
      signatureVerification,
      bindingVerification: 'FAILED',
      merchantId: trustedSecurityContext?.merchantId ?? null,
      obligationId: trustedSecurityContext?.obligationId ?? null,
      attemptId: trustedSecurityContext?.attemptId ?? null,
      credentialBindingId: trustedSecurityContext?.credentialBindingId ?? null,
      adapterVersion: deps.parser.adapterVersion,
      mappingVersion: deps.parser.mappingVersion,
      providerApiVersion: deps.parser.providerApiVersion,
      detectedAt: input.receivedAt,
      securityAlertCode: 'PROVIDER_BINDING_MISMATCH',
    });
    return rejected('BINDING_MISMATCH');
  }

  const candidate: ObservationCandidate = {
    ...parsed,
    ...binding,
    id: deps.nextObservationId(),
    rawBodyHash,
    hashAlgorithm: 'SHA-256',
    signatureVerification,
    adapterVersion: deps.parser.adapterVersion,
    mappingVersion: deps.parser.mappingVersion,
    providerApiVersion: deps.parser.providerApiVersion,
    receivedAt: input.receivedAt,
    reductionDisposition: 'UNREDUCED',
  };

  return deps.persist(candidate);
}

async function persistSecurityRejection(
  deps: RawIngestionDeps,
  evidence: ProviderSecurityRejectionEvidence,
) {
  if (!deps.persistSecurityRejection) {
    throw new Error('SECURITY_REJECTION_PERSISTENCE_UNAVAILABLE');
  }
  await deps.persistSecurityRejection(Object.freeze({ ...evidence }));
}

function requireTrustedEnvironment(deps: RawIngestionDeps) {
  if (!deps.environment) throw new Error('SECURITY_REJECTION_ENVIRONMENT_UNAVAILABLE');
  return deps.environment;
}

function requireTrustedSource(deps: RawIngestionDeps) {
  if (!deps.source) throw new Error('SECURITY_REJECTION_SOURCE_UNAVAILABLE');
  return deps.source;
}

function rejected(reason: RawIngestionRejection['reason']): RawIngestionRejection {
  return {
    kind: 'REJECTED',
    reason,
  };
}

function trustedBindingMismatchContext(
  deps: RawIngestionDeps,
  binding: Awaited<ReturnType<RawIngestionDeps['resolveBinding']>>,
) {
  const securityContext = deps.securityContext;
  if (!securityContext) {
    return null;
  }

  return securityContext.attemptId === binding.attemptId &&
      securityContext.obligationId === binding.obligationId &&
      securityContext.merchantId === binding.merchantId &&
      securityContext.credentialBindingId === binding.credentialBindingId
    ? securityContext
    : null;
}

function normalizeVerification(value: unknown): ProviderSecurityRejectionEvidence['signatureVerification'] {
  if (
    value === 'VERIFIED' ||
    value === 'FAILED' ||
    value === 'NOT_APPLICABLE' ||
    value === 'UNAVAILABLE'
  ) {
    return value;
  }
  return 'UNAVAILABLE';
}

function isAcceptedVerificationForSource(
  signatureVerification: ProviderSecurityRejectionEvidence['signatureVerification'],
  source: RawIngestionDeps['source'],
) {
  switch (source) {
    case 'WEBHOOK':
      return signatureVerification === 'VERIFIED';
    case 'STATUS_QUERY':
    case 'PROVIDER_RECORD':
    case 'MOCK':
      return signatureVerification === 'NOT_APPLICABLE';
  }
}
