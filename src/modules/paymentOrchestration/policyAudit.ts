import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ProviderPolicyDecisionRecord } from './types.js';

type PolicyAuditClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export async function persistProviderPolicyDecision(
  client: PolicyAuditClient,
  record: ProviderPolicyDecisionRecord,
): Promise<void> {
  const timing = record.timing === null ? null : JSON.stringify(record.timing);
  await client.$executeRaw`
    INSERT INTO "ProviderPolicyDecisionAudit" (
      "id", "merchantId", "obligationId", "attemptId", "provider", "environment", "operation",
      "policyVersion", "policyApproved", "policyMerchantId", "policyProvider",
      "policyEnvironment", "policyOperation", "maxAmountPaise", "approvedAt",
      "effectiveFrom", "effectiveUntil", "evaluatedAt", "decision", "reason", "timing", "createdAt"
    ) VALUES (
      ${randomUUID()}, ${record.merchantId}, ${record.obligationId}, ${record.attemptId},
      ${record.provider}::"PaymentProvider", ${record.environment}::"ProviderEnvironment", ${record.operation},
      ${record.policyVersion}, ${record.policyApproved}, ${record.policyMerchantId},
      ${record.policyProvider}::"PaymentProvider", ${record.policyEnvironment}::"ProviderEnvironment",
      ${record.policyOperation}, ${record.maxAmountPaise}, ${record.approvedAt},
      ${record.effectiveFrom}, ${record.effectiveUntil}, ${record.evaluatedAt},
      ${record.decision}, ${record.reason}, ${timing}::jsonb, CURRENT_TIMESTAMP
    )
  `;
}
