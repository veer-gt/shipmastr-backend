import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { defaultAccountTypeConfigs } from "../walletLedger/ledger.service.js";
import { InMemoryFixtureContentProvider, type FixtureContentProvider } from "./fixture-content-provider.js";
import { FormatPackActivationService, formatPackActivationService } from "./format-pack-activation.service.js";
import { FormatPackFixtureRunner } from "./format-pack-fixture-runner.service.js";
import { FormatPackParserService, formatPackParserService } from "./format-pack-parser.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { ImportCorrectionApplyService, importCorrectionApplyService } from "./import-correction-apply.service.js";
import { ImportCorrectionPlannerService } from "./import-correction-planner.service.js";
import { ImportFileService, importFileService } from "./import-file.service.js";
import { RecoveryReportService, recoveryReportService } from "./recovery-report.service.js";
import { ShadowLedgerPostingService, shadowLedgerPostingService } from "./shadow-ledger-posting.service.js";
import type {
  PilotOpsApplyCorrectionInput,
  PilotOpsApplyCorrectionResult,
  PilotOpsCheck,
  PilotOpsEndToEndDryRunInput,
  PilotOpsEndToEndDryRunResult,
  PilotOpsEndToEndLocalInput,
  PilotOpsEndToEndLocalResult,
  PilotOpsFormatPackValidationInput,
  PilotOpsFormatPackValidationResult,
  PilotOpsImportDryRunInput,
  PilotOpsImportStageInput,
  PilotOpsImportStageResult,
  PilotOpsImportSummary,
  PilotOpsMetrics,
  PilotOpsPlanCorrectionInput,
  PilotOpsPlanCorrectionResult,
  PilotOpsPostShadowInput,
  PilotOpsPostShadowResult,
  PilotOpsReadinessInput,
  PilotOpsReadinessResult,
  PilotOpsRecoveryReportInput,
  PilotOpsRecoveryReportResult,
  PilotOpsWarning
} from "./pilot-ops.types.js";

type PilotOpsClient = {
  accountTypeConfig: {
    findMany(): Promise<Array<Record<string, unknown>>>;
  };
  formatPackVersion: {
    findFirst(input: Record<string, unknown>): Promise<{ id: string; status: string; pack?: { source?: string | null; courierCode?: string | null } | null } | null>;
  };
};

type FixtureRunnerLike = Pick<FormatPackFixtureRunner, "runFixtures">;
type ParserLike = Pick<FormatPackParserService, "dryRunParseCsv">;
type ImportFileLike = Pick<ImportFileService, "landFile">;
type ShadowPostingLike = Pick<ShadowLedgerPostingService, "postReadyRowsForFile">;
type RecoveryReportLike = Pick<RecoveryReportService, "generateRecoveryReport">;
type CorrectionPlannerLike = Pick<ImportCorrectionPlannerService, "planCorrection">;
type CorrectionApplyLike = Pick<ImportCorrectionApplyService, "approveCorrectionBatch" | "applyCorrectionBatch">;
type ActivationLike = Pick<FormatPackActivationService, "validateVersion" | "markCanary" | "activateVersion">;

export type PilotOpsDeps = {
  client?: PilotOpsClient | undefined;
  contentProvider?: FixtureContentProvider | undefined;
  fixtureRunner?: FixtureRunnerLike | undefined;
  parser?: ParserLike | undefined;
  importFiles?: ImportFileLike | undefined;
  shadowPosting?: ShadowPostingLike | undefined;
  recoveryReports?: RecoveryReportLike | undefined;
  correctionPlanner?: CorrectionPlannerLike | undefined;
  correctionApply?: CorrectionApplyLike | undefined;
  activation?: ActivationLike | undefined;
};

const defaultClient = prisma as unknown as PilotOpsClient;
const emptyContentProvider = new InMemoryFixtureContentProvider({});
const RUNNER_VERSION = "w0d";
const EMPTY_METRICS: PilotOpsMetrics = {
  autoPostRateBps: null,
  humanTouchPerThousandRows: null
};

function cleanText(value: unknown, code: string, max = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ImportPipelineError(code, code);
  return text.slice(0, max);
}

function optionalText(value: unknown, max = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : null;
}

export function cleanW0PilotPrincipal(value: unknown, code = "W0_PILOT_INTERNAL_PRINCIPAL_REQUIRED") {
  const text = cleanText(value, code, 160);
  if (text.includes("@")) throw new ImportPipelineError("W0_PILOT_INTERNAL_PRINCIPAL_INVALID", "W0_PILOT_INTERNAL_PRINCIPAL_INVALID");
  if (text === "import_pipeline_w0" || text.startsWith("system:") || text.startsWith("usr_")) return text;
  throw new ImportPipelineError("W0_PILOT_INTERNAL_PRINCIPAL_INVALID", "W0_PILOT_INTERNAL_PRINCIPAL_INVALID");
}

function warning(code: string, message: string): PilotOpsWarning {
  return { code, message };
}

function isPrismaMissingTable(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2021");
}

function check(name: string, status: PilotOpsCheck["status"], message: string): PilotOpsCheck {
  return { name, status, message };
}

function cleanEventCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) output[key] = count;
  }
  return output;
}

function normalizeExpectedFileHash(value: unknown) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text || null;
}

function sha256Content(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function integerRatio(numerator: number, multiplier: number, denominator: number) {
  if (!Number.isInteger(numerator) || !Number.isInteger(multiplier) || !Number.isInteger(denominator) || denominator <= 0) return null;
  return parseInt(((BigInt(numerator) * BigInt(multiplier)) / BigInt(denominator)).toString(), 10);
}

function metricsFromImportSummary(summary: Pick<PilotOpsImportSummary, "rowCount" | "exceptionCount">): PilotOpsMetrics {
  return {
    autoPostRateBps: null,
    humanTouchPerThousandRows: integerRatio(summary.exceptionCount, 1000, summary.rowCount)
  };
}

function metricsFromPostCounts(input: { attemptedCount: number; postedCount: number; failedCount: number; skippedCount: number }): PilotOpsMetrics {
  return {
    autoPostRateBps: integerRatio(input.postedCount, 10_000, input.attemptedCount),
    humanTouchPerThousandRows: integerRatio(input.failedCount + input.skippedCount, 1000, input.attemptedCount)
  };
}

function metricsFromReport(input: { stagedRowCount: number; postedRowCount: number; exceptionRowCount: number }): PilotOpsMetrics {
  return {
    autoPostRateBps: integerRatio(input.postedRowCount, 10_000, input.stagedRowCount),
    humanTouchPerThousandRows: integerRatio(input.exceptionRowCount, 1000, input.stagedRowCount)
  };
}

function importBlockingIssues(result: Awaited<ReturnType<ParserLike["dryRunParseCsv"]>>) {
  const issues: string[] = [];
  if (result.statedTotalMinor && result.parsedTotalMinor !== result.statedTotalMinor) {
    issues.push("IMPORT_TOTAL_MISMATCH");
  }
  return issues;
}

function reportBlockingIssues(tieOut: { balanced: boolean; rowsWithPostedEntryRefButMissingLedgerEntry: number; ledgerEntriesWithoutMatchingPostedStagingRow: number }) {
  const issues: string[] = [];
  if (!tieOut.balanced) issues.push("TIE_OUT_NOT_BALANCED");
  if (tieOut.rowsWithPostedEntryRefButMissingLedgerEntry > 0) issues.push("POSTED_ROW_MISSING_LEDGER_ENTRY");
  if (tieOut.ledgerEntriesWithoutMatchingPostedStagingRow > 0) issues.push("LEDGER_ENTRY_MISSING_STAGING_ROW");
  return issues;
}

function warningFromReportTieOut(tieOutWarnings: string[]) {
  return tieOutWarnings.map((message) => warning("REPORT_TIE_OUT_WARNING", message));
}

function importSummary(fileHash: string, result: Awaited<ReturnType<ParserLike["dryRunParseCsv"]>>, warnings: PilotOpsWarning[] = []): PilotOpsImportSummary {
  const blockingIssues = importBlockingIssues(result);
  const base = {
    rowCount: result.rowCount,
    exceptionCount: result.exceptionCount
  };
  return {
    fileHash,
    rowCount: result.rowCount,
    parsedCount: result.parsedCount,
    resolvedCount: result.resolvedCount,
    exceptionCount: result.exceptionCount,
    skippedCount: result.skippedCount,
    parsedTotalMinor: result.parsedTotalMinor,
    ...(result.statedTotalMinor ? { statedTotalMinor: result.statedTotalMinor } : {}),
    fileStatus: result.fileStatus,
    fileExceptionCode: result.fileExceptionCode ?? null,
    eventClassCounts: cleanEventCounts(result.eventClassCounts),
    shippable: blockingIssues.length === 0,
    blockingIssues,
    metrics: metricsFromImportSummary(base),
    warnings
  };
}

function hasPassedFixtureRun(result: Awaited<ReturnType<FixtureRunnerLike["runFixtures"]>>) {
  return result.status === "passed";
}

function localOnlyWarning() {
  return warning("LOCAL_ONLY", "W0D is for local/internal pilot operation only.");
}

export class PilotOpsService {
  private readonly client: PilotOpsClient;
  private readonly contentProvider: FixtureContentProvider;
  private readonly fixtureRunner: FixtureRunnerLike;
  private readonly parser: ParserLike;
  private readonly importFiles: ImportFileLike;
  private readonly shadowPosting: ShadowPostingLike;
  private readonly recoveryReports: RecoveryReportLike;
  private readonly correctionPlanner: CorrectionPlannerLike;
  private readonly correctionApply: CorrectionApplyLike;
  private readonly activation: ActivationLike;

  constructor(deps: PilotOpsDeps = {}) {
    this.client = deps.client ?? defaultClient;
    this.contentProvider = deps.contentProvider ?? emptyContentProvider;
    this.parser = deps.parser ?? formatPackParserService;
    this.importFiles = deps.importFiles ?? importFileService;
    this.shadowPosting = deps.shadowPosting ?? shadowLedgerPostingService;
    this.recoveryReports = deps.recoveryReports ?? recoveryReportService;
    this.correctionPlanner = deps.correctionPlanner ?? new ImportCorrectionPlannerService(undefined as never, this.parser as never, this.contentProvider);
    this.correctionApply = deps.correctionApply ?? importCorrectionApplyService;
    this.activation = deps.activation ?? formatPackActivationService;
    this.fixtureRunner = deps.fixtureRunner ?? new FormatPackFixtureRunner(this.contentProvider);
  }

  async checkW0Readiness(input: PilotOpsReadinessInput = {}): Promise<PilotOpsReadinessResult> {
    const checks: PilotOpsCheck[] = [];
    const warnings: PilotOpsWarning[] = [];
    const requiredCount = defaultAccountTypeConfigs.length;
    let schemaAvailable = true;
    try {
      const configs = await this.client.accountTypeConfig.findMany();
      checks.push(check(
        "account_type_config",
        configs.length >= requiredCount ? "pass" : "fail",
        configs.length >= requiredCount ? "ledger seed rows are present" : "ledger seed rows are incomplete"
      ));
    } catch (error) {
      if (!isPrismaMissingTable(error)) throw error;
      schemaAvailable = false;
      warnings.push(warning("W0_SCHEMA_NOT_APPLIED", "W0 wallet/import tables are not present in the current local database."));
      checks.push(check("account_type_config", "fail", "W0 schema is not applied in the current local database"));
    }
    checks.push(check("ledger_service", "pass", "LedgerService is available through W0 services"));
    checks.push(check("import_pipeline_services", "pass", "W0B/W0C import pipeline services are available"));
    checks.push(check("custody_not_required", "pass", "W0 pilot flow does not require custodial accounts"));
    checks.push(check("payment_config_not_required", "pass", "W0 pilot flow does not require payment provider config"));
    checks.push(check("transport_config_not_required", "pass", "W0 local dry-run does not require external transport config"));

    if (input.includeActivePackCheck !== false) {
      const active = await this.findActivePack({
        source: optionalText(input.source),
        counterparty: optionalText(input.counterparty)
      });
      if (active) {
        checks.push(check("active_format_pack", "pass", "an active format pack is available for the requested scope"));
      } else {
        const activeWarning = warning("ACTIVE_FORMAT_PACK_NOT_FOUND", "no active format pack was found for the requested scope");
        warnings.push(activeWarning);
        checks.push(check("active_format_pack", "warn", activeWarning.message));
      }
    } else if (!schemaAvailable) {
      checks.push(check("active_format_pack", "warn", "active format-pack check skipped because W0 schema is unavailable"));
    }

    warnings.push(warning("W0B_ACTIVE_INDEX_DOCUMENTED", "W0B active-pack partial unique index is documented; runtime index inspection is not required for local readiness."));
    warnings.push(warning("W0C3B_REVERSAL_INDEX_DOCUMENTED", "W0C-3B single-reversal partial unique index is documented; runtime index inspection is not required for local readiness."));
    const blockingIssues = checks.filter((item) => item.status === "fail");
    return {
      ok: blockingIssues.length === 0,
      checks,
      warnings,
      blockingIssues
    };
  }

  async runFormatPackValidationFlow(input: PilotOpsFormatPackValidationInput): Promise<PilotOpsFormatPackValidationResult> {
    const packVersionId = cleanText(input.packVersionId, "FORMAT_PACK_VERSION_ID_REQUIRED");
    const requestedBy = cleanW0PilotPrincipal(input.requestedBy, "FORMAT_PACK_REQUESTED_BY_REQUIRED");
    const dryRun = input.dryRun !== false;
    const fixtureRun = await this.fixtureRunner.runFixtures({
      packVersionId,
      runnerVersion: RUNNER_VERSION,
      createdBy: requestedBy
    });
    const intendedTransitions = hasPassedFixtureRun(fixtureRun)
      ? ["validate", ...(input.activate ? ["canary", "activate"] : [])]
      : [];
    const warnings = [
      warning("FIXTURE_RUN_AUDIT_RECORD", "fixture validation records a controlled format-pack test run"),
      localOnlyWarning()
    ];
    if (dryRun) {
      return {
        dryRun,
        packVersionId,
        fixtureStatus: fixtureRun.status,
        fixtureRunExecuted: true,
        fixtureRunRecorded: Boolean(fixtureRun.testRun),
        fixtureRunSkipped: false,
        statusMutationPerformed: false,
        intendedTransitions,
        executedTransitions: [],
        warnings: [
          ...warnings,
          warning("DRY_RUN_FIXTURE_TEST_RUN_RECORDED", "dryRun records fixture test-run rows but does not change pack status")
        ]
      };
    }
    const executedTransitions: string[] = [];
    if (hasPassedFixtureRun(fixtureRun)) {
      await this.activation.validateVersion({ packVersionId, requestedBy });
      executedTransitions.push("validate");
      if (input.activate === true) {
        const approvedBy = cleanW0PilotPrincipal(input.approvedBy, "FORMAT_PACK_APPROVED_BY_REQUIRED");
        if (approvedBy === requestedBy) throw new ImportPipelineError("PRINCIPAL_NOT_DISTINCT", "PRINCIPAL_NOT_DISTINCT");
        await this.activation.markCanary({ packVersionId, requestedBy });
        executedTransitions.push("canary");
        await this.activation.activateVersion({ packVersionId, approvedBy });
        executedTransitions.push("activate");
      }
    }
    return {
      dryRun,
      packVersionId,
      fixtureStatus: fixtureRun.status,
      fixtureRunExecuted: true,
      fixtureRunRecorded: Boolean(fixtureRun.testRun),
      fixtureRunSkipped: false,
      statusMutationPerformed: executedTransitions.length > 0,
      intendedTransitions,
      executedTransitions,
      warnings
    };
  }

  async runImportDryRun(input: PilotOpsImportDryRunInput): Promise<PilotOpsImportSummary> {
    const formatPackVersionId = await this.resolveFormatPackVersionId(input);
    const { csvContent, fileHash } = await this.readCsvPayload(input);
    const parsed = await this.parser.dryRunParseCsv({
      csvContent,
      formatPackVersionId,
      statedTotalMinor: input.statedTotalMinor,
      source: cleanText(input.source, "IMPORT_FILE_SOURCE_REQUIRED"),
      counterparty: optionalText(input.counterparty),
      brandOrgId: optionalText(input.brandOrgId),
      persistStagingRows: false
    });
    return importSummary(fileHash, parsed, [localOnlyWarning()]);
  }

  async runImportAndStage(input: PilotOpsImportStageInput): Promise<PilotOpsImportStageResult> {
    const execute = input.execute === true;
    const formatPackVersionId = await this.resolveFormatPackVersionId(input);
    const intendedOperations = ["land_import_file", "parse_csv", "replace_staging_rows"];
    if (!execute) {
      return {
        execute,
        formatPackVersionId,
        intendedOperations,
        shippable: false,
        blockingIssues: ["EXECUTE_REQUIRED"],
        metrics: EMPTY_METRICS,
        warnings: [localOnlyWarning(), warning("EXECUTE_REQUIRED", "local staging execution requires execute=true")]
      };
    }
    cleanW0PilotPrincipal(input.createdBy, "IMPORT_FILE_CREATED_BY_REQUIRED");
    const { csvContent, fileHash } = await this.readCsvPayload(input);
    const landed = await this.importFiles.landFile({
      fileHash,
      source: cleanText(input.source, "IMPORT_FILE_SOURCE_REQUIRED"),
      counterparty: optionalText(input.counterparty),
      brandOrgId: optionalText(input.brandOrgId),
      period: optionalText(input.period),
      storagePath: optionalText(input.storagePath) ?? `local/w0/${fileHash}.csv`,
      statedTotalMinor: input.statedTotalMinor,
      formatPackVersionId
    });
    const parsed = await this.parser.dryRunParseCsv({
      fileId: landed.id,
      csvContent,
      formatPackVersionId,
      statedTotalMinor: input.statedTotalMinor,
      source: cleanText(input.source, "IMPORT_FILE_SOURCE_REQUIRED"),
      counterparty: optionalText(input.counterparty),
      brandOrgId: optionalText(input.brandOrgId),
      persistStagingRows: true
    });
    const summary = importSummary(fileHash, parsed, []);
    return {
      execute,
      importFileId: landed.id,
      fileHash,
      formatPackVersionId,
      intendedOperations,
      summary,
      shippable: summary.shippable,
      blockingIssues: summary.blockingIssues,
      metrics: summary.metrics,
      warnings: [localOnlyWarning()]
    };
  }

  async postStagedRowsToShadowLedger(input: PilotOpsPostShadowInput): Promise<PilotOpsPostShadowResult> {
    const dryRun = input.dryRun !== false;
    const result = await this.shadowPosting.postReadyRowsForFile({
      fileId: cleanText(input.fileId, "IMPORT_FILE_ID_REQUIRED"),
      createdBy: cleanW0PilotPrincipal(input.createdBy, "LEDGER_POST_CREATED_BY_REQUIRED"),
      dryRun
    });
    return {
      dryRun,
      fileId: result.fileId,
      attemptedCount: result.attemptedCount,
      postedCount: result.postedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      metrics: metricsFromPostCounts({
        attemptedCount: result.attemptedCount,
        postedCount: result.postedCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount
      }),
      rows: result.rows.map((row) => ({
        rowNo: row.rowNo,
        status: row.status,
        code: row.code,
        entryRef: row.entryRef,
        entryType: row.entryType,
        amountMinor: row.amountMinor
      }))
    };
  }

  async generatePilotRecoveryReport(input: PilotOpsRecoveryReportInput): Promise<PilotOpsRecoveryReportResult> {
    const warnings = input.includeRows === true
      ? [warning("ROW_DETAILS_SUPPRESSED", "pilot wrapper suppresses row detail output")]
      : [];
    const report = await this.recoveryReports.generateRecoveryReport({
      brandOrgId: cleanText(input.brandOrgId, "BRAND_ORG_ID_REQUIRED"),
      period: input.period,
      fileIds: input.fileIds,
      courierCounterparty: input.courierCounterparty,
      includeRows: false
    });
    const blockingIssues = reportBlockingIssues(report.tieOut);
    const reportWarnings = warningFromReportTieOut(report.tieOut.warnings);
    const metrics = metricsFromReport({
      stagedRowCount: report.importQuality.stagedRowCount,
      postedRowCount: report.importQuality.postedRowCount,
      exceptionRowCount: report.importQuality.exceptionRowCount
    });
    return {
      metadata: {
        brandOrgId: report.metadata.brandOrgId,
        period: report.metadata.period,
        fileIds: report.metadata.fileIds,
        ledgerScope: "shadow",
        warnings: report.metadata.warnings
      },
      importQuality: {
        fileCount: report.importQuality.fileCount,
        stagedRowCount: report.importQuality.stagedRowCount,
        postedRowCount: report.importQuality.postedRowCount,
        exceptionRowCount: report.importQuality.exceptionRowCount
      },
      financialSummary: report.financialSummary,
      tieOut: report.tieOut,
      shippable: blockingIssues.length === 0,
      blockingIssues,
      metrics,
      warnings: [...warnings, ...reportWarnings, localOnlyWarning()]
    };
  }

  async planImportCorrection(input: PilotOpsPlanCorrectionInput): Promise<PilotOpsPlanCorrectionResult> {
    const createdBy = cleanW0PilotPrincipal(input.createdBy, "IMPORT_CORRECTION_CREATED_BY_REQUIRED");
    const persistPlan = input.persistPlan === true;
    const plan = await this.correctionPlanner.planCorrection({
      importFileId: input.importFileId,
      newFormatPackVersionId: input.newFormatPackVersionId,
      reason: input.reason,
      createdBy,
      persistPlan
    });
    return {
      persistPlan,
      batchId: plan.batchId,
      importFileId: plan.importFileId,
      oldFormatPackVersionId: plan.oldFormatPackVersionId,
      newFormatPackVersionId: plan.newFormatPackVersionId,
      itemCount: plan.items.length,
      actionCounts: plan.actionCounts,
      warnings: plan.warnings
    };
  }

  async approveAndApplyCorrection(input: PilotOpsApplyCorrectionInput): Promise<PilotOpsApplyCorrectionResult> {
    const batchId = cleanText(input.batchId, "IMPORT_CORRECTION_BATCH_ID_REQUIRED");
    const execute = input.execute === true;
    const dryRun = input.dryRun !== false || !execute;
    const intendedOperations = ["approve_correction_batch", "apply_correction_batch"];
    if (!execute || dryRun) {
      return { execute, dryRun, batchId, intendedOperations };
    }
    const approvedBy = cleanW0PilotPrincipal(input.approvedBy, "IMPORT_CORRECTION_APPROVED_BY_REQUIRED");
    const appliedBy = cleanW0PilotPrincipal(input.appliedBy, "IMPORT_CORRECTION_APPLIED_BY_REQUIRED");
    if (approvedBy === appliedBy) throw new ImportPipelineError("PRINCIPAL_NOT_DISTINCT", "PRINCIPAL_NOT_DISTINCT");
    const approval = await this.correctionApply.approveCorrectionBatch({ batchId, approvedBy });
    const apply = await this.correctionApply.applyCorrectionBatch({ batchId, appliedBy, dryRun: false });
    return {
      execute,
      dryRun: false,
      batchId,
      intendedOperations,
      approval: { status: approval.status, approvedBy: approval.approvedBy },
      apply: {
        status: apply.status,
        itemCount: apply.itemCount,
        postedReversalCount: apply.postedReversalCount,
        postedCorrectedCount: apply.postedCorrectedCount,
        failedCount: apply.failedCount
      }
    };
  }

  async runEndToEndPilotDryRun(input: PilotOpsEndToEndDryRunInput): Promise<PilotOpsEndToEndDryRunResult> {
    const readiness = await this.checkW0Readiness({
      source: input.source,
      counterparty: input.counterparty,
      brandOrgId: input.brandOrgId
    });
    const fixtureFlow = input.packVersionId
      ? await this.runFormatPackValidationFlow({ packVersionId: input.packVersionId, requestedBy: input.createdBy, dryRun: true })
      : undefined;
    const importDryRun = await this.runImportDryRun(input);
    const shadowPostDryRun = input.fileId
      ? await this.postStagedRowsToShadowLedger({ fileId: input.fileId, createdBy: input.createdBy, dryRun: true })
      : undefined;
    const reportPeriod = optionalText(input.period);
    const reportPreview = input.brandOrgId
      ? await this.generatePilotRecoveryReport({ brandOrgId: input.brandOrgId, ...(reportPeriod ? { period: reportPeriod } : {}) })
      : undefined;
    const blockingIssues = [
      ...readiness.blockingIssues.map((item) => `READINESS:${item.name}`),
      ...importDryRun.blockingIssues,
      ...(reportPreview?.blockingIssues ?? [])
    ];
    const metrics = reportPreview?.metrics ?? importDryRun.metrics;
    const checklist = [
      check("readiness", readiness.ok ? "pass" : "fail", readiness.ok ? "ready for local pilot dry-run" : "readiness has blocking issues"),
      check("import_dry_run", importDryRun.exceptionCount > 0 ? "warn" : "pass", "CSV parse dry-run completed"),
      check("shadow_post_dry_run", shadowPostDryRun && shadowPostDryRun.failedCount > 0 ? "warn" : "pass", "shadow posting preview completed or was skipped"),
      check(
        "report_preview",
        reportPreview ? (reportPreview.shippable ? "pass" : "fail") : "warn",
        reportPreview ? (reportPreview.shippable ? "report preview generated and tied out" : "report preview has blocking tie-out issues") : "report preview skipped"
      ),
      check("shippable", blockingIssues.length === 0 ? "pass" : "fail", blockingIssues.length === 0 ? "pilot output is shippable" : "pilot output has blocking issues")
    ];
    return {
      dryRun: true,
      readiness,
      fixtureFlow,
      importDryRun,
      shadowPostDryRun,
      reportPreview,
      checklist,
      shippable: blockingIssues.length === 0,
      blockingIssues,
      metrics,
      warnings: [localOnlyWarning(), ...(fixtureFlow?.warnings ?? [])]
    };
  }

  async runEndToEndPilotLocal(input: PilotOpsEndToEndLocalInput): Promise<PilotOpsEndToEndLocalResult> {
    const execute = input.execute === true;
    if (!execute) {
      return {
        execute,
        stagedRowCount: 0,
        postedCount: 0,
        failedCount: 0,
        shippable: false,
        blockingIssues: ["EXECUTE_REQUIRED"],
        metrics: EMPTY_METRICS,
        warnings: [localOnlyWarning(), warning("EXECUTE_REQUIRED", "local pilot execution requires execute=true")]
      };
    }
    const staged = await this.runImportAndStage({ ...input, execute: true });
    const importFileId = cleanText(staged.importFileId, "IMPORT_FILE_ID_REQUIRED");
    const posted = await this.postStagedRowsToShadowLedger({ fileId: importFileId, createdBy: input.createdBy, dryRun: false });
    const reportPeriod = optionalText(input.period);
    const report = input.brandOrgId
      ? await this.generatePilotRecoveryReport({ brandOrgId: input.brandOrgId, ...(reportPeriod ? { period: reportPeriod } : {}), fileIds: [importFileId] })
      : null;
    const blockingIssues = [
      ...(staged.summary?.blockingIssues ?? []),
      ...(report?.blockingIssues ?? [])
    ];
    const metrics = report?.metrics ?? metricsFromPostCounts({
      attemptedCount: staged.summary?.rowCount ?? 0,
      postedCount: posted.postedCount,
      failedCount: posted.failedCount,
      skippedCount: posted.skippedCount
    });
    return {
      execute,
      importFileId,
      stagedRowCount: staged.summary?.rowCount ?? 0,
      postedCount: posted.postedCount,
      failedCount: posted.failedCount,
      financialSummary: report?.financialSummary,
      tieOut: report?.tieOut,
      shippable: blockingIssues.length === 0,
      blockingIssues,
      metrics,
      warnings: [localOnlyWarning(), ...(staged.warnings ?? []), ...(report?.warnings ?? [])]
    };
  }

  private async resolveFormatPackVersionId(input: Pick<PilotOpsImportDryRunInput, "formatPackVersionId" | "source" | "counterparty">) {
    const explicit = optionalText(input.formatPackVersionId);
    if (explicit) return explicit;
    const active = await this.findActivePack({
      source: cleanText(input.source, "IMPORT_FILE_SOURCE_REQUIRED"),
      counterparty: optionalText(input.counterparty)
    });
    if (!active) throw new ImportPipelineError("ACTIVE_FORMAT_PACK_NOT_FOUND", "ACTIVE_FORMAT_PACK_NOT_FOUND");
    return active.id;
  }

  private async findActivePack(input: { source: string | null; counterparty: string | null }) {
    const where: Record<string, unknown> = { status: "active" };
    const pack: Record<string, unknown> = {};
    if (input.source) pack.source = input.source;
    if (input.counterparty) pack.courierCode = input.counterparty;
    if (Object.keys(pack).length > 0) where.pack = pack;
    return this.client.formatPackVersion.findFirst({
      where,
      include: { pack: true },
      orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }, { version: "desc" }]
    }).catch((error: unknown) => {
      if (isPrismaMissingTable(error)) return null;
      throw error;
    });
  }

  private async readCsvPayload(input: Pick<PilotOpsImportDryRunInput, "csvContent" | "storagePath" | "expectedFileHash">) {
    const csvContent = typeof input.csvContent === "string" && input.csvContent.trim()
      ? input.csvContent
      : await this.contentProvider.readText(cleanText(input.storagePath, "IMPORT_FILE_STORAGE_PATH_REQUIRED"));
    const fileHash = sha256Content(csvContent);
    const expectedFileHash = normalizeExpectedFileHash(input.expectedFileHash);
    if (expectedFileHash && expectedFileHash !== fileHash) {
      throw new ImportPipelineError("FILE_HASH_MISMATCH", "FILE_HASH_MISMATCH", { expectedFileHash, actualFileHash: fileHash });
    }
    return { csvContent, fileHash };
  }

}

export const pilotOpsService = new PilotOpsService();
