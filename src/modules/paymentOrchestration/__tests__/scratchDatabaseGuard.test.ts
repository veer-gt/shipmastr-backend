import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertPgo1ScratchDatabaseName,
  expectedScratchDatabaseNameFromEnv,
} from './scratchDatabaseGuard.js';

describe('PGO1 scratch database guard', () => {
  it('accepts only pgo1-specific scratch database names', () => {
    assert.doesNotThrow(() => assertPgo1ScratchDatabaseName('shipmastr_scratch_pgo1_a965f431'));
    assert.throws(() => assertPgo1ScratchDatabaseName('shipmastr_scratch_other_123'));
    assert.throws(() => assertPgo1ScratchDatabaseName('shipmastr_scratch_pgo1_'));
  });

  it('derives the expected scratch database name from env', () => {
    assert.equal(
      expectedScratchDatabaseNameFromEnv({
        PGO1_SCRATCH_DB_NAME: 'shipmastr_scratch_pgo1_demo_123',
        PGO1_TEST_DATABASE_URL:
          'postgresql://localhost:5433/shipmastr_scratch_pgo1_demo_123',
      }),
      'shipmastr_scratch_pgo1_demo_123',
    );
  });
});
