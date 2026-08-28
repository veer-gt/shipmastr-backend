import { PGO1_MAX_BIGINT_PAISE } from './money.js';
import type { ActivationDecision, ActivationPolicyInput } from './types.js';

export function evaluateActivationPolicy(input: ActivationPolicyInput): ActivationDecision {
  const p = input.policy;
  if (!p || p.approved !== true || p.merchantId !== input.merchantId ||
      p.provider !== input.provider || p.environment !== input.environment ||
      p.operation !== input.operation || p.maxAmountPaise < 1n ||
      p.maxAmountPaise > PGO1_MAX_BIGINT_PAISE || input.amountPaise > p.maxAmountPaise) {
    return { enabled: false, reason: 'POLICY_DISABLED' };
  }
  return { enabled: true, policyVersion: p.version };
}
