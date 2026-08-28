import assert from 'node:assert/strict';
import { it } from 'node:test';
import { evaluateActivationPolicy } from '../activationPolicy.js';

const base = {
  merchantId: 'm_1', provider: 'MOCK' as const, environment: 'TEST' as const,
  operation: 'CREATE_ATTEMPT' as const, amountPaise: 10_000n,
};

it('enables only an approved matching policy with an explicit ceiling', () => {
  assert.deepEqual(evaluateActivationPolicy({ ...base, policy: {
    version: 'mock-v1', approved: true, merchantId: 'm_1', provider: 'MOCK',
    environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 10_000n,
  }}), { enabled: true, policyVersion: 'mock-v1' });
});

for (const policy of [
  undefined,
  { version: 'x', approved: false, merchantId: 'm_1', provider: 'MOCK', environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 10_000n },
  { version: 'x', approved: true, merchantId: 'm_1', provider: 'MOCK', environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 0n },
  { version: 'x', approved: true, merchantId: 'm_1', provider: 'MOCK', environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 9_999n },
] as const) {
  it(`fails disabled for policy ${policy?.version ?? 'missing'}`, () => {
    assert.equal(evaluateActivationPolicy({ ...base, policy } as never).enabled, false);
  });
}

for (const [field, value] of [
  ['merchantId', 'm_2'],
  ['provider', 'CASHFREE'],
  ['environment', 'LIVE'],
  ['operation', 'STATUS_QUERY'],
] as const) {
  it(`fails disabled for mismatched ${field}`, () => {
    const policy = {
      version: 'mock-v1', approved: true, merchantId: 'm_1', provider: 'MOCK',
      environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 10_000n,
      [field]: value,
    };
    assert.equal(evaluateActivationPolicy({ ...base, policy } as never).enabled, false);
  });
}
