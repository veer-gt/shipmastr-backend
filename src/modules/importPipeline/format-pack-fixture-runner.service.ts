import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { type FixtureContentProvider } from "./fixture-content-provider.js";
import { FormatPackParserService, formatPackParserService } from "./format-pack-parser.service.js";
import { normalizeExpectedSummary, type ExpectedFixtureSummary } from "./format-pack-fixture.service.js";
import { type ShipmentReferenceResolver } from "./shipment-reference-resolver.js";
import type { FormatPackVersionRecord } from "./types.js";

type FixtureRecord = {
  id: string;
  packVersionId: string;
  fixtureName: string;
  storagePath: string;
  expectedSummary: unknown;
  expectedRowsPath?: string | null;
};

type TestRunRecord = {
  id: string;
  packVersionId: string;
  runnerVersion: string;
  status: string;
  result: unknown;
  createdBy: string;
  createdAt?: Date;
};

type FixtureRunnerClient = {
  formatPackVersion: {
    findUnique(input: { where: { id: string }; include?: Record<string, unknown> }): Promise<FormatPackVersionRecord | null>;
  };
  formatPackFixture: {
    findMany(input: {
      where: Record<string, unknown>;
      orderBy?: Array<Record<string, string>> | Record<string, string>;
    }): Promise<FixtureRecord[]>;
  };
  formatPackTestRun: {
    create(input: { data: Record<string, unknown> }): Promise<TestRunRecord>;
  };
};

type RunFixturesInput = {
  packVersionId: string;
  runnerVersion: string;
  createdBy: string;
  resolver?: ShipmentReferenceResolver | undefined;
};

type SummaryDiff = {
  field: string;
  expected: unknown;
  actual: unknown;
};

const defaultClient = prisma as unknown as FixtureRunnerClient;

function cleanRequired(value: unknown, code: string, max = 160) {
  const text = String(value ?? "").trim();
  if (!text) throw new ImportPipelineError(code);
  return text.slice(0, max);
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function eventCountValue(counts: Record<string, unknown>, key: string) {
  const value = counts[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedEventCounts(expected: Record<string, number>, actual: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const normalizedExpected: Record<string, number> = {};
  const normalizedActual: Record<string, number> = {};
  for (const key of keys) {
    normalizedExpected[key] = expected[key] ?? 0;
    normalizedActual[key] = eventCountValue(actual, key);
  }
  return { normalizedExpected, normalizedActual };
}

function actualSummary(parseResult: Record<string, unknown>): ExpectedFixtureSummary {
  return {
    row_count: typeof parseResult.rowCount === "number" ? parseResult.rowCount : 0,
    parsed_count: typeof parseResult.parsedCount === "number" ? parseResult.parsedCount : 0,
    exception_count: typeof parseResult.exceptionCount === "number" ? parseResult.exceptionCount : 0,
    stated_total_minor: typeof parseResult.statedTotalMinor === "string" ? parseResult.statedTotalMinor : null,
    parsed_total_minor: typeof parseResult.parsedTotalMinor === "string" ? parseResult.parsedTotalMinor : "0",
    event_class_counts: Object.fromEntries(Object.entries(
      typeof parseResult.eventClassCounts === "object" && parseResult.eventClassCounts !== null && !Array.isArray(parseResult.eventClassCounts)
        ? parseResult.eventClassCounts as Record<string, unknown>
        : {}
    ).map(([key, value]) => [key, eventCountValue({ [key]: value }, key)]))
  };
}

function compareSummaries(expected: ExpectedFixtureSummary, actual: ExpectedFixtureSummary) {
  const diffs: SummaryDiff[] = [];
  for (const field of ["row_count", "parsed_count", "exception_count", "stated_total_minor", "parsed_total_minor"] as const) {
    if (expected[field] !== actual[field]) diffs.push({ field, expected: expected[field], actual: actual[field] });
  }

  const { normalizedExpected, normalizedActual } = normalizedEventCounts(expected.event_class_counts, actual.event_class_counts);
  if (JSON.stringify(normalizedExpected) !== JSON.stringify(normalizedActual)) {
    diffs.push({ field: "event_class_counts", expected: normalizedExpected, actual: normalizedActual });
  }
  return diffs;
}

function rowErrors(parseResult: Record<string, unknown>) {
  const rows = Array.isArray(parseResult.rowResults) ? parseResult.rowResults : [];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row) && row.status === "exception")
    .map((row) => ({
      rowNo: row.rowNo,
      exceptionCode: row.exceptionCode,
      exceptionDetail: row.exceptionDetail
    }));
}

function unknownHeaders(error: unknown) {
  if (error instanceof ImportPipelineError && error.code === "HEADER_FINGERPRINT_MISMATCH") {
    const missing = error.details.missing;
    return Array.isArray(missing) ? missing : [];
  }
  return [];
}

function unknownChargeCodes(errors: Array<Record<string, unknown>>) {
  return errors
    .filter((error) => error.exceptionCode === "UNKNOWN_CHARGE_CODE")
    .map((error) => {
      const detail = error.exceptionDetail;
      return detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>).chargeCode : null;
    })
    .filter((value): value is string => typeof value === "string");
}

export class FormatPackFixtureRunner {
  constructor(
    private readonly contentProvider: FixtureContentProvider,
    private readonly client: FixtureRunnerClient = defaultClient,
    private readonly parser: FormatPackParserService = formatPackParserService
  ) {}

  async runFixtures(input: RunFixturesInput) {
    const packVersionId = cleanRequired(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    const runnerVersion = cleanRequired(input.runnerVersion, "FORMAT_PACK_RUNNER_VERSION_REQUIRED", 80);
    const createdBy = cleanRequired(input.createdBy, "FORMAT_PACK_RUN_CREATED_BY_REQUIRED", 160);
    const version = await this.client.formatPackVersion.findUnique({ where: { id: packVersionId }, include: { pack: true } });
    if (!version) throw new ImportPipelineError("FORMAT_PACK_VERSION_NOT_FOUND");

    const fixtures = await this.client.formatPackFixture.findMany({
      where: { packVersionId },
      orderBy: [{ fixtureName: "asc" }, { id: "asc" }]
    });

    if (!fixtures.length) {
      const result = {
        packVersionId,
        runnerVersion,
        status: "failed",
        failures: [{ code: "FORMAT_PACK_FIXTURES_REQUIRED" }],
        fixtures: []
      };
      const testRun = await this.client.formatPackTestRun.create({
        data: { packVersionId, runnerVersion, status: "failed", result: json(result), createdBy }
      });
      return { status: "failed", result, testRun };
    }

    const fixtureResults: Array<Record<string, unknown>> = [];
    for (const fixture of fixtures) {
      const startedAt = Date.now();
      const expected = normalizeExpectedSummary(fixture.expectedSummary);
      try {
        const csvContent = await this.contentProvider.readText(fixture.storagePath);
        const parsed = await this.parser.dryRunParseCsv({
          csvContent,
          formatPackVersionId: packVersionId,
          statedTotalMinor: expected.stated_total_minor,
          resolver: input.resolver,
          persistStagingRows: false
        }) as Record<string, unknown>;
        const actual = actualSummary(parsed);
        const diffs = compareSummaries(expected, actual);
        const errors = rowErrors(parsed);
        fixtureResults.push({
          fixtureId: fixture.id,
          fixtureName: fixture.fixtureName,
          status: diffs.length ? "failed" : "passed",
          expected,
          actual,
          summaryDiffs: diffs,
          rowErrors: errors,
          unknownHeaders: [],
          unknownChargeCodes: unknownChargeCodes(errors),
          totals: {
            statedTotalMinor: actual.stated_total_minor,
            parsedTotalMinor: actual.parsed_total_minor
          },
          durationMs: Date.now() - startedAt
        });
      } catch (error) {
        fixtureResults.push({
          fixtureId: fixture.id,
          fixtureName: fixture.fixtureName,
          status: "failed",
          expected,
          actual: null,
          summaryDiffs: [],
          rowErrors: [],
          unknownHeaders: unknownHeaders(error),
          unknownChargeCodes: [],
          errorCode: error instanceof ImportPipelineError ? error.code : "FIXTURE_RUN_ERROR",
          errorMessage: error instanceof Error ? error.message : "Unknown fixture run failure",
          durationMs: Date.now() - startedAt
        });
      }
    }

    const status = fixtureResults.every((fixture) => fixture.status === "passed") ? "passed" : "failed";
    const result = {
      packVersionId,
      runnerVersion,
      status,
      fixtureCount: fixtures.length,
      fixtures: fixtureResults
    };
    const testRun = await this.client.formatPackTestRun.create({
      data: { packVersionId, runnerVersion, status, result: json(result), createdBy }
    });
    return { status, result, testRun };
  }
}
