import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const directory = resolve(process.cwd(), 'src/modules/paymentOrchestration/__tests__');
const suites = readdirSync(directory).filter((file) => file.endsWith('.postgres.test.ts')).sort();
const helperSource = readFileSync(resolve(directory, 'postgresTestNamespace.ts'), 'utf8');

describe('PostgreSQL suite namespace guard', () => {
  for (const file of suites) {
    it(`${file} asserts an empty namespace and never performs an unscoped wipe`, () => {
      const source = readFileSync(resolve(directory, file), 'utf8');
      assert.match(source, /namespace\.assertEmpty\(prisma\)/);
      assert.doesNotMatch(source, /\.deleteMany\(\s*\)/);
      assert.doesNotMatch(source, /\.count\(\s*\)/);
      assert.doesNotMatch(source, /shipmastr_scratch_pgo1_[a-f0-9]+/);
    });
  }

  it('keeps every shared cleanup delete merchant-namespace filtered', () => {
    const cleanupCalls = helperSource.match(/\.deleteMany\([^;]+;/g) ?? [];
    assert.ok(cleanupCalls.length > 0);
    assert.ok(cleanupCalls.every((call) => /where/.test(call)));
    assert.doesNotMatch(helperSource, /\.deleteMany\(\s*\{\s*\}\s*\)/);
    for (const model of [
      'providerObservationRejection',
      'providerPolicyDecisionAudit',
      'providerObservation',
      'paymentAttempt',
      'paymentObligation',
    ]) {
      assert.match(helperSource, new RegExp(`${model}\\.count\\(\\{ where:`));
      assert.match(helperSource, new RegExp(`${model}\\.deleteMany\\(\\{ where`));
    }
  });
});
