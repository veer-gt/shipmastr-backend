import { PGO1_MAX_BIGINT_PAISE } from './money.js';
import type { ActivationDecision, ActivationPolicyInput } from './types.js';

export function evaluateActivationPolicy(input: ActivationPolicyInput): ActivationDecision {
  const p = input.policy;
  if (!p || p.approved !== true || p.merchantId !== input.merchantId ||
      p.provider !== input.provider || p.environment !== input.environment ||
      p.operation !== input.operation || typeof p.maxAmountPaise !== 'bigint' ||
      typeof input.amountPaise !== 'bigint' || p.maxAmountPaise < 1n ||
      p.maxAmountPaise > PGO1_MAX_BIGINT_PAISE || input.amountPaise > p.maxAmountPaise ||
      input.provider !== 'MOCK' || input.environment !== 'TEST' ||
      input.operation !== 'CREATE_ATTEMPT' || typeof p.version !== 'string' || p.version.trim() === '' ||
      !validDate(input.evaluatedAt) || !validDate(p.approvedAt) ||
      !validDate(p.effectiveFrom) || !validDate(p.effectiveUntil) ||
      p.approvedAt.getTime() > p.effectiveFrom.getTime() ||
      input.evaluatedAt.getTime() < p.effectiveFrom.getTime() ||
      input.evaluatedAt.getTime() >= p.effectiveUntil.getTime()) {
    return { enabled: false, reason: 'POLICY_DISABLED' };
  }
  return { enabled: true, policyVersion: p.version };
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
