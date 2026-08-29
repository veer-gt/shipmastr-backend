import { Prisma, PrismaClient, type PaymentAttempt, type PaymentObligation } from '@prisma/client';
import { evaluateActivationPolicy } from './activationPolicy.js';
import { mockAdapter, mockProviderOrderRef } from './adapters/mockAdapter.js';
import { persistProviderPolicyDecision } from './policyAudit.js';
import {
  findRequestReplayAttempt,
  findUnresolvedAttemptForOwnedObligation,
  getOwnedObligationOrThrow,
} from './repository.js';
import type { ActivationPolicyInput } from './types.js';

export interface CreateAttemptInput extends ActivationPolicyInput {
  operation: 'CREATE_ATTEMPT';
  obligationId: string;
  requestIdempotencyKey: string;
  credentialBindingId: string;
  credentialVersionId: string;
}

export type AttemptCreationResult =
  | { kind: 'CREATED'; attempt: PaymentAttempt }
  | { kind: 'IDEMPOTENT_REPLAY'; attempt: PaymentAttempt }
  | { kind: 'EXISTING_UNRESOLVED'; attempt: PaymentAttempt };

export async function createAttempt(
  prisma: PrismaClient,
  input: CreateAttemptInput,
): Promise<AttemptCreationResult> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "PaymentObligation"
        WHERE "id" = ${input.obligationId} AND "merchantId" = ${input.merchantId}
        FOR UPDATE
      `;

      if (rows.length !== 1) {
        throw new Error('OBLIGATION_NOT_FOUND');
      }

      const obligation = await getOwnedObligationOrThrow(tx, input.merchantId, input.obligationId);
      const replay = await findRequestReplayAttempt(
        tx,
        input.merchantId,
        input.requestIdempotencyKey,
      );
      if (replay) {
        if (replay.obligationId !== input.obligationId) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }

        await persistProviderPolicyDecision(
          tx,
          activationAuditRecord(input, obligation, 'NO_EXECUTION', 'IDEMPOTENT_REPLAY', replay.id),
        );
        return { kind: 'IDEMPOTENT_REPLAY' as const, attempt: replay };
      }

      try {
        assertAttemptEligible(obligation);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'OBLIGATION_NOT_ATTEMPT_ELIGIBLE') {
          throw error;
        }
        await persistProviderPolicyDecision(
          tx,
          activationAuditRecord(
            input,
            obligation,
            'NO_EXECUTION',
            'OBLIGATION_NOT_ATTEMPT_ELIGIBLE',
            null,
          ),
        );
        return { kind: 'OBLIGATION_NOT_ATTEMPT_ELIGIBLE' as const };
      }

      const unresolved = await findUnresolvedAttemptForOwnedObligation(
        tx,
        input.merchantId,
        obligation.id,
      );
      if (unresolved) {
        await persistProviderPolicyDecision(
          tx,
          activationAuditRecord(
            input,
            obligation,
            'NO_EXECUTION',
            'EXISTING_UNRESOLVED',
            unresolved.id,
          ),
        );
        return { kind: 'EXISTING_UNRESOLVED' as const, attempt: unresolved };
      }

      const decision = evaluateActivationPolicy({
        ...input,
        amountPaise: obligation.amountPaise,
      });
      if (!decision.enabled) {
        await persistProviderPolicyDecision(
          tx,
          activationAuditRecord(input, obligation, 'DISABLED', 'POLICY_DISABLED', null),
        );
        return { kind: 'POLICY_DISABLED' as const };
      }

      const pendingAttempt = await tx.paymentAttempt.create({
        data: pendingAttemptData(input, obligation),
      });
      const attempt = await tx.paymentAttempt.update({
        where: { id: pendingAttempt.id },
        data: {
          providerOrderRef: mockProviderOrderRef(obligation.id, pendingAttempt.id),
        },
      });

      await persistProviderPolicyDecision(
        tx,
        activationAuditRecord(input, obligation, 'ENABLED', 'POLICY_AUTHORIZED', attempt.id),
      );

      return { kind: 'CREATED' as const, attempt };
    });
    if (result.kind === 'POLICY_DISABLED') {
      throw new Error('PROVIDER_POLICY_DISABLED');
    }
    if (result.kind === 'OBLIGATION_NOT_ATTEMPT_ELIGIBLE') {
      throw new Error('OBLIGATION_NOT_ATTEMPT_ELIGIBLE');
    }
    return result;
  } catch (error) {
    if (isUniqueConflict(error)) {
      const replay = await findRequestReplayAttempt(
        prisma,
        input.merchantId,
        input.requestIdempotencyKey,
      );

      if (replay && replay.obligationId !== input.obligationId) {
        throw new Error('IDEMPOTENCY_KEY_CONFLICT');
      }

      if (replay && replay.obligationId === input.obligationId) {
        return { kind: 'IDEMPOTENT_REPLAY', attempt: replay };
      }
    }

    throw error;
  }
}

function activationAuditRecord(
  input: CreateAttemptInput,
  obligation: PaymentObligation,
  decision: 'ENABLED' | 'DISABLED' | 'NO_EXECUTION',
  reason: string,
  attemptId: string | null,
) {
  const policy = input.policy;
  return {
    merchantId: input.merchantId,
    obligationId: obligation.id,
    attemptId,
    provider: input.provider,
    environment: input.environment,
    operation: input.operation,
    policyVersion: typeof policy?.version === 'string' ? policy.version : null,
    policyApproved: policy?.approved === true,
    policyMerchantId: typeof policy?.merchantId === 'string' ? policy.merchantId : null,
    policyProvider: isProvider(policy?.provider) ? policy.provider : null,
    policyEnvironment: isEnvironment(policy?.environment) ? policy.environment : null,
    policyOperation: isOperation(policy?.operation) ? policy.operation : null,
    maxAmountPaise: typeof policy?.maxAmountPaise === 'bigint' ? policy.maxAmountPaise : null,
    approvedAt: auditDate(policy?.approvedAt),
    effectiveFrom: auditDate(policy?.effectiveFrom),
    effectiveUntil: auditDate(policy?.effectiveUntil),
    evaluatedAt: auditDate(input.evaluatedAt) ?? new Date(),
    decision,
    reason,
    timing: null,
  };
}

function auditDate(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function isProvider(value: unknown): value is CreateAttemptInput['provider'] {
  return value === 'MOCK' || value === 'CASHFREE' || value === 'PAYTM';
}

function isEnvironment(value: unknown): value is CreateAttemptInput['environment'] {
  return value === 'TEST' || value === 'LIVE';
}

function isOperation(value: unknown): value is 'CREATE_ATTEMPT' | 'STATUS_QUERY' {
  return value === 'CREATE_ATTEMPT' || value === 'STATUS_QUERY';
}

export function assertAttemptEligible(obligation: PaymentObligation) {
  if (
    obligation.collectionRail !== 'ONLINE' ||
    obligation.status !== 'OPEN' ||
    obligation.satisfiedAt !== null
  ) {
    throw new Error('OBLIGATION_NOT_ATTEMPT_ELIGIBLE');
  }
}

function pendingAttemptData(
  input: CreateAttemptInput,
  obligation: PaymentObligation,
): Prisma.PaymentAttemptUncheckedCreateInput {
  return {
    obligationId: obligation.id,
    merchantId: input.merchantId,
    obligationCollectionRail: obligation.collectionRail,
    provider: input.provider,
    environment: input.environment,
    credentialBindingId: input.credentialBindingId,
    credentialVersionId: input.credentialVersionId,
    requestIdempotencyKey: input.requestIdempotencyKey,
    providerOrderRef: null,
    outcomeStatus: 'PENDING',
    reviewStatus: 'NOT_REQUIRED',
    resolvedAt: null,
    lastOutcomeChangedAt: new Date(),
    lastObservationAt: null,
    adapterVersion: mockAdapter.adapterVersion,
    mappingVersion: mockAdapter.mappingVersion,
  };
}

function isUniqueConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
