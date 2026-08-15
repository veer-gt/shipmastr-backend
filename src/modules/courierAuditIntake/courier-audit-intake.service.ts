import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import type {
  CourierAuditAttachment,
  CourierAuditIntakeRequest,
  CourierAuditNormalizedProjection,
  CourierAuditWarning
} from "./courier-audit-intake.contract.js";
import { deriveCourierAuditSourceFingerprint } from "./courier-audit-intake.fingerprint.js";
import { normalizeCourierAuditExtraction } from "./courier-audit-intake.normalize.js";

const INGESTION_STATUS = "VALIDATED" as const;
const REVIEW_STATUS = "NEEDS_REVIEW" as const;
const SOURCE_IDENTITY_FIELDS = ["sourceProvider", "sourceAccountId", "providerMessageId"] as const;
const SOURCE_IDENTITY_CONSTRAINTS = new Set([
  "CourierAuditIntake_sourceProvider_sourceAccountId_providerM_key",
  "CourierAuditIntake_sourceProvider_sourceAccountId_providerMessageId_key"
]);
const EMAIL_ADDRESS_PATTERN = /[^\s<>()"'`]+@[^\s<>()"'`]+/gu;
const COURIER_AUDIT_INTAKE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

type Db = typeof prisma;
type RawListDb = Pick<Db, "$queryRaw">;

type CourierAuditIntakeListProjectionRow = {
  id: string;
  sourceProvider: "GMAIL";
  sourceReceivedAt: Date;
  createdAt: Date;
  senderName: string | null;
  senderEmail: string | null;
  attachmentCount: number;
  warningCount: number;
  companySummary: string | null;
};

export type CourierAuditIngestResult = {
  intakeId: string;
  ingestionStatus: "VALIDATED";
  reviewStatus: "NEEDS_REVIEW";
  duplicate: boolean;
};

export interface CourierAuditIntakeListItem {
  id: string;
  sourceProvider: "GMAIL";
  sourceReceivedAt: Date;
  createdAt: Date;
  senderSummary: string | null;
  companySummary: string | null;
  warningCount: number;
  attachmentCount: number;
  ingestionStatus: "VALIDATED";
  reviewStatus: "NEEDS_REVIEW";
}

export interface CourierAuditIntakeListResult {
  items: CourierAuditIntakeListItem[];
  nextCursor: string | null;
}

export interface CourierAuditIntakeDetail {
  id: string;
  createdAt: Date;
  source: {
    provider: "GMAIL";
    accountId: string;
    messageId: string;
    threadId: string | null;
    receivedAt: Date;
    senderName: string | null;
    senderEmail: string | null;
    subject: string | null;
    bodySha256: string;
    snippet: string | null;
  };
  attachments: CourierAuditAttachment[];
  revision: {
    revision: 1;
    schemaVersion: string;
    parserName: string;
    parserVersion: string;
    mode: "DETERMINISTIC" | "AI_ASSISTED";
    modelProvider: string | null;
    modelName: string | null;
    promptVersion: string | null;
    extractedAt: Date;
    extractionResult: CourierAuditIntakeRequest["extraction"]["result"];
    normalizedProjection: CourierAuditNormalizedProjection;
    warnings: CourierAuditWarning[];
    confidence: number | null;
    createdAt: Date;
  };
  ingestionStatus: "VALIDATED";
  reviewStatus: "NEEDS_REVIEW";
}

export class CourierAuditIntakeConflictError extends HttpError {
  readonly code = "COURIER_AUDIT_INTAKE_SOURCE_CONFLICT";

  constructor() {
    super(409, "COURIER_AUDIT_INTAKE_SOURCE_CONFLICT");
    this.name = "CourierAuditIntakeConflictError";
  }
}

export class CourierAuditIntakeCursorError extends HttpError {
  readonly code = "INVALID_COURIER_AUDIT_INTAKE_CURSOR";

  constructor() {
    super(400, "INVALID_COURIER_AUDIT_INTAKE_CURSOR");
    this.name = "CourierAuditIntakeCursorError";
  }
}

function success(intakeId: string, duplicate: boolean): CourierAuditIngestResult {
  return {
    intakeId,
    ingestionStatus: INGESTION_STATUS,
    reviewStatus: REVIEW_STATUS,
    duplicate
  };
}

function isExactSourceIdentityTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return SOURCE_IDENTITY_CONSTRAINTS.has(target);
  }
  if (!Array.isArray(target) || target.length !== SOURCE_IDENTITY_FIELDS.length) {
    return false;
  }
  return SOURCE_IDENTITY_FIELDS.every((field, index) => target[index] === field);
}

function isSourceIdentityUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const modelName = error.meta?.modelName;
  if (modelName !== undefined && modelName !== "CourierAuditIntake") {
    return false;
  }
  return isExactSourceIdentityTarget(error.meta?.target);
}

export async function ingestCourierAuditIntake(
  request: CourierAuditIntakeRequest,
  client: Db = prisma
): Promise<CourierAuditIngestResult> {
  const sourceFingerprintSha256 = deriveCourierAuditSourceFingerprint(request);
  const normalized = normalizeCourierAuditExtraction(request.extraction);
  const identity = {
    sourceProvider: request.source.provider,
    sourceAccountId: request.source.accountId,
    providerMessageId: request.source.messageId
  };

  try {
    return await client.$transaction(async (tx) => {
      const intake = await tx.courierAuditIntake.create({
        data: {
          ...identity,
          providerThreadId: request.source.threadId ?? null,
          sourceReceivedAt: new Date(request.source.receivedAt),
          senderName: request.source.from.name ?? null,
          senderEmail: request.source.from.email ?? null,
          subject: request.source.subject ?? null,
          bodySha256: request.source.bodySha256,
          bodySnippet: request.source.snippet ?? null,
          sourceFingerprintSha256,
          attachmentManifest: request.attachments as Prisma.InputJsonValue
        }
      });

      await tx.courierAuditExtractionRevision.create({
        data: {
          intakeId: intake.id,
          revision: 1,
          schemaVersion: request.schemaVersion,
          parserName: request.extraction.parserName,
          parserVersion: request.extraction.parserVersion,
          mode: request.extraction.mode,
          modelProvider: request.extraction.modelProvider,
          modelName: request.extraction.modelName,
          promptVersion: request.extraction.promptVersion,
          extractedAt: new Date(request.extraction.extractedAt),
          extractionResult: request.extraction.result as Prisma.InputJsonValue,
          normalizedProjection: normalized.normalizedProjection as unknown as Prisma.InputJsonValue,
          warnings: normalized.warnings as Prisma.InputJsonValue,
          confidence: request.extraction.confidence
        }
      });

      return success(intake.id, false);
    });
  } catch (error) {
    if (!isSourceIdentityUniqueViolation(error)) {
      throw error;
    }

    const winner = await client.courierAuditIntake.findUnique({
      where: { sourceProvider_sourceAccountId_providerMessageId: identity },
      select: { id: true, sourceFingerprintSha256: true }
    });
    if (!winner) {
      throw error;
    }
    if (winner.sourceFingerprintSha256 !== sourceFingerprintSha256) {
      throw new CourierAuditIntakeConflictError();
    }
    return success(winner.id, true);
  }
}

type ListCursor = { createdAt: Date; id: string };

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): ListCursor {
  try {
    if (!BASE64URL_PATTERN.test(value)) {
      throw new CourierAuditIntakeCursorError();
    }
    const encoded = Buffer.from(value, "base64url");
    if (encoded.toString("base64url") !== value) {
      throw new CourierAuditIntakeCursorError();
    }
    const decoded = JSON.parse(encoded.toString("utf8")) as Record<string, unknown>;
    const fields = Object.keys(decoded);
    if (
      fields.length !== 2 ||
      !fields.includes("createdAt") ||
      !fields.includes("id") ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string" ||
      !COURIER_AUDIT_INTAKE_ID_PATTERN.test(decoded.id)
    ) {
      throw new CourierAuditIntakeCursorError();
    }
    const createdAt = new Date(decoded.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) {
      throw new CourierAuditIntakeCursorError();
    }
    return { createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof CourierAuditIntakeCursorError) throw error;
    throw new CourierAuditIntakeCursorError();
  }
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function maskEmailAddress(value: string): string {
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return "[redacted-email]";
  return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
}

function maskEmailAddresses(value: string): string {
  return value.replace(EMAIL_ADDRESS_PATTERN, maskEmailAddress);
}

function senderSummary(name: string | null, email: string | null): string | null {
  if (name) {
    const summary = compactWhitespace(name);
    if (summary) return maskEmailAddresses(summary);
  }
  if (!email) return null;
  return maskEmailAddress(email);
}

function jsonArrayLength(value: Prisma.JsonValue): number {
  return Array.isArray(value) ? value.length : 0;
}

function companySummary(value: Prisma.JsonValue): string | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const companyName = (value as Prisma.JsonObject).companyName;
  return typeof companyName === "string" ? companyName : null;
}

function buildCourierAuditIntakeListResult(
  rows: CourierAuditIntakeListProjectionRow[],
  limit: number
): CourierAuditIntakeListResult {
  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;

  return {
    items: page.map((row) => ({
      id: row.id,
      sourceProvider: row.sourceProvider,
      sourceReceivedAt: row.sourceReceivedAt,
      createdAt: row.createdAt,
      senderSummary: senderSummary(row.senderName, row.senderEmail),
      companySummary: row.companySummary,
      warningCount: row.warningCount,
      attachmentCount: row.attachmentCount,
      ingestionStatus: INGESTION_STATUS,
      reviewStatus: REVIEW_STATUS
    })),
    nextCursor: hasNextPage && page.length
      ? encodeCursor({ createdAt: page[page.length - 1]!.createdAt, id: page[page.length - 1]!.id })
      : null
  };
}

type CourierAuditIntakeRawListRow = CourierAuditIntakeListProjectionRow;

async function listCourierAuditIntakesWithScalarProjection(
  input: { cursor?: string; limit: number; from?: Date; to?: Date },
  cursor: ListCursor | undefined,
  client: RawListDb
): Promise<CourierAuditIntakeListResult> {
  const predicates: Prisma.Sql[] = [];
  if (input.from) predicates.push(Prisma.sql`i."createdAt" >= ${input.from}`);
  if (input.to) predicates.push(Prisma.sql`i."createdAt" <= ${input.to}`);
  if (cursor) {
    predicates.push(Prisma.sql`(
      i."createdAt" < ${cursor.createdAt}
      OR (i."createdAt" = ${cursor.createdAt} AND i."id" < ${cursor.id})
    )`);
  }
  const where = predicates.length
    ? Prisma.sql`WHERE ${Prisma.join(predicates, " AND ")}`
    : Prisma.sql``;

  const rows = await client.$queryRaw<CourierAuditIntakeRawListRow[]>(Prisma.sql`
    SELECT
      i."id",
      i."sourceProvider",
      i."sourceReceivedAt",
      i."createdAt",
      i."senderName",
      i."senderEmail",
      CASE
        WHEN jsonb_typeof(i."attachmentManifest") = 'array'
        THEN jsonb_array_length(i."attachmentManifest")
        ELSE 0
      END AS "attachmentCount",
      CASE
        WHEN jsonb_typeof(r."warnings") = 'array'
        THEN jsonb_array_length(r."warnings")
        ELSE 0
      END AS "warningCount",
      CASE
        WHEN jsonb_typeof(r."normalizedProjection") = 'object'
          AND jsonb_typeof(r."normalizedProjection" -> 'companyName') = 'string'
        THEN r."normalizedProjection" ->> 'companyName'
        ELSE NULL
      END AS "companySummary"
    FROM "CourierAuditIntake" AS i
    LEFT JOIN LATERAL (
      SELECT r0."normalizedProjection", r0."warnings"
      FROM "CourierAuditExtractionRevision" AS r0
      WHERE r0."intakeId" = i."id" AND r0."revision" = 1
      LIMIT 1
    ) AS r ON TRUE
    ${where}
    ORDER BY i."createdAt" DESC, i."id" DESC
    LIMIT ${input.limit + 1}
  `);

  return buildCourierAuditIntakeListResult(rows, input.limit);
}

export async function listCourierAuditIntakes(
  input: { cursor?: string; limit: number; from?: Date; to?: Date },
  client: Db = prisma
): Promise<CourierAuditIntakeListResult> {
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const clauses: Prisma.CourierAuditIntakeWhereInput[] = [];
  if (input.from || input.to) {
    clauses.push({
      createdAt: {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {})
      }
    });
  }
  if (cursor) {
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } }
      ]
    });
  }

  const rawClient = client as Db & { $queryRaw?: Db["$queryRaw"] };
  if (typeof rawClient.$queryRaw === "function") {
    return listCourierAuditIntakesWithScalarProjection(input, cursor, rawClient);
  }

  // Production Prisma clients always take the scalar raw-query path above; this branch only supports legacy unit doubles without $queryRaw.
  const listArgs = {
    ...(clauses.length ? { where: { AND: clauses } } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: {
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
    }
  } satisfies Prisma.CourierAuditIntakeFindManyArgs;
  const rows = await client.courierAuditIntake.findMany(listArgs);
  return buildCourierAuditIntakeListResult(rows.map((row) => {
    const revision = row.revisions[0];
    return {
      id: row.id,
      sourceProvider: row.sourceProvider,
      sourceReceivedAt: row.sourceReceivedAt,
      createdAt: row.createdAt,
      senderName: row.senderName,
      senderEmail: row.senderEmail,
      companySummary: revision ? companySummary(revision.normalizedProjection) : null,
      warningCount: revision ? jsonArrayLength(revision.warnings) : 0,
      attachmentCount: jsonArrayLength(row.attachmentManifest)
    };
  }), input.limit);
}

export async function getCourierAuditIntakeDetail(
  id: string,
  client: Db = prisma
): Promise<CourierAuditIntakeDetail | null> {
  const intake = await client.courierAuditIntake.findUnique({
    where: { id },
    include: {
      revisions: {
        where: { revision: 1 },
        orderBy: { revision: "asc" },
        take: 1
      }
    }
  });
  if (!intake) return null;
  const revision = intake.revisions[0];
  if (!revision || revision.revision !== 1) return null;

  return {
    id: intake.id,
    createdAt: intake.createdAt,
    source: {
      provider: intake.sourceProvider,
      accountId: intake.sourceAccountId,
      messageId: intake.providerMessageId,
      threadId: intake.providerThreadId,
      receivedAt: intake.sourceReceivedAt,
      senderName: intake.senderName,
      senderEmail: intake.senderEmail,
      subject: intake.subject,
      bodySha256: intake.bodySha256,
      snippet: intake.bodySnippet
    },
    attachments: intake.attachmentManifest as unknown as CourierAuditAttachment[],
    revision: {
      revision: 1,
      schemaVersion: revision.schemaVersion,
      parserName: revision.parserName,
      parserVersion: revision.parserVersion,
      mode: revision.mode,
      modelProvider: revision.modelProvider,
      modelName: revision.modelName,
      promptVersion: revision.promptVersion,
      extractedAt: revision.extractedAt,
      extractionResult: revision.extractionResult as unknown as CourierAuditIntakeRequest["extraction"]["result"],
      normalizedProjection: revision.normalizedProjection as unknown as CourierAuditNormalizedProjection,
      warnings: revision.warnings as unknown as CourierAuditWarning[],
      confidence: revision.confidence,
      createdAt: revision.createdAt
    },
    ingestionStatus: INGESTION_STATUS,
    reviewStatus: REVIEW_STATUS
  };
}
