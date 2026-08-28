import assert from 'node:assert/strict';

const PGO1_SCRATCH_DATABASE_NAME_PATTERN = /^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$/;

export function assertPgo1ScratchDatabaseName(name: string) {
  assert.match(
    name,
    PGO1_SCRATCH_DATABASE_NAME_PATTERN,
    'PGO1 scratch database name must match ^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$',
  );
}

export function expectedScratchDatabaseNameFromEnv(
  env: NodeJS.ProcessEnv = process.env,
) {
  const fromName = env.PGO1_SCRATCH_DB_NAME ?? null;
  const fromUrl = env.PGO1_TEST_DATABASE_URL
    ? decodeURIComponent(new URL(env.PGO1_TEST_DATABASE_URL).pathname.slice(1))
    : null;
  const expected = fromName ?? fromUrl;

  assert.ok(expected, 'PGO1 scratch database name must be present in local test config');
  assertPgo1ScratchDatabaseName(expected);
  if (fromName && fromUrl) {
    assert.equal(fromName, fromUrl);
  }

  return expected;
}
