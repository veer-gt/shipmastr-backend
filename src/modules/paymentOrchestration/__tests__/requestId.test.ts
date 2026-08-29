import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeReadOnlyRequestId } from '../reviewService.js';

describe('sanitizeReadOnlyRequestId', () => {
  it('trims and accepts an opaque bounded token', () => {
    assert.equal(sanitizeReadOnlyRequestId('  request_ABC-123:retry.1  '), 'request_ABC-123:retry.1');
  });

  for (const value of [
    'free form caller text',
    'buyer@example.invalid',
    '+91 98765 43210',
    'x'.repeat(121),
    '<script>',
  ]) {
    it(`rejects unsafe caller request id ${value.slice(0, 12)}`, () => {
      assert.throws(() => sanitizeReadOnlyRequestId(value), /INVALID_READ_ONLY_REQUEST_ID/);
    });
  }
});
