import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  paytmContractParser,
  verifyPaytmChecksum,
} from '../adapters/paytmContract.js';
import type { ParsedObservationFields, RawObservationInput } from '../adapters/providerAdapter.js';
import type { PaytmChecksumRepresentation } from '../adapters/paytmContract.js';

const fixtureDir = resolve(process.cwd(), 'src/modules/paymentOrchestration/__fixtures__/paytm');
const testMerchantKey = 'PGO1PAYTMKEY2026';

interface PaytmFixtureManifest {
  name: string;
  provider: 'PAYTM';
  contractVersion: string;
  fixtureProvenance: 'SYNTHETIC_FROM_OFFICIAL_CONTRACT';
  officialChecksumImplementationUrl: string;
  officialNodeChecksumSourceUrl: string;
  officialNodeChecksumSourceCommit: string;
  officialNodeChecksumSourceSha256: string;
  signatureRepresentation: 'FORM_PARAMS' | 'JSON_BODY';
  adapterVersion: string;
  mappingVersion: string;
  expectedSignature: 'VERIFIED' | 'FAILED';
  checksum: string;
  expectedDisposition: string;
  expectedNativeStatus: string;
  containsRealPii: false;
  syntheticBuyerPhone: string;
  syntheticBuyerEmail: string;
  syntheticInstrumentValue: string;
  expected: ProjectedCandidate | { throws: string };
}

interface ProjectedCandidate {
  source: ParsedObservationFields['source'];
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
  parsedBody: Record<string, unknown>;
  input: RawObservationInput;
  manifest: PaytmFixtureManifest;
}

function loadPaytmFixtures(): Fixture[] {
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.manifest.json'))
    .sort()
    .map((file) => {
      const manifest = JSON.parse(
        readFileSync(resolve(fixtureDir, file), 'utf8'),
      ) as PaytmFixtureManifest;
      const rawBody = readFileSync(resolve(fixtureDir, `${manifest.name}.raw.json`));
      return {
        name: manifest.name,
        rawBody,
        parsedBody: JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>,
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

function checksumRepresentation(fixture: Fixture): PaytmChecksumRepresentation {
  if (fixture.manifest.signatureRepresentation === 'JSON_BODY') {
    return {
      kind: 'JSON_BODY',
      body: fixture.rawBody.toString('utf8'),
    };
  }

  return {
    kind: 'FORM_PARAMS',
    params: fixture.parsedBody as Record<string, string | null | undefined>,
  };
}

function project(candidate: ParsedObservationFields): ProjectedCandidate & {
  provider: string;
  environment: string;
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

function expectedProject(manifest: PaytmFixtureManifest) {
  assert.ok(!('throws' in manifest.expected));
  return {
    provider: 'PAYTM',
    environment: 'TEST',
    evidenceAuthority: 'ACTIVATION_GATED',
    adapterVersion: manifest.adapterVersion,
    mappingVersion: manifest.mappingVersion,
    providerApiVersion: 'paytm-checksum-contract-c8d5803d8b3c01fe73ee5a7b7c89b892180aea22',
    ...manifest.expected,
  };
}

describe('paytmContractParser', () => {
  it('verifies checksum parameters without trusting payload merchant identity', () => {
    const fixture = loadPaytmFixtures().find((item) => item.name === 'wrong-merchant-binding');
    assert.ok(fixture);
    assert.equal(
      verifyPaytmChecksum({
        representation: checksumRepresentation(fixture),
        checksum: fixture.manifest.checksum,
        merchantKey: testMerchantKey,
      }),
      true,
    );
    assert.equal(
      verifyPaytmChecksum({
        representation: {
          kind: 'FORM_PARAMS',
          params: {
            ...(fixture.parsedBody as Record<string, string>),
            TXNAMOUNT: '100.01',
          },
        },
        checksum: fixture.manifest.checksum,
        merchantKey: testMerchantKey,
      }),
      false,
    );
  });

  it('treats string null-like form values as empty while preserving ordinary values', () => {
    const fixture = loadPaytmFixtures().find((item) => item.name === 'valid-success');
    assert.ok(fixture);
    assert.equal((fixture.parsedBody as Record<string, string>).BANKTXNID, 'null');
    assert.equal(
      verifyPaytmChecksum({
        representation: checksumRepresentation(fixture),
        checksum: fixture.manifest.checksum,
        merchantKey: testMerchantKey,
      }),
      true,
    );
    assert.equal(
      verifyPaytmChecksum({
        representation: {
          kind: 'FORM_PARAMS',
          params: {
            ...(fixture.parsedBody as Record<string, string>),
            BANKTXNID: 'ordinary-value',
          },
        },
        checksum: fixture.manifest.checksum,
        merchantKey: testMerchantKey,
      }),
      false,
    );
  });

  it('verifies JSON-body signatures over the exact body string', () => {
    const fixture = loadPaytmFixtures().find((item) => item.name === 'same-event-different-body');
    assert.ok(fixture);
    assert.equal(
      verifyPaytmChecksum({
        representation: checksumRepresentation(fixture),
        checksum: fixture.manifest.checksum,
        merchantKey: testMerchantKey,
      }),
      true,
    );
    assert.equal(
      verifyPaytmChecksum({
        representation: {
          kind: 'JSON_BODY',
          body: fixture.rawBody.toString('utf8') + ' ',
        },
        checksum: fixture.manifest.checksum,
        merchantKey: testMerchantKey,
      }),
      false,
    );
  });

  for (const fixture of loadPaytmFixtures()) {
    it(`parses synthetic ${fixture.name} contract fixture`, () => {
      assert.equal(fixture.manifest.fixtureProvenance, 'SYNTHETIC_FROM_OFFICIAL_CONTRACT');
      assert.equal(fixture.manifest.containsRealPii, false);
      assert.equal(fixture.manifest.officialNodeChecksumSourceCommit, 'c8d5803d8b3c01fe73ee5a7b7c89b892180aea22');
      assert.equal(fixture.manifest.officialNodeChecksumSourceSha256, 'd59f38ef72ccc6cded9b00c8835be96ccefee246c4c2e8465e82cf3087eed60e');
      assert.equal(
        verifyPaytmChecksum({
          representation: checksumRepresentation(fixture),
          checksum: fixture.manifest.checksum,
          merchantKey: testMerchantKey,
        }) ? 'VERIFIED' : 'FAILED',
        fixture.manifest.expectedSignature,
      );

      if ('throws' in fixture.manifest.expected) {
        const expectedError = fixture.manifest.expected.throws;
        assert.throws(
          () => paytmContractParser.parse(fixture.input),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(expectedError));
            assertNoLeakage(error.message, fixture);
            return true;
          },
        );
        return;
      }

      const candidate = paytmContractParser.parse(fixture.input);
      assert.deepEqual(project(candidate), expectedProject(fixture.manifest));
      assert.equal(dispositionFor(candidate.mappedOutcome), fixture.manifest.expectedDisposition);
      const serialized = JSON.stringify(project(candidate));
      assertNoLeakage(serialized, fixture);
    });
  }

  it('keeps NO_RECORD_FOUND unresolved until a future evidence matrix approves absence authority', () => {
    const fixture = loadPaytmFixtures().find((item) => item.name === 'unmapped-status');
    assert.ok(fixture);
    const candidate = paytmContractParser.parse(fixture.input);
    assert.equal(candidate.nativeStatus, 'NO_RECORD_FOUND');
    assert.equal(candidate.mappedOutcome, 'UNMAPPED');
    assert.equal(candidate.evidenceAuthority, 'ACTIVATION_GATED');
  });

  it('does not import network clients, SDKs, or request seams', (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/paymentOrchestration/adapters/paytmContract.ts'),
      'utf8',
    );

    const importLines = source
      .split('\n')
      .filter((line) => /^import\s/.test(line))
      .join('\n');
    assert.deepEqual(importLines.split('\n'), [
      "import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';",
      "import { parseInrPaise } from '../money.js';",
      "import type { ObservationParser, ParsedObservationFields, RawObservationInput } from './providerAdapter.js';",
    ]);
    const blockedImportPattern = new RegExp([
      'node:http',
      'node:https',
      'ax' + 'ios',
      'got',
      'paytmchecksum',
      'paytm_node',
      'client-network',
      'requ' + 'est',
    ].join('|'), 'i');
    assert.doesNotMatch(importLines, blockedImportPattern);
    assert.equal(source.includes('fet' + 'ch('), false);
    for (const fixture of loadPaytmFixtures().filter((item) => !('throws' in item.manifest.expected))) {
      paytmContractParser.parse(fixture.input);
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
  assert.equal(value.includes(testMerchantKey), false);
  assert.equal(value.includes(fixture.manifest.checksum), false);
  assert.equal(value.includes(fixture.manifest.syntheticBuyerPhone), false);
  assert.equal(value.includes(fixture.manifest.syntheticBuyerEmail), false);
  assert.equal(value.includes(fixture.manifest.syntheticInstrumentValue), false);
}
