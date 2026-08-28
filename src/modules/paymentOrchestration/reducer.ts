import { matchObservation } from './matching.js';
import type {
  CanonicalObservation,
  MatchResult,
  ReduceEvidenceInput,
  ReductionAttentionType,
  ReductionFactType,
  ReductionPlan,
} from './types.js';

type AttemptSnapshot = ReduceEvidenceInput['attempts'][number];

type ClassifiedObservation =
  | {
      kind: 'MATCHED_SUCCESS';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot;
    }
  | {
      kind: 'MATCHED_TERMINAL_FAILURE';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot;
      outcomeStatus: 'FAILED_TERMINAL' | 'NOT_FOUND_TERMINAL';
    }
  | {
      kind: 'MATCHED_PENDING';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot;
    }
  | {
      kind: 'MATCHED_UNKNOWN';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot;
    }
  | {
      kind: 'MAPPING_GAP';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot | null;
    }
  | {
      kind: 'INTEGRITY_CONFLICT';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot | null;
    }
  | {
      kind: 'NON_MATCHING';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot | null;
      matchResult: Exclude<MatchResult, { matched: true }>;
    };

export function reduceEvidence(input: ReduceEvidenceInput): ReductionPlan {
  const targetAttempt = requireTargetAttempt(input);
  const classified = classifyAndDedupe(input);
  const successes = classified.filter((entry): entry is Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }> =>
    entry.kind === 'MATCHED_SUCCESS',
  );
  const integrityConflicts = classified.filter(
    (entry): entry is Extract<ClassifiedObservation, { kind: 'INTEGRITY_CONFLICT' }> =>
      entry.kind === 'INTEGRITY_CONFLICT',
  );
  const mappingGaps = classified.filter(
    (entry): entry is Extract<ClassifiedObservation, { kind: 'MAPPING_GAP' }> => entry.kind === 'MAPPING_GAP',
  );
  const terminalFailures = classified.filter(
    (entry): entry is Extract<ClassifiedObservation, { kind: 'MATCHED_TERMINAL_FAILURE' }> =>
      entry.kind === 'MATCHED_TERMINAL_FAILURE',
  );

  if (successes.length > 0) {
    return reduceSuccesses(input, targetAttempt, classified, successes);
  }

  if (integrityConflicts.length > 0) {
    return integrityConflictPlan(targetAttempt);
  }

  if (mappingGaps.length > 0) {
    return mappingGapPlan(targetAttempt);
  }

  if (terminalFailures.length > 0) {
    return terminalFailurePlan(targetAttempt, terminalFailures);
  }

  return unresolvedPlan(targetAttempt, classified);
}

function classifyAndDedupe(input: ReduceEvidenceInput): ClassifiedObservation[] {
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const groups = new Map<string, CanonicalObservation[]>();

  for (const observation of input.observations) {
    const key = observation.providerEventId === null ? `observation:${observation.id}` : `event:${observation.providerEventId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(observation);
      continue;
    }
    groups.set(key, [observation]);
  }

  const result: ClassifiedObservation[] = [];
  const orderedKeys = [...groups.keys()].sort();

  for (const key of orderedKeys) {
    const group = groups.get(key)!;
    const orderedGroup = [...group].sort((left, right) => left.id.localeCompare(right.id));
    const representative = orderedGroup[0]!;
    const attempt = attemptsById.get(representative.attemptId) ?? null;

    if (representative.providerEventId !== null) {
      const hashes = new Set(orderedGroup.map((observation) => observation.rawBodyHash));
      if (hashes.size > 1) {
        result.push({
          kind: 'INTEGRITY_CONFLICT',
          observation: representative,
          attempt,
        });
        continue;
      }
    }

    if (attempt === null) {
      result.push({
        kind: 'NON_MATCHING',
        observation: representative,
        attempt,
        matchResult: { matched: false, reason: 'INTERNAL_REFERENCE_MISMATCH' },
      });
      continue;
    }

    const match = matchObservation({
      observation: representative,
      obligation: input.obligation,
      attempt,
    });

    if (!match.matched) {
      if (match.reason === 'UNMAPPED_STATUS') {
        result.push({
          kind: 'MAPPING_GAP',
          observation: representative,
          attempt,
        });
        continue;
      }

      result.push({
        kind: 'NON_MATCHING',
        observation: representative,
        attempt,
        matchResult: match,
      });
      continue;
    }

    switch (representative.mappedOutcome) {
      case 'SUCCEEDED':
        result.push({
          kind: 'MATCHED_SUCCESS',
          observation: representative,
          attempt,
        });
        break;
      case 'FAILED_TERMINAL':
      case 'NOT_FOUND_TERMINAL':
        result.push({
          kind: 'MATCHED_TERMINAL_FAILURE',
          observation: representative,
          attempt,
          outcomeStatus: representative.mappedOutcome,
        });
        break;
      case 'UNKNOWN':
        result.push({
          kind: 'MATCHED_UNKNOWN',
          observation: representative,
          attempt,
        });
        break;
      case 'PENDING':
        result.push({
          kind: 'MATCHED_PENDING',
          observation: representative,
          attempt,
        });
        break;
      case 'UNMAPPED':
        result.push({
          kind: 'MAPPING_GAP',
          observation: representative,
          attempt,
        });
        break;
    }
  }

  return result;
}

function reduceSuccesses(
  input: ReduceEvidenceInput,
  targetAttempt: AttemptSnapshot,
  classified: ClassifiedObservation[],
  successes: Array<Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>>,
): ReductionPlan {
  const distinctSuccesses = dedupeSuccesses(successes);
  const targetSuccesses = distinctSuccesses.filter((entry) => entry.attempt.id === targetAttempt.id);
  const targetHasSuccess = targetSuccesses.length > 0;
  const contradictory = hasContradictoryEvidence(classified);
  const integrityConflict = classified.some((entry) => entry.kind === 'INTEGRITY_CONFLICT');
  const mappingGap = classified.some((entry) => entry.kind === 'MAPPING_GAP');
  const facts: ReductionFactType[] = targetHasSuccess ? ['PAYMENT_SUCCEEDED'] : [];
  const attention = new Set<ReductionAttentionType>();
  const refundDue = new Map<string, { providerTransactionRef: string; reason: 'LATE_SUCCESS_AFTER_CLOSURE' | 'SURPLUS_DOUBLE_SUCCESS' }>();

  if (contradictory) {
    attention.add('CONTRADICTORY_EVIDENCE');
  }
  if (integrityConflict) {
    attention.add('INTEGRITY_CONFLICT');
  }
  if (mappingGap) {
    attention.add('MAPPING_GAP');
  }

  const legitimateTargetSuccess =
    targetHasSuccess &&
    (input.obligation.status === 'OPEN' ||
      targetAttempt.outcomeStatus === 'SUCCEEDED' ||
      targetAttempt.resolvedAt !== null);

  if (distinctSuccesses.length > 1) {
    attention.add('DOUBLE_SUCCESS_DETECTED');
    const surplus = legitimateTargetSuccess
      ? distinctSuccesses.filter((entry) => entry.attempt.id !== targetAttempt.id)
      : targetSuccesses;

    for (const entry of surplus) {
      refundDue.set(entry.observation.providerTransactionRef!, {
        providerTransactionRef: entry.observation.providerTransactionRef!,
        reason: 'SURPLUS_DOUBLE_SUCCESS',
      });
    }
  } else if (
    targetHasSuccess &&
    (input.obligation.status === 'EXPIRED' || input.obligation.status === 'CANCELLED')
  ) {
    for (const entry of targetSuccesses) {
      refundDue.set(entry.observation.providerTransactionRef!, {
        providerTransactionRef: entry.observation.providerTransactionRef!,
        reason: 'LATE_SUCCESS_AFTER_CLOSURE',
      });
    }
  }

  if (refundDue.size > 0) {
    facts.push('REFUND_DUE_DETECTED');
  }

  const targetResolves = targetHasSuccess || targetAttempt.resolvedAt !== null;
  const review = targetResolves
    ? resolvedReviewStatus(targetAttempt.reviewStatus)
    : preserveUnresolvedReviewStatus(targetAttempt.reviewStatus);
  const disposition = deriveSuccessDisposition(refundDue, attention);

  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus: targetHasSuccess ? 'SUCCEEDED' : targetAttempt.outcomeStatus,
    resolved: targetResolves,
    satisfyObligation: targetHasSuccess && input.obligation.status === 'OPEN',
    reviewStatus: review.reviewStatus,
    completedByType: review.completedByType,
    disposition,
    factTypes: facts,
    refundDue: [...refundDue.values()],
    attention: [...attention].map((type) => ({ type })),
    relatedAttemptActions: input.attempts
      .filter((attempt) => attempt.id !== targetAttempt.id)
      .map((attempt) => ({
        attemptId: attempt.id,
        action: attempt.resolvedAt === null ? 'KEEP_UNRESOLVED_LOCKED' : 'PRESERVE_TERMINAL',
      })),
  });
}

function terminalFailurePlan(
  targetAttempt: AttemptSnapshot,
  terminalFailures: Array<Extract<ClassifiedObservation, { kind: 'MATCHED_TERMINAL_FAILURE' }>>,
): ReductionPlan {
  const nextOutcome = terminalFailures.some((entry) => entry.outcomeStatus === 'FAILED_TERMINAL')
    ? 'FAILED_TERMINAL'
    : 'NOT_FOUND_TERMINAL';
  const review = resolvedReviewStatus(targetAttempt.reviewStatus);

  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus: nextOutcome,
    resolved: true,
    satisfyObligation: false,
    reviewStatus: review.reviewStatus,
    completedByType: review.completedByType,
    disposition: nextOutcome === 'FAILED_TERMINAL' ? 'TERMINAL_FAILURE' : 'NOT_FOUND_TERMINAL',
    factTypes: ['PAYMENT_FAILED'],
    refundDue: [],
    attention: [],
    relatedAttemptActions: [],
  });
}

function integrityConflictPlan(targetAttempt: AttemptSnapshot): ReductionPlan {
  const review = targetAttempt.resolvedAt === null
    ? unresolvedReviewStatus(targetAttempt.reviewStatus)
    : resolvedReviewStatus(targetAttempt.reviewStatus);

  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus: targetAttempt.outcomeStatus,
    resolved: targetAttempt.resolvedAt !== null,
    satisfyObligation: false,
    reviewStatus: review.reviewStatus,
    completedByType: review.completedByType,
    disposition: targetAttempt.resolvedAt === null ? 'INTEGRITY_CONFLICT' : 'INTEGRITY_CONFLICT_POST_RESOLUTION',
    factTypes: [],
    refundDue: [],
    attention: [{ type: 'INTEGRITY_CONFLICT' }],
    relatedAttemptActions: [],
  });
}

function mappingGapPlan(targetAttempt: AttemptSnapshot): ReductionPlan {
  const review = unresolvedReviewStatus(targetAttempt.reviewStatus);

  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus: 'UNKNOWN',
    resolved: false,
    satisfyObligation: false,
    reviewStatus: review.reviewStatus,
    completedByType: review.completedByType,
    disposition: 'MAPPING_GAP',
    factTypes: [],
    refundDue: [],
    attention: [{ type: 'MAPPING_GAP' }],
    relatedAttemptActions: [],
  });
}

function unresolvedPlan(
  targetAttempt: AttemptSnapshot,
  classified: ClassifiedObservation[],
): ReductionPlan {
  const hasUnknown = classified.some((entry) => entry.kind === 'MATCHED_UNKNOWN');
  const outcomeStatus = hasUnknown ? 'UNKNOWN' : targetAttempt.outcomeStatus;

  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus,
    resolved: false,
    satisfyObligation: false,
    reviewStatus: targetAttempt.reviewStatus,
    completedByType: null,
    disposition: outcomeStatus === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING',
    factTypes: [],
    refundDue: [],
    attention: [],
    relatedAttemptActions: [],
  });
}

function dedupeSuccesses(
  successes: Array<Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>>,
): Array<Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>> {
  const byTransaction = new Map<string, Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>>();

  for (const success of [...successes].sort((left, right) => left.observation.id.localeCompare(right.observation.id))) {
    const transactionRef = success.observation.providerTransactionRef!;
    if (!byTransaction.has(transactionRef)) {
      byTransaction.set(transactionRef, success);
    }
  }

  return [...byTransaction.values()].sort((left, right) =>
    left.observation.providerTransactionRef!.localeCompare(right.observation.providerTransactionRef!),
  );
}

function hasContradictoryEvidence(classified: ClassifiedObservation[]): boolean {
  return classified.some((entry) =>
    entry.kind === 'MATCHED_PENDING' ||
    entry.kind === 'MATCHED_UNKNOWN' ||
    entry.kind === 'MATCHED_TERMINAL_FAILURE',
  );
}

function resolvedReviewStatus(reviewStatus: AttemptSnapshot['reviewStatus']): {
  reviewStatus: AttemptSnapshot['reviewStatus'];
  completedByType: 'SYSTEM' | null;
} {
  if (reviewStatus === 'REQUIRED' || reviewStatus === 'IN_PROGRESS') {
    return {
      reviewStatus: 'COMPLETED',
      completedByType: 'SYSTEM',
    };
  }

  return {
    reviewStatus,
    completedByType: null,
  };
}

function unresolvedReviewStatus(reviewStatus: AttemptSnapshot['reviewStatus']): {
  reviewStatus: AttemptSnapshot['reviewStatus'];
  completedByType: 'SYSTEM' | null;
} {
  if (reviewStatus === 'IN_PROGRESS') {
    return {
      reviewStatus: 'IN_PROGRESS',
      completedByType: null,
    };
  }

  return {
    reviewStatus: 'REQUIRED',
    completedByType: null,
  };
}

function preserveUnresolvedReviewStatus(reviewStatus: AttemptSnapshot['reviewStatus']): {
  reviewStatus: AttemptSnapshot['reviewStatus'];
  completedByType: 'SYSTEM' | null;
} {
  return {
    reviewStatus,
    completedByType: null,
  };
}

function deriveSuccessDisposition(
  refundDue: Map<string, { providerTransactionRef: string; reason: 'LATE_SUCCESS_AFTER_CLOSURE' | 'SURPLUS_DOUBLE_SUCCESS' }>,
  attention: Set<ReductionAttentionType>,
): string {
  const refundReasons = [...refundDue.values()].map((entry) => entry.reason);

  if (refundReasons.includes('SURPLUS_DOUBLE_SUCCESS')) {
    return 'DOUBLE_SUCCESS_DETECTED';
  }

  if (refundReasons.includes('LATE_SUCCESS_AFTER_CLOSURE')) {
    return 'LATE_SUCCESS_AFTER_CLOSURE';
  }

  if (attention.has('CONTRADICTORY_EVIDENCE')) {
    return 'CONTRADICTORY_EVIDENCE';
  }

  return 'SUCCEEDED';
}

function finalizePlan(plan: ReductionPlan): ReductionPlan {
  return {
    ...plan,
    factTypes: sortFactTypes(plan.factTypes),
    refundDue: [...plan.refundDue].sort((left, right) =>
      `${left.providerTransactionRef}:${left.reason}`.localeCompare(
        `${right.providerTransactionRef}:${right.reason}`,
      ),
    ),
    attention: [...plan.attention].sort((left, right) => left.type.localeCompare(right.type)),
    relatedAttemptActions: [...plan.relatedAttemptActions].sort((left, right) =>
      `${left.attemptId}:${left.action}`.localeCompare(`${right.attemptId}:${right.action}`),
    ),
  };
}

function sortFactTypes(factTypes: ReductionFactType[]): ReductionFactType[] {
  const weight: Record<ReductionFactType, number> = {
    PAYMENT_SUCCEEDED: 0,
    PAYMENT_FAILED: 1,
    REFUND_DUE_DETECTED: 2,
  };

  return [...new Set(factTypes)].sort((left, right) => weight[left] - weight[right]);
}

function requireTargetAttempt(input: ReduceEvidenceInput): AttemptSnapshot {
  const targetAttempt = input.attempts.find((attempt) => attempt.id === input.targetAttemptId);
  if (!targetAttempt) {
    throw new Error('TARGET_ATTEMPT_NOT_FOUND');
  }
  return targetAttempt;
}
