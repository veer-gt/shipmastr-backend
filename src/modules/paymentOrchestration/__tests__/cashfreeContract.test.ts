import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  cashfreeContractParser,
  verifyCashfreeSignature,
} from '../adapters/cashfreeContract.js';
import type { ParsedObservationFields, RawObservationInput } from '../adapters/providerAdapter.js';

const fixtureDir = resolve(process.cwd(), 'src/modules/paymentOrchestration/__fixtures__/cashfree');
const testSecret = 'pgo1_cashfree_fixture_secret';

interface CashfreeFixtureManifest {
  name: string;
  provider: 'CASHFREE';
  contractVersion: string;
  fixtureProvenance: 'SYNTHETIC_FROM_OFFICIAL_CONTRACT';
  officialWebhookContractUrl: string;
  officialWebhookContractRetrievalDate: string;
  adapterVersion: string;
  mappingVersion: string;
  expectedSignature: 'VERIFIED' | 'FAILED';
  timestamp: string;
  signature: string;
  expectedDisposition: string;
  expectedNativeStatus: string;
  containsRealPii: false;
  syntheticBuyerPhone: string;
  syntheticBuyerEmail: string;
  syntheticInstrumentValue: string;
  expected: ProjectedCandidate | { throws: string };
}

interface ProjectedCandidate {
  providerEventId: string | null;
  providerOrderRef: string;
  providerTransactionRef: string | null;
  nativeStatus: string;
  nativeReasonCode: string | null;
  amountPaise: string | null;
  nativeAmountText: string;
  nativeCurrency: string;
  mappedOutcome: ParsedObservationFields['mappedOutcome'];
  providerOccurredAt: string | null;
}

interface Fixture {
  name: string;
  rawBody: Buffer;
  input: RawObservationInput;
  manifest: CashfreeFixtureManifest;
}

function loadCashfreeFixtures(): Fixture[] {
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.manifest.json'))
    .sort()
    .map((file) => {
      const manifest = JSON.parse(
        readFileSync(resolve(fixtureDir, file), 'utf8'),
      ) as CashfreeFixtureManifest;
      const rawBody = readFileSync(resolve(fixtureDir, `${manifest.name}.raw.json`));
      return {
        name: manifest.name,
        rawBody,
        input: {
          rawBody,
          headers: {
            'content-type': 'application/json',
          },
          receivedAt: new Date('2026-08-28T05:00:00.000Z'),
        },
        manifest,
      };
    });
}

function project(candidate: ParsedObservationFields): ProjectedCandidate & {
  provider: string;
  environment: string;
  source: string;
  evidenceAuthority: string;
  adapterVersion: string;
  mappingVersion: string;
  providerApiVersion: string;
} {
  return {
    provider: candidate.provider,
    environment: candidate.environment,
    source: candidate.source,
    providerEventId: candidate.providerEventId,
    providerOrderRef: candidate.providerOrderRef,
    providerTransactionRef: candidate.providerTransactionRef,
    nativeStatus: candidate.nativeStatus,
    nativeReasonCode: candidate.nativeReasonCode,
    amountPaise: candidate.amountPaise?.toString() ?? null,
    nativeAmountText: candidate.nativeAmountText ?? '',
    nativeCurrency: candidate.nativeCurrency ?? '',
    evidenceAuthority: candidate.evidenceAuthority,
    mappedOutcome: candidate.mappedOutcome,
    adapterVersion: candidate.adapterVersion,
    mappingVersion: candidate.mappingVersion,
    providerApiVersion: candidate.providerApiVersion,
    providerOccurredAt: candidate.providerOccurredAt?.toISOString() ?? null,
  };
}

function expectedProject(manifest: CashfreeFixtureManifest) {
  assert.ok(!('throws' in manifest.expected));
  return {
    provider: 'CASHFREE',
    environment: 'TEST',
    source: 'WEBHOOK',
    evidenceAuthority: 'ACTIVATION_GATED',
    adapterVersion: manifest.adapterVersion,
    mappingVersion: manifest.mappingVersion,
    providerApiVersion: 'cashfree-webhook-contract-2026-08-28',
    ...manifest.expected,
  };
}

describe('cashfreeContractParser', () => {
  it('verifies the signature over timestamp plus exact raw bytes', () => {
    const fixture = loadCashfreeFixtures().find((item) => item.name === 'valid-success');
    assert.ok(fixture);
    assert.equal(
      verifyCashfreeSignature({
        rawBody: fixture.rawBody,
        timestamp: fixture.manifest.timestamp,
        signature: fixture.manifest.signature,
        secret: testSecret,
      }),
      true,
    );
    assert.equal(
      verifyCashfreeSignature({
        rawBody: Buffer.concat([fixture.rawBody, Buffer.from(' ')]),
        timestamp: fixture.manifest.timestamp,
        signature: fixture.manifest.signature,
        secret: testSecret,
      }),
      false,
    );
  });

  for (const fixture of loadCashfreeFixtures()) {
    it(`parses synthetic ${fixture.name} contract fixture`, () => {
      assert.equal(fixture.manifest.fixtureProvenance, 'SYNTHETIC_FROM_OFFICIAL_CONTRACT');
      assert.equal(fixture.manifest.containsRealPii, false);
      assert.equal(
        verifyCashfreeSignature({
          rawBody: fixture.rawBody,
          timestamp: fixture.manifest.timestamp,
          signature: fixture.manifest.signature,
          secret: testSecret,
        }) ? 'VERIFIED' : 'FAILED',
        fixture.manifest.expectedSignature,
      );

      if ('throws' in fixture.manifest.expected) {
        const expectedError = fixture.manifest.expected.throws;
        assert.throws(
          () => cashfreeContractParser.parse(fixture.input),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(expectedError));
            assertNoLeakage(error.message, fixture);
            return true;
          },
        );
        return;
      }

      const candidate = cashfreeContractParser.parse(fixture.input);
      assert.deepEqual(project(candidate), expectedProject(fixture.manifest));
      assert.equal(dispositionFor(candidate.mappedOutcome), fixture.manifest.expectedDisposition);
      const serialized = JSON.stringify(candidate, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      assertNoLeakage(serialized, fixture);
    });
  }

  it('keeps the fixture status map closed to the named Cashfree codes', () => {
    const fixture = loadCashfreeFixtures().find((item) => item.name === 'unmapped-status');
    assert.ok(fixture);
    const candidate = cashfreeContractParser.parse(fixture.input);
    assert.equal(candidate.nativeStatus, 'REVIEW_REQUIRED');
    assert.equal(candidate.mappedOutcome, 'UNMAPPED');
    assert.equal(candidate.evidenceAuthority, 'ACTIVATION_GATED');
  });

  it('does not import network clients, SDKs, or request seams', (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/paymentOrchestration/adapters/cashfreeContract.ts'),
      'utf8',
    );

    const importLines = source
      .split('\n')
      .filter((line) => /^import\s/.test(line))
      .join('\n');
    assert.deepEqual(importLines.split('\n'), [
      "import { createHmac, timingSafeEqual } from 'node:crypto';",
      "import { parseInrPaise } from '../money.js';",
      "import type { ObservationParser, ParsedObservationFields, RawObservationInput } from './providerAdapter.js';",
    ]);
    const blockedImportPattern = new RegExp([
      'node:http',
      'node:https',
      'ax' + 'ios',
      'got',
      'client-network',
      'requ' + 'est',
    ].join('|'), 'i');
    assert.doesNotMatch(importLines, blockedImportPattern);
    assert.equal(source.includes('fet' + 'ch('), false);
    for (const fixture of loadCashfreeFixtures().filter((item) => !('throws' in item.manifest.expected))) {
      cashfreeContractParser.parse(fixture.input);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

function dispositionFor(mappedOutcome: ParsedObservationFields['mappedOutcome']): string {
  switch (mappedOutcome) {
    case 'SUCCEEDED':
      return 'CANDIDATE_SUCCEEDED_ACTIVATION_GATED';
    case 'PENDING':
      return 'CANDIDATE_PENDING_ACTIVATION_GATED';
    case 'FAILED_TERMINAL':
      return 'CANDIDATE_FAILED_ACTIVATION_GATED';
    case 'UNMAPPED':
      return 'MAPPING_GAP_ACTIVATION_GATED';
    case 'NOT_FOUND_TERMINAL':
    case 'UNKNOWN':
      return 'MAPPING_GAP_ACTIVATION_GATED';
  }
}

function assertNoLeakage(value: string, fixture: Fixture) {
  assert.equal(value.includes(fixture.rawBody.toString('utf8')), false);
  assert.equal(value.includes(testSecret), false);
  assert.equal(value.includes(fixture.manifest.signature), false);
  assert.equal(value.includes(fixture.manifest.syntheticBuyerPhone), false);
  assert.equal(value.includes(fixture.manifest.syntheticBuyerEmail), false);
  assert.equal(value.includes(fixture.manifest.syntheticInstrumentValue), false);
}
