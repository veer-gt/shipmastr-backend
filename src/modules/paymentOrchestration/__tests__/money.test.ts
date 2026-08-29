import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInrPaise } from '../money.js';

describe('parseInrPaise', () => {
  for (const [text, expected] of [
    ['1.00', 100n],
    ['0.01', 1n],
    ['92233720368547758.07', 9223372036854775807n],
  ] as const) {
    it(`parses ${text} without floating point`, () => {
      assert.equal(parseInrPaise(text), expected);
    });
  }

  for (const text of ['0', '0.00', '-1.00', '1.001', 'NaN', 'Infinity', '92233720368547758.08']) {
    it(`rejects invalid or overflowing value ${text}`, () => {
      assert.throws(() => parseInrPaise(text), /INVALID_INR_AMOUNT/);
    });
  }
});
