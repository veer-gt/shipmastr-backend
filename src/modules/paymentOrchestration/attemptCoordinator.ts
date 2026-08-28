import { Prisma, PrismaClient, type PaymentAttempt, type PaymentObligation } from '@prisma/client';
import { evaluateActivationPolicy } from './activationPolicy.js';
import {
  findRequestReplayAttempt,
  findUnresolvedAttemptForOwnedObligation,
  getOwnedObligationOrThrow,
} from './repository.js';
import type { ActivationPolicyInput } from './types.js';

const ATTEMPT_COORDINATOR_VERSION = 'pgo1-attempt-coordinator-v1';

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
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "PaymentObligation"
        WHERE "id" = ${input.obligationId} AND "merchantId" = ${input.merchantId}
        FOR UPDATE
      `;

      if (rows.length !== 1) {
        throw new Error('OBLIGATION_NOT_FOUND');
      }

      const replay = await findRequestReplayAttempt(
        tx,
        input.merchantId,
        input.requestIdempotencyKey,
      );
      if (replay) {
        if (replay.obligationId !== input.obligationId) {
          throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        }

        return { kind: 'IDEMPOTENT_REPLAY', attempt: replay };
      }

      const obligation = await getOwnedObligationOrThrow(tx, input.merchantId, input.obligationId);
      assertAttemptEligible(obligation);

      const unresolved = await findUnresolvedAttemptForOwnedObligation(
        tx,
        input.merchantId,
        obligation.id,
      );
      if (unresolved) {
        return { kind: 'EXISTING_UNRESOLVED', attempt: unresolved };
      }

      const decision = evaluateActivationPolicy({
        ...input,
        amountPaise: obligation.amountPaise,
      });
      if (!decision.enabled) {
        throw new Error('PROVIDER_POLICY_DISABLED');
      }

      const attempt = await tx.paymentAttempt.create({
        data: pendingAttemptData(input, obligation, decision.policyVersion),
      });

      return { kind: 'CREATED', attempt };
    });
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

function assertAttemptEligible(obligation: PaymentObligation) {
  if (obligation.collectionRail !== 'ONLINE') {
    throw new Error('OBLIGATION_NOT_ATTEMPT_ELIGIBLE');
  }
}

function pendingAttemptData(
  input: CreateAttemptInput,
  obligation: PaymentObligation,
  policyVersion: string,
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
    adapterVersion: ATTEMPT_COORDINATOR_VERSION,
    mappingVersion: policyVersion,
  };
}

function isUniqueConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
