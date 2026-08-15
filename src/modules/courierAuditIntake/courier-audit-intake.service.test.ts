import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import type { CourierAuditIntakeRequest } from "./courier-audit-intake.contract.js";
import {
  CourierAuditIntakeConflictError,
  getCourierAuditIntakeDetail,
  ingestCourierAuditIntake,
  listCourierAuditIntakes
} from "./courier-audit-intake.service.js";

const SOURCE_IDENTITY_TARGET = ["sourceProvider", "sourceAccountId", "providerMessageId"];
const firstCreatedAt = new Date("2026-08-07T16:00:01.000Z");

function requestFixture(overrides: {
  messageId?: string;
  subject?: string;
  bodySha256?: string;
} = {}): CourierAuditIntakeRequest {
  return {
    schemaVersion: "courier-audit-intake.v1",
    source: {
      provider: "GMAIL",
      accountId: "mailbox-workflow-01",
      messageId: overrides.messageId ?? "gmail-message-1001",
      threadId: "gmail-thread-77",
      receivedAt: "2026-08-07T15:58:45.123Z",
      from: {
        name: "  Acme   Billing  ",
        email: "billing@example.test"
      },
      subject: overrides.subject ?? "July courier statement",
      bodySha256: overrides.bodySha256 ?? "a".repeat(64),
      snippet: "Bounded source snippet"
    },
    attachments: [{
      sourceAttachmentId: "gmail-attachment-1",
      filename: "invoice-july.pdf",
      declaredMimeType: "application/pdf",
      detectedMimeType: "application/pdf",
      sizeBytes: 1_024,
      sha256: "b".repeat(64),
      artifactKind: "PDF",
      processingStatus: "PARSED_DETERMINISTIC",
      parser: "pdf-text-v1"
    }],
    extraction: {
      extractedAt: "2026-08-07T15:59:30.456Z",
      parserName: "courier-audit-parser",
      parserVersion: "1.2.3",
      mode: "DETERMINISTIC",
      modelProvider: null,
      modelName: null,
      promptVersion: null,
      result: {
        companyName: "  Acme   Logistics  ",
        contactName: "  Asha   Rao ",
        contactEmail: "not-an-email",
        contactPhone: "919876543210",
        courierName: "  Safe   Courier  ",
        documentKinds: ["COURIER_INVOICE"],
        invoiceNumbers: ["  INV-001  "],
        billingPeriodStart: "2026-07-01",
        billingPeriodEnd: "2026-07-31",
        currency: "inr",
        totalBilledAmount: "123.40",
        shipmentCount: 42,
        awbSamples: ["  AWB-001  "],
        summary: "  Monthly   invoice  "
      },
      warnings: [{
        code: "SOURCE_WARNING",
        message: "Producer supplied warning.",
        field: "summary"
      }],
      confidence: 0.91
    }
  };
}

function p2002(target: unknown, modelName = "CourierAuditIntake") {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName, target }
  });
}

type StoredIntake = { id: string; createdAt: Date; [key: string]: any };
type StoredRevision = { id: string; createdAt: Date; [key: string]: any };

function intakeRow(data: Record<string, unknown>, id: string, createdAt = firstCreatedAt) {
  return { id, createdAt, ...data };
}

function revisionRow(data: Record<string, unknown>, id: string, createdAt = firstCreatedAt) {
  return { id, createdAt, ...data };
}

function makeDatabase(options: {
  failRevisionCreate?: Error;
  transactionError?: unknown;
} = {}) {
  const state: {
    intakes: StoredIntake[];
    revisions: StoredRevision[];
    updateCalls: number;
    nextIntakeId: number;
    nextRevisionId: number;
  } = {
    intakes: [],
    revisions: [],
    updateCalls: 0,
    nextIntakeId: 1,
    nextRevisionId: 1
  };

  const identity = (data: any) => `${data.sourceProvider}\0${data.sourceAccountId}\0${data.providerMessageId}`;
  const findByIdentity = (rows: StoredIntake[], value: any) => rows.find((row) => identity(row) === identity(value));

  const model = (targetState: typeof state) => ({
    courierAuditIntake: {
      create: async ({ data }: any) => {
        if (findByIdentity(targetState.intakes, data)) {
          throw p2002(SOURCE_IDENTITY_TARGET);
        }
        const row = intakeRow(data, `intake-${targetState.nextIntakeId++}`);
        targetState.intakes.push(row);
        return row;
      },
      findUnique: async ({ where, include }: any) => {
        const row = where.id
          ? targetState.intakes.find((candidate) => candidate.id === where.id)
          : findByIdentity(targetState.intakes, where.sourceProvider_sourceAccountId_providerMessageId);
        if (!row) return null;
        if (!include?.revisions) return row;
        return {
          ...row,
          revisions: targetState.revisions
            .filter((revision) => revision.intakeId === row.id)
            .sort((left, right) => Number(left.revision) - Number(right.revision))
        };
      },
      findMany: async ({ take }: any) => targetState.intakes
        .slice()
        .sort((left, right) => {
          const dateOrder = (right.createdAt as Date).getTime() - (left.createdAt as Date).getTime();
          return dateOrder || String(right.id).localeCompare(String(left.id));
        })
        .slice(0, take)
        .map((row) => ({
          ...row,
          revisions: targetState.revisions
            .filter((revision) => revision.intakeId === row.id)
            .slice(0, 1)
        })),
      update: async () => {
        targetState.updateCalls += 1;
        throw new Error("intake rows are immutable");
      }
    },
    courierAuditExtractionRevision: {
      create: async ({ data }: any) => {
        if (options.failRevisionCreate) throw options.failRevisionCreate;
        const row = revisionRow(data, `revision-${targetState.nextRevisionId++}`);
        targetState.revisions.push(row);
        return row;
      },
      update: async () => {
        targetState.updateCalls += 1;
        throw new Error("revision rows are immutable");
      }
    }
  });

  const client = {
    ...model(state),
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      if (options.transactionError) throw options.transactionError;
      const draft = {
        ...state,
        intakes: state.intakes.map((row) => ({ ...row })),
        revisions: state.revisions.map((row) => ({ ...row }))
      };
      const result = await callback(model(draft));
      state.intakes = draft.intakes;
      state.revisions = draft.revisions;
      state.updateCalls = draft.updateCalls;
      state.nextIntakeId = draft.nextIntakeId;
      state.nextRevisionId = draft.nextRevisionId;
      return result;
    }
  };

  return { client: client as any, state };
}

describe("courier audit intake service", () => {
  it("atomically creates the immutable source parent and revision 1 with exact source and separate normalized values", async () => {
    const { client, state } = makeDatabase();
    const request = requestFixture();

    const result = await ingestCourierAuditIntake(request, client);

    assert.deepEqual(result, {
      intakeId: "intake-1",
      ingestionStatus: "VALIDATED",
      reviewStatus: "NEEDS_REVIEW",
      duplicate: false
    });
    assert.equal(state.intakes.length, 1);
    assert.equal(state.revisions.length, 1);
    assert.deepEqual(state.intakes[0], {
      id: "intake-1",
      createdAt: firstCreatedAt,
      sourceProvider: "GMAIL",
      sourceAccountId: "mailbox-workflow-01",
      providerMessageId: "gmail-message-1001",
      providerThreadId: "gmail-thread-77",
      sourceReceivedAt: new Date("2026-08-07T15:58:45.123Z"),
      senderName: "  Acme   Billing  ",
      senderEmail: "billing@example.test",
      subject: "July courier statement",
      bodySha256: "a".repeat(64),
      bodySnippet: "Bounded source snippet",
      sourceFingerprintSha256: "a229b189d04cf3a307e9cd2ad6354d4e27b7a39b198fd70686a01804bf9ebf19",
      attachmentManifest: request.attachments
    });
    assert.deepEqual(state.revisions[0], {
      id: "revision-1",
      createdAt: firstCreatedAt,
      intakeId: "intake-1",
      revision: 1,
      schemaVersion: "courier-audit-intake.v1",
      parserName: "courier-audit-parser",
      parserVersion: "1.2.3",
      mode: "DETERMINISTIC",
      modelProvider: null,
      modelName: null,
      promptVersion: null,
      extractedAt: new Date("2026-08-07T15:59:30.456Z"),
      extractionResult: request.extraction.result,
      normalizedProjection: {
        companyName: "Acme Logistics",
        contactName: "Asha Rao",
        contactEmail: null,
        contactPhoneE164: "+919876543210",
        courierName: "Safe Courier",
        documentKinds: ["COURIER_INVOICE"],
        invoiceNumbers: ["INV-001"],
        billingPeriodStart: "2026-07-01",
        billingPeriodEnd: "2026-07-31",
        currency: "INR",
        totalBilledMinorUnits: "12340",
        shipmentCount: 42,
        awbSamples: ["AWB-001"],
        summary: "Monthly invoice"
      },
      warnings: [
        ...request.extraction.warnings,
        {
          code: "INVALID_CONTACT_EMAIL",
          message: "Contact email could not be normalized deterministically.",
          field: "contactEmail"
        }
      ],
      confidence: 0.91
    });
    assert.notStrictEqual(state.revisions[0]?.extractionResult, state.revisions[0]?.normalizedProjection);
  });

  it("rolls back the parent if immutable revision 1 cannot be created", async () => {
    const revisionError = new Error("revision repository failed");
    const { client, state } = makeDatabase({ failRevisionCreate: revisionError });

    await assert.rejects(ingestCourierAuditIntake(requestFixture(), client), (error) => error === revisionError);
    assert.equal(state.intakes.length, 0);
    assert.equal(state.revisions.length, 0);
  });

  it("returns the same ID for an exact sequential duplicate without revision 2 or updates", async () => {
    const { client, state } = makeDatabase();
    const request = requestFixture();

    const first = await ingestCourierAuditIntake(request, client);
    const duplicate = await ingestCourierAuditIntake(request, client);

    assert.equal(duplicate.intakeId, first.intakeId);
    assert.deepEqual(duplicate, {
      intakeId: "intake-1",
      ingestionStatus: "VALIDATED",
      reviewStatus: "NEEDS_REVIEW",
      duplicate: true
    });
    assert.equal(state.intakes.length, 1);
    assert.deepEqual(state.revisions.map((revision) => revision.revision), [1]);
    assert.equal(state.updateCalls, 0);
  });

  it("throws a typed conflict for changed immutable source data and does not mutate the winner", async () => {
    const { client, state } = makeDatabase();
    await ingestCourierAuditIntake(requestFixture(), client);
    const before = structuredClone({ intakes: state.intakes, revisions: state.revisions });

    await assert.rejects(
      ingestCourierAuditIntake(requestFixture({ bodySha256: "c".repeat(64) }), client),
      (error) => error instanceof CourierAuditIntakeConflictError &&
        (error as CourierAuditIntakeConflictError).code === "COURIER_AUDIT_INTAKE_SOURCE_CONFLICT"
    );

    assert.deepEqual(state.intakes, before.intakes);
    assert.deepEqual(state.revisions, before.revisions);
    assert.equal(state.updateCalls, 0);
  });

  it("rethrows a P2002 that does not identify the source identity constraint", async () => {
    const unrelated = p2002(["intakeId", "revision"], "CourierAuditExtractionRevision");
    const { client } = makeDatabase({ transactionError: unrelated });

    await assert.rejects(ingestCourierAuditIntake(requestFixture(), client), (error) => error === unrelated);
  });

  it("rethrows an unrelated repository error unchanged", async () => {
    const repositoryError = new Error("database unavailable");
    const { client } = makeDatabase({ transactionError: repositoryError });

    await assert.rejects(ingestCourierAuditIntake(requestFixture(), client), (error) => error === repositoryError);
  });

  it("returns minimized list projections and a detail projection with fixed statuses", async () => {
    const { client } = makeDatabase();
    const created = await ingestCourierAuditIntake(requestFixture(), client);

    const list = await listCourierAuditIntakes({ limit: 25 }, client);
    assert.deepEqual(list, {
      items: [{
        id: created.intakeId,
        sourceProvider: "GMAIL",
        sourceReceivedAt: new Date("2026-08-07T15:58:45.123Z"),
        createdAt: firstCreatedAt,
        senderSummary: "Acme Billing",
        companySummary: "Acme Logistics",
        warningCount: 2,
        attachmentCount: 1,
        ingestionStatus: "VALIDATED",
        reviewStatus: "NEEDS_REVIEW"
      }],
      nextCursor: null
    });
    assert.equal(JSON.stringify(list).includes("billing@example.test"), false);
    assert.equal(JSON.stringify(list).includes("SOURCE_WARNING"), false);

    const detail = await getCourierAuditIntakeDetail(created.intakeId, client);
    assert.deepEqual(detail, {
      id: created.intakeId,
      createdAt: firstCreatedAt,
      source: {
        provider: "GMAIL",
        accountId: "mailbox-workflow-01",
        messageId: "gmail-message-1001",
        threadId: "gmail-thread-77",
        receivedAt: new Date("2026-08-07T15:58:45.123Z"),
        senderName: "  Acme   Billing  ",
        senderEmail: "billing@example.test",
        subject: "July courier statement",
        bodySha256: "a".repeat(64),
        snippet: "Bounded source snippet"
      },
      attachments: requestFixture().attachments,
      revision: {
        revision: 1,
        schemaVersion: "courier-audit-intake.v1",
        parserName: "courier-audit-parser",
        parserVersion: "1.2.3",
        mode: "DETERMINISTIC",
        modelProvider: null,
        modelName: null,
        promptVersion: null,
        extractedAt: new Date("2026-08-07T15:59:30.456Z"),
        extractionResult: requestFixture().extraction.result,
        normalizedProjection: {
          companyName: "Acme Logistics",
          contactName: "Asha Rao",
          contactEmail: null,
          contactPhoneE164: "+919876543210",
          courierName: "Safe Courier",
          documentKinds: ["COURIER_INVOICE"],
          invoiceNumbers: ["INV-001"],
          billingPeriodStart: "2026-07-01",
          billingPeriodEnd: "2026-07-31",
          currency: "INR",
          totalBilledMinorUnits: "12340",
          shipmentCount: 42,
          awbSamples: ["AWB-001"],
          summary: "Monthly invoice"
        },
        warnings: [
          ...requestFixture().extraction.warnings,
          {
            code: "INVALID_CONTACT_EMAIL",
            message: "Contact email could not be normalized deterministically.",
            field: "contactEmail"
          }
        ],
        confidence: 0.91,
        createdAt: firstCreatedAt
      },
      ingestionStatus: "VALIDATED",
      reviewStatus: "NEEDS_REVIEW"
    });
  });

  it("returns null detail when the intake does not exist", async () => {
    const { client } = makeDatabase();
    assert.equal(await getCourierAuditIntakeDetail("missing-intake", client), null);
  });
});

const scratchTest = process.env.COURIER_AUDIT_INTAKE_DB_TEST === "1" ? it : it.skip;

scratchTest("uses database uniqueness for 16 concurrent first deliveries", async () => {
  const request = requestFixture({ messageId: "scratch-race-message" });
  const database = new PrismaClient();
  try {
    const results = await Promise.all(Array.from(
      { length: 16 },
      async () => ingestCourierAuditIntake(request, database)
    ));
    const ids = new Set(results.map((result: { intakeId: string }) => result.intakeId));
    const intakeCount = await database.courierAuditIntake.count({
      where: {
        sourceProvider: "GMAIL",
        sourceAccountId: request.source.accountId,
        providerMessageId: request.source.messageId
      }
    });
    assert.ok(results[0]);
    const revisionCount = await database.courierAuditExtractionRevision.count({
      where: { intakeId: results[0].intakeId }
    });

    assert.equal(ids.size, 1);
    assert.equal(results.filter((result: { duplicate: boolean }) => !result.duplicate).length, 1);
    assert.equal(results.filter((result: { duplicate: boolean }) => result.duplicate).length, 15);
    assert.equal(intakeCount, 1);
    assert.equal(revisionCount, 1);
  } finally {
    const intakes = await database.courierAuditIntake.findMany({
      where: {
        sourceProvider: "GMAIL",
        sourceAccountId: request.source.accountId,
        providerMessageId: request.source.messageId
      },
      select: { id: true }
    });
    await database.courierAuditExtractionRevision.deleteMany({
      where: { intakeId: { in: intakes.map((intake) => intake.id) } }
    });
    await database.courierAuditIntake.deleteMany({
      where: { id: { in: intakes.map((intake) => intake.id) } }
    });
    await database.$disconnect();
  }
});
