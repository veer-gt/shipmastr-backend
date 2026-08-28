import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseInrPaise } from "../money.js";

const enabled = process.env.RUN_PGO1_POSTGRES_TESTS === "1";
const prisma = new PrismaClient();
const MAX_PAISE = 9_223_372_036_854_775_807n;
type AttemptOutcome = Prisma.PaymentAttemptUncheckedCreateInput["outcomeStatus"];

let sequence = 0;

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

function assertScratchUrl() {
  const raw = process.env.DATABASE_URL ?? "";
  const url = new URL(raw);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname.toLowerCase()));
  assert.equal(url.port, "5433");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "shipmastr_scratch_pgo1_a965f431");
  return url;
}

function isPrismaCode(error: unknown, code: string): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isBindingViolation(error: unknown) {
  return isPrismaCode(error, "P2003") || isPrismaCode(error, "P2004");
}

function obligation(overrides: Partial<Prisma.PaymentObligationUncheckedCreateInput> = {}): Prisma.PaymentObligationUncheckedCreateInput {
  const merchantId = overrides.merchantId ?? nextId("merchant");

  return {
    id: overrides.id ?? nextId("obligation"),
    merchantId,
    checkoutId: overrides.checkoutId ?? nextId("checkout"),
    collectionRail: overrides.collectionRail ?? "ONLINE",
    purpose: overrides.purpose ?? "FULL_ONLINE",
    amountPaise: overrides.amountPaise ?? 10_000n,
    currency: overrides.currency ?? "INR",
    status: overrides.status ?? "OPEN",
    satisfiedAt: overrides.satisfiedAt ?? null
  };
}

async function createObligation(overrides: Partial<Prisma.PaymentObligationUncheckedCreateInput> = {}) {
  const data = obligation(overrides);
  await prisma.paymentObligation.create({ data });
  return data;
}

function attempt(overrides: Partial<Prisma.PaymentAttemptUncheckedCreateInput> = {}): Prisma.PaymentAttemptUncheckedCreateInput {
  const merchantId = overrides.merchantId ?? nextId("merchant");
  const obligationId = overrides.obligationId ?? nextId("obligation_ref");

  return {
    id: overrides.id ?? nextId("attempt"),
    obligationId,
    merchantId,
    obligationCollectionRail: overrides.obligationCollectionRail ?? "ONLINE",
    provider: overrides.provider ?? "MOCK",
    environment: overrides.environment ?? "TEST",
    credentialBindingId: overrides.credentialBindingId ?? nextId("binding"),
    credentialVersionId: overrides.credentialVersionId ?? nextId("credential_version"),
    requestIdempotencyKey: overrides.requestIdempotencyKey ?? nextId("request"),
    providerOrderRef: overrides.providerOrderRef ?? nextId("provider_order"),
    outcomeStatus: overrides.outcomeStatus ?? "PENDING",
    reviewStatus: overrides.reviewStatus ?? "NOT_REQUIRED",
    resolvedAt: overrides.resolvedAt ?? null,
    lastOutcomeChangedAt: overrides.lastOutcomeChangedAt ?? new Date("2026-08-27T12:00:00.000Z"),
    lastObservationAt: overrides.lastObservationAt ?? null,
    adapterVersion: overrides.adapterVersion ?? "mock-adapter-v1",
    mappingVersion: overrides.mappingVersion ?? "mock-mapping-v1"
  };
}

async function createAttemptWithObligation(overrides: Partial<Prisma.PaymentAttemptUncheckedCreateInput> = {}) {
  const merchantId = overrides.merchantId ?? nextId("merchant");
  const obligationData = await createObligation(
    overrides.obligationId === undefined
      ? { merchantId }
      : { id: overrides.obligationId, merchantId }
  );
  const obligationId = obligationData.id as string;
  return prisma.paymentAttempt.create({
    data: attempt({
      merchantId,
      obligationId,
      ...overrides
    })
  });
}

async function unresolvedAttempt(id: string) {
  return createAttemptWithObligation({
    id,
    outcomeStatus: "PENDING",
    reviewStatus: "NOT_REQUIRED",
    resolvedAt: null
  });
}

async function terminalAttempt(id: string, outcomeStatus: AttemptOutcome) {
  return createAttemptWithObligation({
    id,
    outcomeStatus,
    reviewStatus: "COMPLETED",
    resolvedAt: new Date("2026-08-27T12:05:00.000Z")
  });
}

function observation(overrides: Partial<Prisma.ProviderObservationUncheckedCreateInput> = {}): Prisma.ProviderObservationUncheckedCreateInput {
  const merchantId = overrides.merchantId ?? nextId("merchant");
  const obligationId = overrides.obligationId ?? nextId("observation_obligation");
  const attemptId = overrides.attemptId ?? nextId("observation_attempt");

  return {
    id: overrides.id ?? nextId("observation"),
    attemptId,
    obligationId,
    merchantId,
    provider: overrides.provider ?? "MOCK",
    environment: overrides.environment ?? "TEST",
    credentialBindingId: overrides.credentialBindingId ?? nextId("binding"),
    credentialVersionId: overrides.credentialVersionId ?? nextId("credential_version"),
    source: overrides.source ?? "MOCK",
    providerEventId: overrides.providerEventId ?? nextId("provider_event"),
    providerOrderRef: overrides.providerOrderRef ?? nextId("provider_order"),
    providerTransactionRef: overrides.providerTransactionRef ?? nextId("provider_txn"),
    nativeStatus: overrides.nativeStatus ?? "SUCCESS",
    nativeReasonCode: overrides.nativeReasonCode ?? null,
    nativeAmountText: overrides.nativeAmountText ?? "100.00",
    nativeCurrency: overrides.nativeCurrency ?? "INR",
    amountPaise: overrides.amountPaise ?? 10_000n,
    rawBodyHash: overrides.rawBodyHash ?? nextId("hash"),
    hashAlgorithm: overrides.hashAlgorithm ?? "SHA256",
    signatureVerification: overrides.signatureVerification ?? "VERIFIED",
    bindingVerification: overrides.bindingVerification ?? "MATCHED",
    evidenceAuthority: overrides.evidenceAuthority ?? "ELIGIBLE",
    adapterVersion: overrides.adapterVersion ?? "mock-adapter-v1",
    mappingVersion: overrides.mappingVersion ?? "mock-mapping-v1",
    providerOccurredAt: overrides.providerOccurredAt ?? new Date("2026-08-27T12:00:00.000Z"),
    receivedAt: overrides.receivedAt ?? new Date("2026-08-27T12:00:01.000Z"),
    reductionDisposition: overrides.reductionDisposition ?? "ACCEPTED",
    observationDedupeKey: overrides.observationDedupeKey ?? nextId("observation_dedupe")
  };
}

async function createObservationWithAttempt(overrides: Partial<Prisma.ProviderObservationUncheckedCreateInput> = {}) {
  const merchantId = overrides.merchantId ?? nextId("merchant");
  const obligationData = await createObligation(
    overrides.obligationId === undefined
      ? { merchantId }
      : { id: overrides.obligationId, merchantId }
  );
  const obligationId = obligationData.id as string;
  const createdAttempt = await prisma.paymentAttempt.create({
    data: attempt({
      obligationId,
      merchantId,
      ...(overrides.attemptId === undefined ? {} : { id: overrides.attemptId })
    })
  });
  return prisma.providerObservation.create({
    data: observation({
      merchantId,
      obligationId,
      attemptId: createdAttempt.id,
      ...overrides
    })
  });
}

async function createFactWithAttempt(overrides: Partial<Prisma.PaymentNormalizedFactOutboxUncheckedCreateInput> = {}) {
  const merchantId = overrides.merchantId ?? nextId("merchant");
  const obligationData = await createObligation(
    overrides.obligationId === undefined
      ? { merchantId }
      : { id: overrides.obligationId, merchantId }
  );
  const obligationId = obligationData.id as string;
  const createdAttempt = await prisma.paymentAttempt.create({
    data: attempt({
      obligationId,
      merchantId,
      ...(overrides.attemptId === undefined ? {} : { id: overrides.attemptId })
    })
  });
  const createdObservation = await prisma.providerObservation.create({
    data: observation({
      merchantId,
      obligationId,
      attemptId: createdAttempt.id,
      ...(overrides.triggeringObservationId === undefined ? {} : { id: overrides.triggeringObservationId })
    })
  });

  return prisma.paymentNormalizedFactOutbox.create({
    data: {
      id: overrides.id ?? nextId("fact"),
      schemaVersion: overrides.schemaVersion ?? "pgo1-fact-v1",
      merchantId,
      obligationId,
      attemptId: createdAttempt.id,
      triggeringObservationId: createdObservation.id,
      factType: overrides.factType ?? "REFUND_DUE_DETECTED",
      amountPaise: overrides.amountPaise ?? 10_000n,
      currency: overrides.currency ?? "INR",
      provider: overrides.provider ?? "MOCK",
      providerReferenceId: overrides.providerReferenceId ?? nextId("provider_ref"),
      dedupeKey: overrides.dedupeKey ?? nextId("fact_dedupe"),
      reducerVersion: overrides.reducerVersion ?? "reducer-v1",
      adapterVersion: overrides.adapterVersion ?? "mock-adapter-v1",
      mappingVersion: overrides.mappingVersion ?? "mock-mapping-v1"
    }
  });
}

async function createRefundDueCaseWithAttempt(overrides: Partial<Prisma.RefundDueCaseUncheckedCreateInput> = {}) {
  const merchantId = overrides.merchantId ?? nextId("merchant");
  const obligationData = await createObligation(
    overrides.obligationId === undefined
      ? { merchantId }
      : { id: overrides.obligationId, merchantId }
  );
  const obligationId = obligationData.id as string;
  const createdAttempt = await prisma.paymentAttempt.create({
    data: attempt({
      merchantId,
      obligationId,
      outcomeStatus: "SUCCEEDED",
      resolvedAt: new Date("2026-08-27T12:06:00.000Z"),
      reviewStatus: "COMPLETED",
      ...(overrides.attemptId === undefined ? {} : { id: overrides.attemptId })
    })
  });

  return prisma.refundDueCase.create({
    data: {
      id: overrides.id ?? nextId("refund_due"),
      merchantId,
      obligationId,
      attemptId: createdAttempt.id,
      provider: overrides.provider ?? "MOCK",
      providerTransactionRef: overrides.providerTransactionRef ?? nextId("provider_txn"),
      amountPaise: overrides.amountPaise ?? 10_000n,
      currency: overrides.currency ?? "INR",
      reason: overrides.reason ?? "LATE_SUCCESS_AFTER_CLOSURE",
      status: overrides.status ?? "OPEN",
      dedupeKey: overrides.dedupeKey ?? nextId("refund_dedupe"),
      detectedAt: overrides.detectedAt ?? new Date("2026-08-27T12:07:00.000Z"),
      acknowledgedAt: overrides.acknowledgedAt ?? null,
      escalatedAt: overrides.escalatedAt ?? null,
      verifiedClosedAt: overrides.verifiedClosedAt ?? null,
      verificationObservationId: overrides.verificationObservationId ?? null
    }
  });
}

if (enabled) {
  describe("payment orchestration PostgreSQL constraints", () => {
    before(async () => {
      const url = assertScratchUrl();
      const current = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      assert.equal(current[0]?.name, decodeURIComponent(url.pathname.slice(1)));
    });

    beforeEach(async () => {
      await prisma.providerObservationInterpretation.deleteMany();
      await prisma.providerObservationDelivery.deleteMany();
      await prisma.paymentNormalizedFactOutbox.deleteMany();
      await prisma.refundDueCase.deleteMany();
      await prisma.paymentAttentionSignal.deleteMany();
      await prisma.reconciliationReviewHistory.deleteMany();
      await prisma.paymentOutcomeTransition.deleteMany();
      await prisma.providerObservation.deleteMany();
      await prisma.paymentAttempt.deleteMany();
      await prisma.paymentObligation.deleteMany();
    });

    after(async () => {
      await prisma.$disconnect();
    });

    it("rejects a second unresolved attempt for one obligation", async () => {
      const merchantId = nextId("merchant");
      const baseObligation = await createObligation({ merchantId });
      const obligationId = baseObligation.id as string;
      await prisma.paymentAttempt.create({
        data: attempt({
          id: "a_1",
          merchantId,
          obligationId
        })
      });
      await assert.rejects(
        prisma.paymentAttempt.create({
          data: attempt({
            id: "a_2",
            merchantId,
            obligationId
          })
        }),
        (error: unknown) => isPrismaCode(error, "P2002")
      );
    });

    it("permits a later attempt only after the prior attempt is resolved", async () => {
      const merchantId = nextId("merchant");
      const baseObligation = await createObligation({ merchantId });
      const obligationId = baseObligation.id as string;
      await prisma.paymentAttempt.create({
        data: attempt({
          id: "a_1",
          merchantId,
          obligationId,
          outcomeStatus: "FAILED_TERMINAL",
          reviewStatus: "COMPLETED",
          resolvedAt: new Date("2026-08-27T12:05:00.000Z")
        })
      });
      assert.ok(await prisma.paymentAttempt.create({
        data: attempt({
          id: "a_2",
          merchantId,
          obligationId
        })
      }));
    });

    for (const [outcomeStatus, resolvedAt] of [
      ["SUCCEEDED", null],
      ["PENDING", new Date("2026-08-27T12:05:00.000Z")],
      ["UNKNOWN", new Date("2026-08-27T12:05:00.000Z")]
    ] as const) {
      it(`rejects inconsistent outcome ${outcomeStatus} and resolvedAt`, async () => {
        await assert.rejects(createAttemptWithObligation({ outcomeStatus, resolvedAt }));
      });
    }

    it("rejects COMPLETED review without a resolved outcome", async () => {
      await assert.rejects(createAttemptWithObligation({ reviewStatus: "COMPLETED", resolvedAt: null }));
    });

    it("rejects resolved attempts left in REQUIRED review", async () => {
      await assert.rejects(createAttemptWithObligation({
        outcomeStatus: "FAILED_TERMINAL",
        reviewStatus: "REQUIRED",
        resolvedAt: new Date("2026-08-27T12:05:00.000Z")
      }));
    });

    it("rejects resolved attempts left in IN_PROGRESS review", async () => {
      await assert.rejects(createAttemptWithObligation({
        outcomeStatus: "FAILED_TERMINAL",
        reviewStatus: "IN_PROGRESS",
        resolvedAt: new Date("2026-08-27T12:05:00.000Z")
      }));
    });

    it("rejects non-INR obligations", async () => {
      await assert.rejects(prisma.paymentObligation.create({
        data: obligation({ currency: "USD" })
      }));
    });

    it("rejects zero and negative obligation amounts", async () => {
      await assert.rejects(prisma.paymentObligation.create({ data: obligation({ amountPaise: 0n }) }));
      await assert.rejects(prisma.paymentObligation.create({ data: obligation({ amountPaise: -1n }) }));
    });

    it("rejects invalid collection-rail and purpose pairs", async () => {
      await assert.rejects(prisma.paymentObligation.create({
        data: obligation({ collectionRail: "ONLINE", purpose: "COD_DELIVERY_BALANCE" })
      }));
      await assert.rejects(prisma.paymentObligation.create({
        data: obligation({ collectionRail: "COD", purpose: "FULL_ONLINE" })
      }));
    });

    it("rejects attempts on COD delivery-balance obligations", async () => {
      const codObligation = await createObligation({
        collectionRail: "COD",
        purpose: "COD_DELIVERY_BALANCE"
      });

      await assert.rejects(
        prisma.paymentAttempt.create({
          data: attempt({
            merchantId: codObligation.merchantId,
            obligationId: codObligation.id as string
          })
        }),
        isBindingViolation
      );
    });

    it("rejects cross-merchant attempt and obligation mismatches", async () => {
      const baseObligation = await createObligation({ merchantId: "merchant_alpha" });

      await assert.rejects(
        prisma.paymentAttempt.create({
          data: attempt({
            merchantId: "merchant_beta",
            obligationId: baseObligation.id as string
          })
        }),
        isBindingViolation
      );
    });

    it("rejects provider observations whose attempt and obligation bindings do not match", async () => {
      const leftObligation = await createObligation({ merchantId: "merchant_obs" });
      const rightObligation = await createObligation({ merchantId: "merchant_obs" });
      const createdAttempt = await prisma.paymentAttempt.create({
        data: attempt({
          merchantId: "merchant_obs",
          obligationId: leftObligation.id as string
        })
      });

      await assert.rejects(
        prisma.providerObservation.create({
          data: observation({
            merchantId: "merchant_obs",
            attemptId: createdAttempt.id,
            obligationId: rightObligation.id as string
          })
        }),
        isBindingViolation
      );
    });

    it("rejects non-INR normalized facts", async () => {
      await assert.rejects(createFactWithAttempt({ currency: "USD" }));
    });

    it("rejects zero and negative normalized fact amounts", async () => {
      await assert.rejects(createFactWithAttempt({ amountPaise: 0n }));
      await assert.rejects(createFactWithAttempt({ amountPaise: -1n }));
    });

    it("rejects non-INR refund due cases", async () => {
      await assert.rejects(createRefundDueCaseWithAttempt({ currency: "USD" }));
    });

    it("rejects zero and negative refund due amounts", async () => {
      await assert.rejects(createRefundDueCaseWithAttempt({ amountPaise: 0n }));
      await assert.rejects(createRefundDueCaseWithAttempt({ amountPaise: -1n }));
    });

    it("rejects overflow before any accepted amount reaches PostgreSQL", () => {
      assert.throws(() => parseInrPaise("92233720368547758.08"), /INVALID_INR_AMOUNT/);
      assert.equal(parseInrPaise("92233720368547758.07"), MAX_PAISE);
    });

    it("enforces merchant-scoped attempt request idempotency uniqueness", async () => {
      const merchantId = nextId("merchant");
      await createAttemptWithObligation({
        merchantId,
        requestIdempotencyKey: "same_request"
      });
      await assert.rejects(
        createAttemptWithObligation({
          merchantId,
          requestIdempotencyKey: "same_request"
        }),
        (error: unknown) => isPrismaCode(error, "P2002")
      );
    });

    it("dedupes provider observations by observation key", async () => {
      await createObservationWithAttempt({
        observationDedupeKey: "same_observation"
      });
      await assert.rejects(
        createObservationWithAttempt({
          observationDedupeKey: "same_observation"
        }),
        (error: unknown) => isPrismaCode(error, "P2002")
      );
    });

    it("dedupes normalized facts by deterministic dedupe key", async () => {
      await createFactWithAttempt({ dedupeKey: "same_fact" });
      await assert.rejects(
        createFactWithAttempt({ dedupeKey: "same_fact" }),
        (error: unknown) => isPrismaCode(error, "P2002")
      );
    });

    it("rejects normalized facts whose attempt and observation bindings do not match the obligation", async () => {
      const obligationA = await createObligation({ merchantId: "merchant_fact" });
      const obligationB = await createObligation({ merchantId: "merchant_fact" });
      const createdAttempt = await prisma.paymentAttempt.create({
        data: attempt({
          merchantId: "merchant_fact",
          obligationId: obligationA.id as string
        })
      });
      const createdObservation = await prisma.providerObservation.create({
        data: observation({
          merchantId: "merchant_fact",
          obligationId: obligationA.id as string,
          attemptId: createdAttempt.id
        })
      });

      await assert.rejects(
        prisma.paymentNormalizedFactOutbox.create({
          data: {
            id: nextId("fact"),
            schemaVersion: "pgo1-fact-v1",
            merchantId: "merchant_fact",
            obligationId: obligationB.id as string,
            attemptId: createdAttempt.id,
            triggeringObservationId: createdObservation.id,
            factType: "REFUND_DUE_DETECTED",
            amountPaise: 10_000n,
            currency: "INR",
            provider: "MOCK",
            providerReferenceId: nextId("provider_ref"),
            dedupeKey: nextId("fact_dedupe"),
            reducerVersion: "reducer-v1",
            adapterVersion: "mock-adapter-v1",
            mappingVersion: "mock-mapping-v1"
          }
        }),
        isBindingViolation
      );
    });

    it("dedupes refund due cases by deterministic dedupe key", async () => {
      await createRefundDueCaseWithAttempt({ dedupeKey: "same_refund" });
      await assert.rejects(
        createRefundDueCaseWithAttempt({ dedupeKey: "same_refund" }),
        (error: unknown) => isPrismaCode(error, "P2002")
      );
    });

    it("keeps the unresolved-attempt partial index predicate pinned only to resolvedAt nullness", async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexName: string; predicate: string | null }>>`
        SELECT
          indexrelid::regclass::text AS "indexName",
          pg_get_expr(indpred, indrelid) AS predicate
        FROM pg_index
        WHERE indrelid = '\"PaymentAttempt\"'::regclass
      `;

      const unresolvedIndex = indexes.find((row) => row.indexName === "payment_attempt_one_unresolved_per_obligation");
      assert.ok(unresolvedIndex);
      assert.equal(unresolvedIndex.predicate, '("resolvedAt" IS NULL)');
      assert.ok(!/outcomeStatus|SUCCEEDED|FAILED_TERMINAL|NOT_FOUND_TERMINAL/.test(unresolvedIndex.predicate));
    });

    it("dedupes derived interpretations by original observation and derived mapping versions", async () => {
      const originalObservation = await createObservationWithAttempt();
      const merchantId = originalObservation.merchantId;
      const obligationId = originalObservation.obligationId as string;
      const attemptId = originalObservation.attemptId;
      const derivedObservation = await prisma.providerObservation.create({
        data: observation({
          merchantId,
          obligationId,
          attemptId,
          evidenceAuthority: "ACTIVATION_GATED",
          reductionDisposition: "UNRESOLVED"
        })
      });

      await prisma.providerObservationInterpretation.create({
        data: {
          id: nextId("interpretation"),
          originalObservationId: originalObservation.id,
          derivedObservationId: derivedObservation.id,
          merchantId,
          obligationId,
          attemptId,
          derivedAdapterVersion: "cashfree-fixture-v1",
          derivedMappingVersion: "cashfree-map-v1"
        }
      });

      await assert.rejects(
        prisma.providerObservationInterpretation.create({
          data: {
            id: nextId("interpretation"),
            originalObservationId: originalObservation.id,
            derivedObservationId: derivedObservation.id,
            merchantId,
            obligationId,
            attemptId,
            derivedAdapterVersion: "cashfree-fixture-v1",
            derivedMappingVersion: "cashfree-map-v1"
          }
        }),
        (error: unknown) => isPrismaCode(error, "P2002")
      );
    });
  });
}
