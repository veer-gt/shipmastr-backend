import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('provider observation truth guards', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source(
    'prisma/migrations/20260829120000_pgo_1_final_fix_observation_truth/migration.sql',
  );
  const persistence = source('src/modules/paymentOrchestration/reductionPersistence.ts');
  const observationService = source('src/modules/paymentOrchestration/observationService.ts');

  it('requires canonical mapped outcome and provider API version on every observation', () => {
    assert.match(schema, /mappedOutcome\s+ObservationMappedOutcome\n/);
    assert.match(schema, /providerApiVersion\s+String\n/);
    assert.match(schema, /hashAlgorithm\s+ObservationHashAlgorithm\n/);
    assert.match(schema, /bindingVerification\s+BindingVerification\n/);
    assert.match(migration, /requires an empty ProviderObservation table/);
    assert.match(migration, /ADD COLUMN "mappedOutcome" "ObservationMappedOutcome" NOT NULL/);
    assert.match(migration, /ADD COLUMN "providerApiVersion" TEXT NOT NULL/);
  });

  it('persists append-only derived truth without rewriting provider observations', () => {
    assert.match(schema, /originalMappingVersion\s+String\n/);
    assert.match(schema, /derivedOutcome\s+ObservationMappedOutcome\n/);
    assert.match(schema, /derivedAt\s+DateTime\n/);
    assert.doesNotMatch(persistence, /providerObservation\.update/);
    assert.doesNotMatch(persistence, /providerObservation\.delete/);
    assert.doesNotMatch(observationService, /providerObservation\.update/);
    assert.doesNotMatch(observationService, /providerObservation\.delete/);
  });

  it('pins scoped provider-event identity and durable security/governance records', () => {
    assert.match(schema, /provider_observation_scoped_event_body/);
    assert.match(schema, /model ProviderObservationRejection/);
    assert.match(schema, /model ProviderPolicyDecisionAudit/);
    assert.match(migration, /"securityAlertStatus" TEXT NOT NULL/);
    assert.match(migration, /"approvedAt" TIMESTAMP\(3\)/);
    assert.match(migration, /"effectiveFrom" TIMESTAMP\(3\)/);
    assert.match(migration, /"effectiveUntil" TIMESTAMP\(3\)/);
  });
});
