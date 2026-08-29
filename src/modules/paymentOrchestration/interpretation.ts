import type { Prisma, ProviderObservationInterpretation } from '@prisma/client';
import type { CanonicalObservation, OutcomeStatus } from './types.js';

export interface DerivedInterpretation {
  originalObservationId: string;
  originalMappingVersion: string;
  derivedAdapterVersion: string;
  derivedMappingVersion: string;
  derivedOutcome: OutcomeStatus | 'UNMAPPED';
  derivedAt: Date;
}

export interface DerivedInterpretationInput {
  original: Pick<CanonicalObservation, 'id' | 'mappingVersion' | 'nativeStatus'>;
  derivedAdapterVersion: string;
  derivedMappingVersion: string;
  map(nativeStatus: string): OutcomeStatus | 'UNMAPPED';
  derivedAt: Date;
}

export interface AppendDerivedInterpretationInput extends DerivedInterpretationInput {
  original: Pick<CanonicalObservation, 'id' | 'mappingVersion' | 'nativeStatus' | 'merchantId' | 'obligationId' | 'attemptId'>;
}

export function deriveObservationInterpretation(input: DerivedInterpretationInput): DerivedInterpretation {
  return Object.freeze({
    originalObservationId: input.original.id,
    originalMappingVersion: input.original.mappingVersion,
    derivedAdapterVersion: input.derivedAdapterVersion,
    derivedMappingVersion: input.derivedMappingVersion,
    derivedOutcome: input.map(input.original.nativeStatus),
    derivedAt: input.derivedAt,
  });
}

export async function appendDerivedInterpretation(
  tx: Prisma.TransactionClient,
  input: AppendDerivedInterpretationInput,
): Promise<ProviderObservationInterpretation> {
  const derived = deriveObservationInterpretation(input);

  return tx.providerObservationInterpretation.upsert({
    where: {
      originalObservationId_derivedAdapterVersion_derivedMappingVersion: {
        originalObservationId: derived.originalObservationId,
        derivedAdapterVersion: derived.derivedAdapterVersion,
        derivedMappingVersion: derived.derivedMappingVersion,
      },
    },
    create: {
      originalObservationId: derived.originalObservationId,
      originalMappingVersion: derived.originalMappingVersion,
      merchantId: input.original.merchantId,
      obligationId: input.original.obligationId,
      attemptId: input.original.attemptId,
      derivedAdapterVersion: derived.derivedAdapterVersion,
      derivedMappingVersion: derived.derivedMappingVersion,
      derivedOutcome: derived.derivedOutcome,
      derivedAt: derived.derivedAt,
    } as Prisma.ProviderObservationInterpretationUncheckedCreateInput,
    update: {},
  });
}
