import { createHash } from 'node:crypto';
import type {
  RawIngestionDeps,
  RawIngestionRejection,
  RawObservationInput,
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
  const signatureVerification = await deps.verify(input);
  if (signatureVerification === 'FAILED' || signatureVerification === 'UNAVAILABLE') {
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
    return rejected('BINDING_MISMATCH');
  }

  const candidate: ObservationCandidate = {
    ...parsed,
    ...binding,
    id: deps.nextObservationId(),
    rawBodyHash,
    hashAlgorithm: 'SHA-256',
    signatureVerification,
    receivedAt: input.receivedAt,
    reductionDisposition: 'UNREDUCED',
  };

  return deps.persist(candidate);
}

function rejected(reason: RawIngestionRejection['reason']): RawIngestionRejection {
  return {
    kind: 'REJECTED',
    reason,
  };
}
