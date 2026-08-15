import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import type { CourierAuditIntakeRequest } from "./courier-audit-intake.contract.js";
import {
  CourierAuditIntakeConflictError,
  CourierAuditIntakeCursorError,
  getCourierAuditIntakeDetail,
  ingestCourierAuditIntake,
  listCourierAuditIntakes
} from "./courier-audit-intake.service.js";
import { HttpError } from "../../lib/httpError.js";

const SOURCE_IDENTITY_TARGET = ["sourceProvider", "sourceAccountId", "providerMessageId"];
const firstCreatedAt = new Date("2026-08-07T16:00:01.000Z");

function requestFixture(overrides: {
  accountId?: string;
  messageId?: string;
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  bodySha256?: string;
} = {}): CourierAuditIntakeRequest {
  return {
    schemaVersion: "courier-audit-intake.v1",
    source: {
      provider: "GMAIL",
      accountId: overrides.accountId ?? "mailbox-workflow-01",
      messageId: overrides.messageId ?? "gmail-message-1001",
      threadId: "gmail-thread-77",
      receivedAt: "2026-08-07T15:58:45.123Z",
      from: {
        name: overrides.senderName ?? "  Acme   Billing  ",
        email: overrides.senderEmail ?? "billing@example.test"
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
  const controls: {
    failRevisionCreate?: Error;
    transactionError?: unknown;
  } = { ...options };
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
        if (controls.failRevisionCreate) throw controls.failRevisionCreate;
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
      if (controls.transactionError) throw controls.transactionError;
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

  return { client: client as any, controls, state };
}

function paginatedListRow(id: string, createdAt: Date) {
  return {
    id,
    sourceProvider: "GMAIL" as const,
    sourceReceivedAt: new Date("2026-08-07T15:58:45.123Z"),
    createdAt,
    senderName: "Courier Billing",
    senderEmail: "billing@example.test",
    attachmentManifest: [],
    revisions: [{
      normalizedProjection: { companyName: "Courier Company" },
      warnings: []
    }]
  };
}

function makePaginatedListClient(rows: ReturnType<typeof paginatedListRow>[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      courierAuditIntake: {
        findMany: async (args: any) => {
          calls.push(args);
          let filtered = [...rows];
          for (const clause of args.where?.AND ?? []) {
            if (clause.createdAt && !clause.OR) {
              const { gte, lte } = clause.createdAt;
              if (gte) filtered = filtered.filter((row) => row.createdAt >= gte);
              if (lte) filtered = filtered.filter((row) => row.createdAt <= lte);
            }
            if (clause.OR) {
              const olderThan = clause.OR[0]?.createdAt?.lt as Date;
              const equalTo = clause.OR[1]?.createdAt as Date;
              const idLessThan = clause.OR[1]?.id?.lt as string;
              filtered = filtered.filter((row) =>
                row.createdAt < olderThan ||
                (row.createdAt.getTime() === equalTo.getTime() && row.id < idLessThan)
              );
            }
          }
          return filtered
            .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
            .slice(0, args.take);
        }
      }
    } as any
  };
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
        error instanceof HttpError &&
        error.status === 409 &&
        error.message === "COURIER_AUDIT_INTAKE_SOURCE_CONFLICT" &&
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

  it("accepts the actual truncated PostgreSQL source-identity constraint target", async () => {
    const database = makeDatabase();
    const request = requestFixture();
    const first = await ingestCourierAuditIntake(request, database.client);
    database.controls.transactionError = p2002("CourierAuditIntake_sourceProvider_sourceAccountId_providerM_key");

    const duplicate = await ingestCourierAuditIntake(request, database.client);

    assert.equal(duplicate.intakeId, first.intakeId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(database.state.revisions.length, 1);
  });

  it("rethrows wrong string and wrong-order array P2002 targets", async () => {
    for (const target of [
      "CourierAuditExtractionRevision_intakeId_revision_key",
      ["sourceAccountId", "sourceProvider", "providerMessageId"]
    ]) {
      const error = p2002(target);
      const { client } = makeDatabase({ transactionError: error });
      await assert.rejects(ingestCourierAuditIntake(requestFixture(), client), (caught) => caught === error);
    }
  });

  it("rethrows the original source-identity P2002 when no committed winner exists", async () => {
    const error = p2002(SOURCE_IDENTITY_TARGET);
    const { client } = makeDatabase({ transactionError: error });

    await assert.rejects(ingestCourierAuditIntake(requestFixture(), client), (caught) => caught === error);
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

  it("never exposes a full email supplied as or embedded in senderName", async () => {
    const { client } = makeDatabase();
    await ingestCourierAuditIntake(requestFixture({
      messageId: "sender-name-email-exact",
      senderName: "billing@example.test"
    }), client);
    await ingestCourierAuditIntake(requestFixture({
      messageId: "sender-name-email-embedded",
      senderName: "Billing contact billing@example.test"
    }), client);
    await ingestCourierAuditIntake(requestFixture({
      messageId: "sender-name-email-punycode",
      senderName: "Billing contact billing@example.xn--p1ai",
      senderEmail: "billing@example.xn--p1ai"
    }), client);
    await ingestCourierAuditIntake(requestFixture({
      messageId: "sender-name-email-unicode-domain",
      senderName: "Billing contact billing@例え.テスト",
      senderEmail: "billing@例え.テスト"
    }), client);

    const list = await listCourierAuditIntakes({ limit: 25 }, client);
    assert.equal(list.items.length, 4);
    for (const item of list.items) {
      assert.equal(item.senderSummary?.includes("billing@example.test"), false);
      assert.equal(item.senderSummary?.includes("billing@example.xn--p1ai"), false);
      assert.equal(item.senderSummary?.includes("billing@例え.テスト"), false);
    }
  });

  it("rejects malformed cursors with stable HttpError-compatible cursor details", async () => {
    const database = makePaginatedListClient([]);
    const validId = "00000000-0000-4000-8000-000000000001";
    const validTimestamp = firstCreatedAt.toISOString();
    const malformedCursors = [
      Buffer.from(JSON.stringify({ createdAt: validTimestamp }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: validTimestamp, id: validId, extra: true }), "utf8").toString("base64url"),
      `${Buffer.from(JSON.stringify({ createdAt: validTimestamp, id: validId }), "utf8").toString("base64url")}=` ,
      Buffer.from(JSON.stringify({ createdAt: validTimestamp, id: "intake-1" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-08-07T16:00:01Z", id: validId }), "utf8").toString("base64url")
    ];

    for (const cursor of malformedCursors) {
      await assert.rejects(
        listCourierAuditIntakes({ limit: 25, cursor }, database.client),
        (error) => error instanceof CourierAuditIntakeCursorError &&
          error instanceof HttpError &&
          error.status === 400 &&
          error.message === "INVALID_COURIER_AUDIT_INTAKE_CURSOR" &&
          error.code === "INVALID_COURIER_AUDIT_INTAKE_CURSOR"
      );
    }
  });

  it("paginates equal createdAt rows stably and sends bounded select, date, order, and cursor predicates", async () => {
    const createdAt = new Date("2026-08-07T16:30:00.000Z");
    const from = new Date("2026-08-01T00:00:00.000Z");
    const to = new Date("2026-08-31T23:59:59.999Z");
    const database = makePaginatedListClient([
      paginatedListRow("00000000-0000-4000-8000-00000000000a", createdAt),
      paginatedListRow("00000000-0000-4000-8000-00000000000c", createdAt),
      paginatedListRow("00000000-0000-4000-8000-00000000000b", createdAt)
    ]);

    const first = await listCourierAuditIntakes({ limit: 2, from, to }, database.client);
    assert.deepEqual(first.items.map((item) => item.id), [
      "00000000-0000-4000-8000-00000000000c",
      "00000000-0000-4000-8000-00000000000b"
    ]);
    assert.ok(first.nextCursor);
    const second = await listCourierAuditIntakes({ limit: 2, from, to, cursor: first.nextCursor }, database.client);
    assert.deepEqual(second.items.map((item) => item.id), ["00000000-0000-4000-8000-00000000000a"]);
    assert.equal(second.nextCursor, null);

    const expectedSelect = {
      id: true,
      sourceProvider: true,
      sourceReceivedAt: true,
      createdAt: true,
      senderName: true,
      senderEmail: true,
      attachmentManifest: true,
      revisions: {
        where: { revision: 1 },
        take: 1,
        select: { normalizedProjection: true, warnings: true }
      }
    };
    assert.deepEqual(database.calls[0].orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(database.calls[0].take, 3);
    assert.deepEqual(database.calls[0].select, expectedSelect);
    assert.deepEqual(database.calls[0].where, {
      AND: [{ createdAt: { gte: from, lte: to } }]
    });
    assert.deepEqual(database.calls[1].where, {
      AND: [
        { createdAt: { gte: from, lte: to } },
        {
          OR: [
            { createdAt: { lt: createdAt } },
            { createdAt, id: { lt: "00000000-0000-4000-8000-00000000000b" } }
          ]
        }
      ]
    });
  });

  it("returns null detail when the intake does not exist", async () => {
    const { client } = makeDatabase();
    assert.equal(await getCourierAuditIntakeDetail("missing-intake", client), null);
  });
});

const scratchTest = process.env.COURIER_AUDIT_INTAKE_DB_TEST === "1" ? it : it.skip;

scratchTest("uses database uniqueness for 16 concurrent first deliveries", async () => {
  const token = randomUUID();
  const request = requestFixture({
    accountId: `scratch-race-account-${token}`,
    messageId: `scratch-race-message-${token}`
  });
  const database = new PrismaClient();
  const fulfilledIntakeIds = new Set<string>();
  const fixtureIdentity = {
    sourceProvider: "GMAIL" as const,
    sourceAccountId: request.source.accountId,
    providerMessageId: request.source.messageId
  };
  try {
    const settledResults = await Promise.allSettled(Array.from(
      { length: 16 },
      async () => {
        const result = await ingestCourierAuditIntake(request, database);
        fulfilledIntakeIds.add(result.intakeId);
        return result;
      }
    ));
    const results = settledResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    assert.equal(settledResults.length, 16);
    assert.equal(settledResults.filter((result) => result.status === "rejected").length, 0);
    assert.equal(results.length, 16);
    const ids = new Set(results.map((result: { intakeId: string }) => result.intakeId));
    const intakeCount = await database.courierAuditIntake.count({
      where: fixtureIdentity
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
    try {
      const fulfilledIds = [...fulfilledIntakeIds];
      await database.courierAuditExtractionRevision.deleteMany({
        where: fulfilledIds.length > 0
          ? {
            OR: [
              { intakeId: { in: fulfilledIds } },
              { intake: fixtureIdentity }
            ]
          }
          : { intake: fixtureIdentity }
      });
      await database.courierAuditIntake.deleteMany({
        where: fixtureIdentity
      });
    } finally {
      await database.$disconnect();
    }
  }
});
