import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

export function createPaymentPostgresNamespace(suite: string) {
  const prefix = `pgo1_${suite}_${randomUUID().replaceAll('-', '')}_`;
  const merchantWhere = { startsWith: prefix };
  const auditWhere = {
    OR: [
      { merchantId: merchantWhere },
      { entityId: merchantWhere, action: { startsWith: 'PGO1_' } },
    ],
  };

  async function counts(client: PrismaClient) {
    const [
      interpretations, deliveries, facts, cases, attention, reviews, transitions,
      rejections, policyDecisions, observations, attempts, obligations, auditLogs,
    ] = await Promise.all([
      client.providerObservationInterpretation.count({ where: { merchantId: merchantWhere } }),
      client.providerObservationDelivery.count({ where: { merchantId: merchantWhere } }),
      client.paymentNormalizedFactOutbox.count({ where: { merchantId: merchantWhere } }),
      client.refundDueCase.count({ where: { merchantId: merchantWhere } }),
      client.paymentAttentionSignal.count({ where: { merchantId: merchantWhere } }),
      client.reconciliationReviewHistory.count({ where: { merchantId: merchantWhere } }),
      client.paymentOutcomeTransition.count({ where: { merchantId: merchantWhere } }),
      client.providerObservationRejection.count({ where: { merchantId: merchantWhere } }),
      client.providerPolicyDecisionAudit.count({ where: { merchantId: merchantWhere } }),
      client.providerObservation.count({ where: { merchantId: merchantWhere } }),
      client.paymentAttempt.count({ where: { merchantId: merchantWhere } }),
      client.paymentObligation.count({ where: { merchantId: merchantWhere } }),
      client.auditLog.count({ where: auditWhere }),
    ]);
    return {
      interpretations, deliveries, facts, cases, attention, reviews, transitions,
      rejections, policyDecisions, observations, attempts, obligations, auditLogs,
    };
  }

  return {
    prefix,
    id(local: string) {
      return `${prefix}${local}`;
    },
    async assertEmpty(client: PrismaClient) {
      const actual = await counts(client);
      assert.deepEqual(actual, Object.fromEntries(Object.keys(actual).map((key) => [key, 0])));
    },
    async cleanup(client: PrismaClient) {
      const where = { merchantId: merchantWhere };
      await client.providerObservationInterpretation.deleteMany({ where });
      await client.providerObservationDelivery.deleteMany({ where });
      await client.paymentNormalizedFactOutbox.deleteMany({ where });
      await client.refundDueCase.deleteMany({ where });
      await client.paymentAttentionSignal.deleteMany({ where });
      await client.reconciliationReviewHistory.deleteMany({ where });
      await client.paymentOutcomeTransition.deleteMany({ where });
      await client.providerObservationRejection.deleteMany({ where });
      await client.providerPolicyDecisionAudit.deleteMany({ where });
      await client.providerObservation.deleteMany({ where });
      await client.paymentAttempt.deleteMany({ where });
      await client.paymentObligation.deleteMany({ where });
      await client.auditLog.deleteMany({ where: auditWhere });
    },
  };
}
