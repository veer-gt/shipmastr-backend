import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { ingestRawObservation } from '../observationIngestor.js';
import type {
  ObservationParser,
  ParsedObservationFields,
  RawIngestionDeps,
  RawObservationInput,
} from '../adapters/providerAdapter.js';
import type { IngestionResult, ObservationCandidate } from '../types.js';

function rawInput(overrides: Partial<RawObservationInput> = {}): RawObservationInput {
  return {
    rawBody: Buffer.from('{"order":"o_1"}\n', 'utf8'),
    headers: {},
    receivedAt: new Date('2026-08-28T00:00:00.000Z'),
    ...overrides,
  };
}

function parsedObservation(
  overrides: Partial<ParsedObservationFields> = {},
): ParsedObservationFields {
  return {
    provider: 'MOCK',
    environment: 'TEST',
    source: 'MOCK',
    providerEventId: 'mock_event_1',
    providerOrderRef: 'mock_order_1',
    providerTransactionRef: 'mock_txn_1',
    nativeStatus: 'captured',
    nativeReasonCode: null,
    amountPaise: 10_000n,
    nativeAmountText: '100.00',
    nativeCurrency: 'INR',
    evidenceAuthority: 'ELIGIBLE',
    mappedOutcome: 'SUCCEEDED',
    adapterVersion: 'mock-adapter-v1',
    mappingVersion: 'mock-mapping-v1',
    providerApiVersion: 'mock-2026-08-28',
    providerOccurredAt: new Date('2026-08-28T00:00:00.000Z'),
    ...overrides,
  };
}

function mockParserStub(
  overrides: Partial<ParsedObservationFields> = {},
): ObservationParser {
  return {
    provider: 'MOCK',
    adapterVersion: 'mock-adapter-v1',
    mappingVersion: 'mock-mapping-v1',
    providerApiVersion: 'mock-2026-08-28',
    parse() {
      return parsedObservation(overrides);
    },
  };
}

function cashfreeParserStub(): ObservationParser {
  return {
    provider: 'CASHFREE',
    adapterVersion: 'cashfree-adapter-fixture-v1',
    mappingVersion: 'cashfree-mapping-fixture-v1',
    providerApiVersion: 'cashfree-webhook-contract-2026-08-28',
    parse() {
      return parsedObservation({
        provider: 'CASHFREE',
        source: 'WEBHOOK',
      });
    },
  };
}

function captureLoggerOutput() {
  let output = '';
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return stdoutWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return stderrWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;

  return {
    output: () => output,
    restore() {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
  };
}

function deps(
  overrides: Partial<RawIngestionDeps> = {},
): {
  deps: RawIngestionDeps;
  calls: {
    verify: Array<[RawObservationInput]>;
    resolveBinding: Array<[ParsedObservationFields]>;
    persist: Array<[ObservationCandidate]>;
    securityRejections: Array<[Parameters<NonNullable<RawIngestionDeps['persistSecurityRejection']>>[0]]>;
  };
} {
  const calls = {
    verify: [] as Array<[RawObservationInput]>,
    resolveBinding: [] as Array<[ParsedObservationFields]>,
    persist: [] as Array<[ObservationCandidate]>,
    securityRejections: [] as Array<[Parameters<NonNullable<RawIngestionDeps['persistSecurityRejection']>>[0]]>,
  };
  const result: IngestionResult = {
    observationId: 'observation_1',
    disposition: 'SUCCEEDED',
    outcomeStatus: 'SUCCEEDED',
    reviewStatus: 'NOT_REQUIRED',
    resolvedAt: new Date('2026-08-28T00:00:00.000Z'),
  };
  const defaultDeps: RawIngestionDeps = {
    parser: mockParserStub(),
    ingestionMode: 'MOCK_EXECUTABLE',
    retentionDecision: 'MOCK_SYNTHETIC',
    environment: 'TEST',
    source: 'MOCK',
    securityContext: {
      merchantId: 'merchant_1',
      obligationId: 'obligation_1',
      attemptId: 'attempt_1',
      credentialBindingId: 'binding_1',
    },
    nextObservationId: () => 'observation_1',
    resolveBinding: async (parsed: ParsedObservationFields) => {
      calls.resolveBinding.push([parsed]);
      return {
        attemptId: 'attempt_1',
        obligationId: 'obligation_1',
        merchantId: 'merchant_1',
        credentialBindingId: 'binding_1',
        credentialVersionId: 'credential_version_1',
        bindingVerification: 'VERIFIED',
      };
    },
    verify: async (input: RawObservationInput) => {
      calls.verify.push([input]);
      return 'NOT_APPLICABLE';
    },
    persist: async (candidate: ObservationCandidate) => {
      calls.persist.push([candidate]);
      return result;
    },
    persistSecurityRejection: async (record) => {
      calls.securityRejections.push([record]);
    },
  };

  return {
    deps: {
      ...defaultDeps,
      ...overrides,
    },
    calls,
  };
}

describe('ingestRawObservation', () => {
  it('hashes exact bytes before parsing and never logs them', async () => {
    const input = rawInput();
    const { deps: rawDeps, calls } = deps();
    const logger = captureLoggerOutput();

    try {
      await ingestRawObservation(rawDeps, input);
    } finally {
      logger.restore();
    }

    assert.equal(calls.persist.length, 1);
    assert.partialDeepStrictEqual(calls.persist[0]?.[0], {
      rawBodyHash: createHash('sha256').update(input.rawBody).digest('hex'),
    });
    assert.equal(logger.output().includes(input.rawBody.toString('utf8')), false);
  });

  it('persists only the canonical candidate and never the raw body or headers', async () => {
    const input = rawInput({
      headers: {
        authorization: 'secret',
        'x-shipmastr-signature': 'sig',
      },
    });
    const { deps: rawDeps, calls } = deps();

    await ingestRawObservation(rawDeps, input);

    assert.equal(calls.persist.length, 1);
    assert.equal('rawBody' in (calls.persist[0]?.[0] ?? {}), false);
    assert.equal('headers' in (calls.persist[0]?.[0] ?? {}), false);
  });

  it('rejects invalid signatures before persistence', async () => {
    const { deps: rawDeps, calls } = deps({
      verify: async (input: RawObservationInput) => {
        calls.verify.push([input]);
        return 'FAILED';
      },
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'UNAUTHENTICATED',
    });
    assert.equal(calls.persist.length, 0);
    assert.equal(calls.resolveBinding.length, 0);
    assert.equal(calls.securityRejections.length, 1);
    assert.partialDeepStrictEqual(calls.securityRejections[0]?.[0], {
      provider: 'MOCK', environment: 'TEST', source: 'MOCK', reason: 'UNAUTHENTICATED',
      signatureVerification: 'FAILED', bindingVerification: null,
      securityAlertCode: 'INVALID_PROVIDER_SIGNATURE',
    });
    assert.equal(JSON.stringify(calls.securityRejections[0]?.[0]).includes('"rawBody"'), false);
    assert.equal(JSON.stringify(calls.securityRejections[0]?.[0]).includes('"headers"'), false);
  });

  it('rejects unavailable verification before persistence', async () => {
    const { deps: rawDeps, calls } = deps({
      verify: async (input: RawObservationInput) => {
        calls.verify.push([input]);
        return 'UNAVAILABLE';
      },
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'UNAUTHENTICATED',
    });
    assert.equal(calls.persist.length, 0);
    assert.equal(calls.resolveBinding.length, 0);
    assert.equal(calls.securityRejections.length, 1);
  });

  it('fails closed and records sanitized rejection for unexpected verifier metadata', async () => {
    const { deps: rawDeps, calls } = deps({
      verify: async () => 'TRUST_ME' as never,
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'UNAUTHENTICATED',
    });
    assert.equal(calls.persist.length, 0);
    assert.equal(calls.resolveBinding.length, 0);
    assert.partialDeepStrictEqual(calls.securityRejections[0]?.[0], {
      signatureVerification: 'UNAVAILABLE',
      securityAlertCode: 'INVALID_PROVIDER_SIGNATURE',
    });
  });

  it('disables non-Mock ingestion without an approved retention decision', async () => {
    const { deps: rawDeps, calls } = deps({
      parser: cashfreeParserStub(),
      ingestionMode: 'CONTRACT_FIXTURE_ONLY',
      retentionDecision: 'NO_RETENTION_APPROVED',
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'INGESTION_DISABLED',
    });
    assert.equal(calls.verify.length, 0);
    assert.equal(calls.persist.length, 0);
    assert.equal(calls.securityRejections.length, 0);
  });

  it('never copies direct phone PII or raw payload material into durable rejection evidence', async () => {
    const { deps: rawDeps, calls } = deps({ verify: async () => 'FAILED' });
    await ingestRawObservation(rawDeps, rawInput({
      rawBody: Buffer.from('{"phone":"+919876543210","token":"secret"}', 'utf8'),
      headers: { authorization: 'Bearer secret' },
    }));

    const serialized = JSON.stringify(calls.securityRejections);
    assert.doesNotMatch(serialized, /9876543210|Bearer|token|"rawBody"|"headers"|secret/i);
  });

  it('rejects binding mismatches before persistence', async () => {
    const { deps: rawDeps, calls } = deps({
      resolveBinding: async (parsed: ParsedObservationFields) => {
        calls.resolveBinding.push([parsed]);
        return {
          attemptId: 'attempt_1',
          obligationId: 'obligation_1',
          merchantId: 'merchant_1',
          credentialBindingId: 'binding_1',
          credentialVersionId: 'credential_version_1',
          bindingVerification: 'FAILED',
        };
      },
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'BINDING_MISMATCH',
    });
    assert.equal(calls.persist.length, 0);
    assert.equal(calls.securityRejections.length, 1);
    assert.partialDeepStrictEqual(calls.securityRejections[0]?.[0], {
      attemptId: 'attempt_1', obligationId: 'obligation_1', merchantId: 'merchant_1',
      reason: 'BINDING_MISMATCH', bindingVerification: 'FAILED',
      securityAlertCode: 'PROVIDER_BINDING_MISMATCH',
    });
  });

  it('never copies untrusted binding identifiers into durable rejection evidence', async () => {
    const { deps: rawDeps, calls } = deps({
      resolveBinding: async () => ({
        attemptId: 'buyer@example.invalid',
        obligationId: '+919876543210',
        merchantId: 'payload-merchant',
        credentialBindingId: 'raw-secret-binding',
        credentialVersionId: 'raw-secret-version',
        bindingVerification: 'FAILED',
      }),
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'BINDING_MISMATCH',
    });
    assert.partialDeepStrictEqual(calls.securityRejections[0]?.[0], {
      merchantId: null,
      obligationId: null,
      attemptId: null,
      credentialBindingId: null,
    });
    assert.doesNotMatch(
      JSON.stringify(calls.securityRejections),
      /buyer@example|9876543210|payload-merchant|raw-secret/i,
    );
  });

  it('rejects malformed payloads without persisting', async () => {
    const { deps: rawDeps, calls } = deps({
      parser: {
        provider: 'MOCK',
        adapterVersion: 'mock-adapter-v1',
        mappingVersion: 'mock-mapping-v1',
        providerApiVersion: 'mock-2026-08-28',
        parse() {
          throw new Error('malformed');
        },
      },
    });

    assert.deepEqual(await ingestRawObservation(rawDeps, rawInput()), {
      kind: 'REJECTED',
      reason: 'MALFORMED',
    });
    assert.equal(calls.persist.length, 0);
  });
});
