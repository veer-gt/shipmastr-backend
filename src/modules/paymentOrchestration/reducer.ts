import { matchObservation } from './matching.js';
import type {
  CanonicalObservation,
  MatchResult,
  ReduceEvidenceInput,
  ReductionAttentionType,
  ReductionFactEmission,
  ReductionFactType,
  ReductionPlan,
  RefundDueEntry,
} from './types.js';

type AttemptSnapshot = ReduceEvidenceInput['attempts'][number];

type ClassifiedObservation =
  | { kind: 'MATCHED_SUCCESS'; observation: CanonicalObservation; attempt: AttemptSnapshot }
  | {
      kind: 'MATCHED_TERMINAL_FAILURE';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot;
      outcomeStatus: 'FAILED_TERMINAL' | 'NOT_FOUND_TERMINAL';
    }
  | { kind: 'MATCHED_PENDING'; observation: CanonicalObservation; attempt: AttemptSnapshot }
  | { kind: 'MATCHED_UNKNOWN'; observation: CanonicalObservation; attempt: AttemptSnapshot }
  | { kind: 'MAPPING_GAP'; observation: CanonicalObservation; attempt: AttemptSnapshot | null }
  | { kind: 'INTEGRITY_CONFLICT'; observation: CanonicalObservation; attempt: AttemptSnapshot | null }
  | {
      kind: 'NON_MATCHING';
      observation: CanonicalObservation;
      attempt: AttemptSnapshot | null;
      matchResult: Exclude<MatchResult, { matched: true }>;
    };

export function reduceEvidence(input: ReduceEvidenceInput): ReductionPlan {
  const targetAttempt = requireTargetAttempt(input);
  const classified = classifyAndDedupe(input);
  const targetEvidence = classified.filter((entry) => entry.attempt?.id === targetAttempt.id);
  const targetSuccesses = entriesOfKind(targetEvidence, 'MATCHED_SUCCESS');

  if (targetSuccesses.length > 0) {
    return reduceTargetSuccess(input, targetAttempt, classified, targetEvidence, targetSuccesses);
  }

  if (targetEvidence.some((entry) => entry.kind === 'INTEGRITY_CONFLICT')) {
    return integrityConflictPlan(targetAttempt);
  }

  if (targetEvidence.some((entry) => entry.kind === 'MAPPING_GAP')) {
    return mappingGapPlan(targetAttempt);
  }

  const terminalFailures = entriesOfKind(targetEvidence, 'MATCHED_TERMINAL_FAILURE');
  if (terminalFailures.length > 0) {
    return terminalFailurePlan(input, targetAttempt, terminalFailures);
  }

  return unresolvedPlan(targetAttempt, targetEvidence, relatedAttemptActions(input, classified));
}

function classifyAndDedupe(input: ReduceEvidenceInput): ClassifiedObservation[] {
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const groups = new Map<string, CanonicalObservation[]>();

  for (const observation of input.observations) {
    const key = observation.providerEventId === null
      ? `observation:${observation.id}`
      : `event:${observation.provider}:${observation.environment}:${observation.attemptId}:${observation.providerEventId}`;
    const existing = groups.get(key);
    if (existing) existing.push(observation);
    else groups.set(key, [observation]);
  }

  const result: ClassifiedObservation[] = [];
  for (const key of [...groups.keys()].sort()) {
    const orderedGroup = [...groups.get(key)!].sort((left, right) => left.id.localeCompare(right.id));
    const representative = orderedGroup[0]!;
    const attempt = attemptsById.get(representative.attemptId) ?? null;

    if (
      representative.providerEventId !== null &&
      new Set(orderedGroup.map((observation) => observation.rawBodyHash)).size > 1
    ) {
      result.push({ kind: 'INTEGRITY_CONFLICT', observation: representative, attempt });
      continue;
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

    const match = matchObservation({ observation: representative, obligation: input.obligation, attempt });
    if (!match.matched) {
      if (match.reason === 'UNMAPPED_STATUS') {
        result.push({ kind: 'MAPPING_GAP', observation: representative, attempt });
      } else {
        result.push({ kind: 'NON_MATCHING', observation: representative, attempt, matchResult: match });
      }
      continue;
    }

    switch (representative.mappedOutcome) {
      case 'SUCCEEDED':
        result.push({ kind: 'MATCHED_SUCCESS', observation: representative, attempt });
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
        result.push({ kind: 'MATCHED_UNKNOWN', observation: representative, attempt });
        break;
      case 'PENDING':
        result.push({ kind: 'MATCHED_PENDING', observation: representative, attempt });
        break;
      case 'UNMAPPED':
        result.push({ kind: 'MAPPING_GAP', observation: representative, attempt });
        break;
    }
  }

  return result;
}

function reduceTargetSuccess(
  input: ReduceEvidenceInput,
  targetAttempt: AttemptSnapshot,
  classified: ClassifiedObservation[],
  targetEvidence: ClassifiedObservation[],
  targetSuccesses: Array<Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>>,
): ReductionPlan {
  const distinctSuccesses = dedupeSuccesses(entriesOfKind(classified, 'MATCHED_SUCCESS'), input);
  const triggeringSuccess = newTriggeringEntry(input, targetSuccesses);
  const triggeringFailure = newTriggeringEntry(
    input,
    entriesOfKind(targetEvidence, 'MATCHED_TERMINAL_FAILURE'),
  );
  const attention = new Set<ReductionAttentionType>();
  const refunds: RefundDueEntry[] = [];
  const emissions: ReductionFactEmission[] = [];

  if (hasContradictoryEvidence(targetEvidence)) attention.add('CONTRADICTORY_EVIDENCE');
  if (targetEvidence.some((entry) => entry.kind === 'INTEGRITY_CONFLICT')) attention.add('INTEGRITY_CONFLICT');
  if (targetEvidence.some((entry) => entry.kind === 'MAPPING_GAP')) attention.add('MAPPING_GAP');

  if (triggeringSuccess) {
    emissions.push(factEmission('PAYMENT_SUCCEEDED', triggeringSuccess));
    const captureKey = captureIdentity(input, triggeringSuccess);
    const hasOtherCapture = distinctSuccesses.some((entry) => captureIdentity(input, entry) !== captureKey);
    const sameCaptureAlreadyObserved = entriesOfKind(classified, 'MATCHED_SUCCESS').some((entry) =>
      entry.observation.id !== triggeringSuccess.observation.id &&
      captureIdentity(input, entry) === captureKey,
    );

    if (input.obligation.status === 'EXPIRED' || input.obligation.status === 'CANCELLED') {
      if (!sameCaptureAlreadyObserved) {
        refunds.push(refundEntry(input, triggeringSuccess, 'LATE_SUCCESS_AFTER_CLOSURE'));
      }
    } else if (input.obligation.status === 'SATISFIED' && hasOtherCapture && !sameCaptureAlreadyObserved) {
      attention.add('DOUBLE_SUCCESS_DETECTED');
      refunds.push(refundEntry(input, triggeringSuccess, 'SURPLUS_DOUBLE_SUCCESS'));
    }
  }
  if (triggeringFailure) {
    emissions.push(factEmission('PAYMENT_FAILED', triggeringFailure));
  }

  for (const refund of refunds) {
    emissions.push({
      factType: 'REFUND_DUE_DETECTED',
      sourceAttemptId: refund.sourceAttemptId,
      sourceObservationId: refund.sourceObservationId,
      provider: refund.provider,
      providerReferenceId: refund.providerTransactionRef,
    });
  }

  const review = resolvedReviewStatus(targetAttempt.reviewStatus);
  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus: 'SUCCEEDED',
    resolved: true,
    satisfyObligation: input.obligation.status === 'OPEN',
    reviewStatus: review.reviewStatus,
    completedByType: review.completedByType,
    disposition: deriveSuccessDisposition(refunds, attention),
    factTypes: emissions.map((entry) => entry.factType),
    factEmissions: emissions,
    refundDue: refunds,
    attention: [...attention].map((type) => ({ type })),
    relatedAttemptActions: relatedAttemptActions(input, classified),
  });
}

function terminalFailurePlan(
  input: ReduceEvidenceInput,
  targetAttempt: AttemptSnapshot,
  terminalFailures: Array<Extract<ClassifiedObservation, { kind: 'MATCHED_TERMINAL_FAILURE' }>>,
): ReductionPlan {
  const nextOutcome = terminalFailures.some((entry) => entry.outcomeStatus === 'FAILED_TERMINAL')
    ? 'FAILED_TERMINAL'
    : 'NOT_FOUND_TERMINAL';
  const review = resolvedReviewStatus(targetAttempt.reviewStatus);
  const trigger = newTriggeringEntry(input, terminalFailures);
  const emissions = trigger ? [factEmission('PAYMENT_FAILED', trigger)] : [];
  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus: nextOutcome,
    resolved: true,
    satisfyObligation: false,
    reviewStatus: review.reviewStatus,
    completedByType: review.completedByType,
    disposition: nextOutcome === 'FAILED_TERMINAL' ? 'TERMINAL_FAILURE' : 'NOT_FOUND_TERMINAL',
    factTypes: emissions.map((entry) => entry.factType),
    factEmissions: emissions,
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
    factEmissions: [],
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
    factEmissions: [],
    refundDue: [],
    attention: [{ type: 'MAPPING_GAP' }],
    relatedAttemptActions: [],
  });
}

function unresolvedPlan(
  targetAttempt: AttemptSnapshot,
  targetEvidence: ClassifiedObservation[],
  relatedActions: ReductionPlan['relatedAttemptActions'],
): ReductionPlan {
  const terminalAlready = targetAttempt.resolvedAt !== null;
  const outcomeStatus = terminalAlready
    ? targetAttempt.outcomeStatus
    : targetEvidence.some((entry) => entry.kind === 'MATCHED_UNKNOWN')
      ? 'UNKNOWN'
      : targetAttempt.outcomeStatus;
  return finalizePlan({
    attemptId: targetAttempt.id,
    outcomeStatus,
    resolved: terminalAlready,
    satisfyObligation: false,
    reviewStatus: targetAttempt.reviewStatus,
    completedByType: null,
    disposition: terminalAlready ? terminalDisposition(outcomeStatus) : outcomeStatus === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING',
    factTypes: [],
    factEmissions: [],
    refundDue: [],
    attention: [],
    relatedAttemptActions: relatedActions,
  });
}

function dedupeSuccesses(
  successes: Array<Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>>,
  input: ReduceEvidenceInput,
) {
  const byCapture = new Map<string, Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>>();
  for (const success of [...successes].sort((left, right) => left.observation.id.localeCompare(right.observation.id))) {
    const key = captureIdentity(input, success);
    if (!byCapture.has(key)) byCapture.set(key, success);
  }
  return [...byCapture.values()];
}

function newTriggeringEntry<T extends ClassifiedObservation>(input: ReduceEvidenceInput, entries: T[]): T | null {
  if (!input.triggeringObservationIsNew || input.triggeringObservationId === null) return null;
  return entries.find((entry) => entry.observation.id === input.triggeringObservationId) ?? null;
}

function factEmission(
  factType: Exclude<ReductionFactType, 'REFUND_DUE_DETECTED'>,
  entry: Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' | 'MATCHED_TERMINAL_FAILURE' }>,
): ReductionFactEmission {
  return {
    factType,
    sourceAttemptId: entry.attempt.id,
    sourceObservationId: entry.observation.id,
    provider: entry.attempt.provider,
    providerReferenceId: factType === 'PAYMENT_SUCCEEDED'
      ? entry.observation.providerTransactionRef ?? entry.observation.providerEventId ?? entry.observation.id
      : entry.observation.providerEventId ?? entry.observation.id,
  };
}

function refundEntry(
  input: ReduceEvidenceInput,
  entry: Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>,
  reason: RefundDueEntry['reason'],
): RefundDueEntry {
  return {
    captureKey: captureIdentity(input, entry),
    providerTransactionRef: entry.observation.providerTransactionRef!,
    reason,
    sourceAttemptId: entry.attempt.id,
    sourceObservationId: entry.observation.id,
    provider: entry.attempt.provider,
  };
}

function captureIdentity(
  input: ReduceEvidenceInput,
  entry: Extract<ClassifiedObservation, { kind: 'MATCHED_SUCCESS' }>,
) {
  return `${input.obligation.merchantId}:${input.obligation.id}:${entry.attempt.provider}:${entry.observation.providerTransactionRef!}`;
}

function hasContradictoryEvidence(classified: ClassifiedObservation[]) {
  return classified.some((entry) =>
    entry.kind === 'MATCHED_PENDING' || entry.kind === 'MATCHED_UNKNOWN' || entry.kind === 'MATCHED_TERMINAL_FAILURE',
  );
}

function relatedAttemptActions(input: ReduceEvidenceInput, classified: ClassifiedObservation[]) {
  if (!classified.some((entry) => entry.kind === 'MATCHED_SUCCESS')) return [];
  return input.attempts
    .filter((attempt) => attempt.id !== input.targetAttemptId)
    .map((attempt) => ({
      attemptId: attempt.id,
      action: attempt.resolvedAt === null ? 'KEEP_UNRESOLVED_LOCKED' as const : 'PRESERVE_TERMINAL' as const,
    }));
}

function resolvedReviewStatus(reviewStatus: AttemptSnapshot['reviewStatus']) {
  if (reviewStatus === 'REQUIRED' || reviewStatus === 'IN_PROGRESS') {
    return { reviewStatus: 'COMPLETED' as const, completedByType: 'SYSTEM' as const };
  }
  return { reviewStatus, completedByType: null };
}

function unresolvedReviewStatus(reviewStatus: AttemptSnapshot['reviewStatus']) {
  if (reviewStatus === 'IN_PROGRESS') return { reviewStatus: 'IN_PROGRESS' as const, completedByType: null };
  return { reviewStatus: 'REQUIRED' as const, completedByType: null };
}

function deriveSuccessDisposition(refunds: RefundDueEntry[], attention: Set<ReductionAttentionType>) {
  if (refunds.some((entry) => entry.reason === 'SURPLUS_DOUBLE_SUCCESS')) return 'DOUBLE_SUCCESS_DETECTED';
  if (refunds.some((entry) => entry.reason === 'LATE_SUCCESS_AFTER_CLOSURE')) return 'LATE_SUCCESS_AFTER_CLOSURE';
  if (attention.has('CONTRADICTORY_EVIDENCE')) return 'CONTRADICTORY_EVIDENCE';
  return 'SUCCEEDED';
}

function terminalDisposition(outcome: AttemptSnapshot['outcomeStatus']) {
  if (outcome === 'SUCCEEDED') return 'SUCCEEDED';
  if (outcome === 'FAILED_TERMINAL') return 'TERMINAL_FAILURE';
  if (outcome === 'NOT_FOUND_TERMINAL') return 'NOT_FOUND_TERMINAL';
  return outcome;
}

function entriesOfKind<K extends ClassifiedObservation['kind']>(entries: ClassifiedObservation[], kind: K) {
  return entries.filter(
    (entry): entry is Extract<ClassifiedObservation, { kind: K }> => entry.kind === kind,
  );
}

function finalizePlan(plan: ReductionPlan): ReductionPlan {
  return {
    ...plan,
    factTypes: sortFactTypes(plan.factEmissions.map((entry) => entry.factType)),
    factEmissions: [...plan.factEmissions].sort((left, right) =>
      `${left.factType}:${left.sourceAttemptId}:${left.sourceObservationId}`.localeCompare(
        `${right.factType}:${right.sourceAttemptId}:${right.sourceObservationId}`,
      ),
    ),
    refundDue: [...plan.refundDue].sort((left, right) => left.captureKey.localeCompare(right.captureKey)),
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
  if (!targetAttempt) throw new Error('TARGET_ATTEMPT_NOT_FOUND');
  return targetAttempt;
}
