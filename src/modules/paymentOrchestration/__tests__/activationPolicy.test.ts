import assert from 'node:assert/strict';
import { it } from 'node:test';
import { evaluateActivationPolicy } from '../activationPolicy.js';

const base = {
  merchantId: 'm_1', provider: 'MOCK' as const, environment: 'TEST' as const,
  operation: 'CREATE_ATTEMPT' as const, amountPaise: 10_000n,
  evaluatedAt: new Date('2026-08-29T12:00:00.000Z'),
};

const timing = {
  approvedAt: new Date('2026-08-29T10:00:00.000Z'),
  effectiveFrom: new Date('2026-08-29T11:00:00.000Z'),
  effectiveUntil: new Date('2026-08-30T11:00:00.000Z'),
};

it('enables only an approved matching policy with an explicit ceiling', () => {
  assert.deepEqual(evaluateActivationPolicy({ ...base, policy: {
    version: 'mock-v1', approved: true, merchantId: 'm_1', provider: 'MOCK',
    environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 10_000n,
    ...timing,
  }}), { enabled: true, policyVersion: 'mock-v1' });
});

for (const policy of [
  undefined,
  { version: 'x', approved: false, merchantId: 'm_1', provider: 'MOCK', environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 10_000n, ...timing },
  { version: 'x', approved: true, merchantId: 'm_1', provider: 'MOCK', environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 0n, ...timing },
  { version: 'x', approved: true, merchantId: 'm_1', provider: 'MOCK', environment: 'TEST', operation: 'CREATE_ATTEMPT', maxAmountPaise: 9_999n, ...timing },
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
      ...timing,
      [field]: value,
    };
    assert.equal(evaluateActivationPolicy({ ...base, policy } as never).enabled, false);
  });
}

it('fails disabled for real-provider execution even with a matching approval record', () => {
  const policy = {
    version: 'cashfree-v1', approved: true, merchantId: 'm_1', provider: 'CASHFREE' as const,
    environment: 'TEST' as const, operation: 'CREATE_ATTEMPT' as const, maxAmountPaise: 10_000n,
    ...timing,
  };
  assert.equal(evaluateActivationPolicy({ ...base, provider: 'CASHFREE', policy }).enabled, false);
});

it('fails disabled outside the approved effective window', () => {
  const policy = {
    version: 'mock-v1', approved: true, merchantId: 'm_1', provider: 'MOCK' as const,
    environment: 'TEST' as const, operation: 'CREATE_ATTEMPT' as const, maxAmountPaise: 10_000n,
    ...timing,
  };
  assert.equal(evaluateActivationPolicy({
    ...base, policy, evaluatedAt: new Date('2026-08-30T11:00:00.000Z'),
  }).enabled, false);
});

it('fails disabled instead of throwing for malformed persisted policy values', () => {
  const policy = {
    version: 7,
    approved: true,
    merchantId: 'm_1',
    provider: 'MOCK',
    environment: 'TEST',
    operation: 'CREATE_ATTEMPT',
    maxAmountPaise: 10_000,
    ...timing,
  };
  assert.deepEqual(evaluateActivationPolicy({ ...base, policy } as never), {
    enabled: false,
    reason: 'POLICY_DISABLED',
  });
});
