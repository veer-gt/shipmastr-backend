import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type FixtureVersionRecord = {
  id: string;
  status: string;
};

type FixtureRecord = {
  id: string;
  packVersionId: string;
  fixtureName: string;
  storagePath: string;
  expectedSummary: unknown;
  expectedRowsPath?: string | null;
  createdAt?: Date;
  packVersion?: FixtureVersionRecord;
};

type FixtureClient = {
  formatPackVersion: {
    findUnique(input: { where: { id: string } }): Promise<FixtureVersionRecord | null>;
  };
  formatPackFixture: {
    create(input: { data: Record<string, unknown> }): Promise<FixtureRecord>;
    findUnique(input: { where: { id: string }; include?: Record<string, unknown> }): Promise<FixtureRecord | null>;
    findMany(input: {
      where: Record<string, unknown>;
      orderBy?: Array<Record<string, string>> | Record<string, string>;
    }): Promise<FixtureRecord[]>;
    delete(input: { where: { id: string } }): Promise<FixtureRecord>;
  };
};

export type ExpectedFixtureSummary = {
  row_count: number;
  parsed_count: number;
  exception_count: number;
  stated_total_minor: string | null;
  parsed_total_minor: string;
  event_class_counts: Record<string, number>;
};

export type CreateFixtureInput = {
  packVersionId: string;
  fixtureName: string;
  storagePath: string;
  expectedSummary: unknown;
  expectedRowsPath?: string | null | undefined;
};

export class FormatPackFixtureServiceError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "FormatPackFixtureServiceError";
    this.code = code;
    this.details = details;
  }
}

const defaultClient = prisma as unknown as FixtureClient;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanRequired(value: unknown, code: string, max = 240) {
  const text = String(value ?? "").trim();
  if (!text) throw new FormatPackFixtureServiceError(code);
  return text.slice(0, max);
}

function cleanOptional(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function requireNonNegativeInteger(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FormatPackFixtureServiceError(code);
  }
  return value;
}

function requireIntegerString(value: unknown, code: string) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new FormatPackFixtureServiceError(code);
  }
  return value;
}

function requireIntegerStringOrNull(value: unknown, code: string) {
  if (value === null) return null;
  return requireIntegerString(value, code);
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function normalizeExpectedSummary(input: unknown): ExpectedFixtureSummary {
  if (!isObject(input)) throw new FormatPackFixtureServiceError("EXPECTED_SUMMARY_INVALID");

  const rowCount = input.row_count;
  const parsedCount = input.parsed_count;
  const exceptionCount = input.exception_count;
  const statedTotalMinor = input.stated_total_minor;
  const parsedTotalMinor = input.parsed_total_minor;
  const eventClassCounts = input.event_class_counts;

  const normalizedRowCount = requireNonNegativeInteger(rowCount, "EXPECTED_SUMMARY_ROW_COUNT_INVALID");
  const normalizedParsedCount = requireNonNegativeInteger(parsedCount, "EXPECTED_SUMMARY_PARSED_COUNT_INVALID");
  const normalizedExceptionCount = requireNonNegativeInteger(exceptionCount, "EXPECTED_SUMMARY_EXCEPTION_COUNT_INVALID");
  const normalizedStatedTotalMinor = requireIntegerStringOrNull(statedTotalMinor, "EXPECTED_SUMMARY_STATED_TOTAL_INVALID");
  const normalizedParsedTotalMinor = requireIntegerString(parsedTotalMinor, "EXPECTED_SUMMARY_PARSED_TOTAL_INVALID");
  if (!isObject(eventClassCounts)) throw new FormatPackFixtureServiceError("EXPECTED_SUMMARY_EVENT_COUNTS_INVALID");

  const normalizedCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(eventClassCounts)) {
    const eventClass = String(key).trim();
    if (!eventClass) {
      throw new FormatPackFixtureServiceError("EXPECTED_SUMMARY_EVENT_COUNTS_INVALID");
    }
    normalizedCounts[eventClass] = requireNonNegativeInteger(value, "EXPECTED_SUMMARY_EVENT_COUNTS_INVALID");
  }

  return {
    row_count: normalizedRowCount,
    parsed_count: normalizedParsedCount,
    exception_count: normalizedExceptionCount,
    stated_total_minor: normalizedStatedTotalMinor,
    parsed_total_minor: normalizedParsedTotalMinor,
    event_class_counts: normalizedCounts
  };
}

export class FormatPackFixtureService {
  constructor(private readonly client: FixtureClient = defaultClient) {}

  async createFixture(input: CreateFixtureInput) {
    const packVersionId = cleanRequired(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    const version = await this.client.formatPackVersion.findUnique({ where: { id: packVersionId } });
    if (!version) throw new FormatPackFixtureServiceError("FORMAT_PACK_VERSION_NOT_FOUND");
    if (!["draft", "rejected"].includes(version.status)) {
      throw new FormatPackFixtureServiceError("FORMAT_PACK_FIXTURE_VERSION_LOCKED", { status: version.status });
    }

    const expectedSummary = normalizeExpectedSummary(input.expectedSummary);
    return this.client.formatPackFixture.create({
      data: {
        packVersionId,
        fixtureName: cleanRequired(input.fixtureName, "FORMAT_PACK_FIXTURE_NAME_REQUIRED", 160),
        storagePath: cleanRequired(input.storagePath, "FORMAT_PACK_FIXTURE_STORAGE_PATH_REQUIRED", 500),
        expectedSummary: json(expectedSummary),
        expectedRowsPath: cleanOptional(input.expectedRowsPath)
      }
    });
  }

  async listFixtures(packVersionIdInput: string) {
    const packVersionId = cleanRequired(packVersionIdInput, "FORMAT_PACK_VERSION_ID_REQUIRED");
    return this.client.formatPackFixture.findMany({
      where: { packVersionId },
      orderBy: [{ fixtureName: "asc" }, { id: "asc" }]
    });
  }

  async deleteFixture(fixtureIdInput: string) {
    const fixtureId = cleanRequired(fixtureIdInput, "FORMAT_PACK_FIXTURE_ID_REQUIRED");
    const fixture = await this.client.formatPackFixture.findUnique({
      where: { id: fixtureId },
      include: { packVersion: true }
    });
    if (!fixture) throw new FormatPackFixtureServiceError("FORMAT_PACK_FIXTURE_NOT_FOUND");
    const status = fixture.packVersion?.status;
    if (!status || !["draft", "rejected"].includes(status)) {
      throw new FormatPackFixtureServiceError("FORMAT_PACK_FIXTURE_DELETE_LOCKED", { status });
    }
    return this.client.formatPackFixture.delete({ where: { id: fixtureId } });
  }
}

export const formatPackFixtureService = new FormatPackFixtureService();
