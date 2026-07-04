import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { defaultAccountTypeConfigs } from "../walletLedger/ledger.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import {
  baseImportInput as cliBaseImportInput,
  commandName as cliCommandName,
  createPilotOpsServiceForCli,
  requireExecute as cliRequireExecute
} from "./pilot-ops-cli-runtime.js";
import { cleanW0PilotPrincipal, PilotOpsService } from "./pilot-ops.service.js";
import type { RecoveryReportTieOut } from "./recovery-report.types.js";

function parseCallList() {
  return [] as Array<Record<string, unknown>>;
}

function parserResult(overrides: Record<string, unknown> = {}) {
  return {
    rowCount: 1,
    parsedCount: 1,
    parsedRowCount: 1,
    resolvedCount: 1,
    exceptionCount: 0,
    exceptionRowCount: 0,
    fileExceptionCount: 0,
    skippedCount: 0,
    skippedRowCount: 0,
    postableRowCount: 1,
    statusCounts: { resolved: 1 },
    parsedTotalMinor: "11800",
    postableTotalMinor: "11800",
    rawFileTotalMinor: "11800",
    allRowsTotalMinor: "11800",
    statedTotalMinor: null,
    fileTies: null,
    fileStatus: "parsed",
    fileExceptionCode: null,
    rowExceptionCodes: [],
    exceptionCodes: [],
    eventClassCounts: { freight_charged: 1 },
    rowResults: [],
    ...overrides
  };
}

function financialSummary() {
  return {
    freightChargedMinor: "11800",
    rtoFreightChargedMinor: "0",
    returnFreightChargedMinor: "0",
    shipmentRefundMinor: "0",
    weightDisputeDebitMinor: "0",
    weightDisputeCreditMinor: "0",
    netWeightDisputeExposureMinor: "0",
    codCollectedMinor: "0",
    codRemittedMinor: "0",
    netCodReceivableMinor: "0",
    totalCourierPayableImpactMinor: "11800",
    totalSellerShippingImpactMinor: "11800"
  };
}

function tieOut(): RecoveryReportTieOut {
  return {
    journalEntryCount: 1,
    journalPostingCount: 2,
    debitTotalMinor: "11800",
    creditTotalMinor: "11800",
    balanced: true,
    reportMappedTotalMinor: "11800",
    stagingPostedRowCount: 1,
    ledgerEntriesFromPostedRowsCount: 1,
    rowsWithPostedEntryRefButMissingLedgerEntry: 0,
    ledgerEntriesWithoutMatchingPostedStagingRow: 0,
    warnings: []
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeHarness(options: {
  activePack?: boolean;
  fixtureStatus?: "passed" | "failed";
  parserOverrides?: Record<string, unknown>;
  reportTieOut?: ReturnType<typeof tieOut>;
  reportImportQuality?: Record<string, unknown>;
} = {}) {
  const calls = {
    findActive: parseCallList(),
    fixtureRuns: parseCallList(),
    parse: parseCallList(),
    land: parseCallList(),
    post: parseCallList(),
    report: parseCallList(),
    plan: parseCallList(),
    approve: parseCallList(),
    apply: parseCallList(),
    activation: parseCallList()
  };
  const client = {
    accountTypeConfig: {
      findMany: async () => defaultAccountTypeConfigs.map((config) => ({ ...config }))
    },
    formatPackVersion: {
      findFirst: async (input: Record<string, unknown>) => {
        calls.findActive.push(input);
        return options.activePack === false ? null : { id: "fpv_active", status: "active", pack: { source: "courier_mis", courierCode: "courier_alpha" } };
      }
    }
  };
  const contentProvider = {
    readText: async (storagePath: string) => `source,charge,amount\n${storagePath},FWD,118.00`
  };
  const fixtureRunner = {
    runFixtures: async (input: Record<string, unknown>) => {
      calls.fixtureRuns.push(input);
      const status = options.fixtureStatus ?? "passed";
      return {
        status,
        result: { status, fixtureCount: 1 },
        testRun: { id: "test_run_1", status }
      };
    }
  };
  const parser = {
    dryRunParseCsv: async (input: Record<string, unknown>) => {
      calls.parse.push(input);
      return parserResult({
        statedTotalMinor: input.statedTotalMinor ?? null,
        ...options.parserOverrides
      });
    }
  };
  const landedByHash = new Map<string, Record<string, unknown>>();
  const importFiles = {
    landFile: async (input: Record<string, unknown>) => {
      calls.land.push(input);
      const fileHash = String(input.fileHash);
      const existing = landedByHash.get(fileHash);
      if (existing) return existing;
      const landed = { id: `file_${landedByHash.size + 1}`, ...input };
      landedByHash.set(fileHash, landed);
      return landed;
    }
  };
  const shadowPosting = {
    postReadyRowsForFile: async (input: Record<string, unknown>) => {
      calls.post.push(input);
      return {
        fileId: input.fileId,
        attemptedCount: 1,
        postedCount: input.dryRun === true ? 0 : 1,
        skippedCount: 0,
        failedCount: 0,
        dryRun: input.dryRun === true,
        rows: [{
          stagingRowId: "row_1",
          rowNo: 2,
          status: input.dryRun === true ? "mapped" : "posted",
          entryRef: "W0INT-entry-1",
          entryType: "shipment_charge",
          amountMinor: "11800",
          command: { redacted: true }
        }]
      };
    }
  };
  const recoveryReports = {
    generateRecoveryReport: async (input: Record<string, unknown>) => {
      calls.report.push(input);
      return {
        metadata: {
          brandOrgId: input.brandOrgId,
          period: input.period,
          fileIds: input.fileIds ?? [],
          generatedAt: "2026-07-04T00:00:00.000Z",
          ledgerScope: "shadow",
          reportVersion: "w0c2",
          warnings: []
        },
        importQuality: {
          fileCount: 1,
          stagedRowCount: 1,
          postedRowCount: 1,
          unpostedRowCount: 0,
          exceptionRowCount: 0,
          autoPostRateBps: 10000,
          filesByStatus: {},
          rowsByStatus: {},
          rowsByExceptionCode: {},
          formatPackVersions: ["fpv_active"],
          ...options.reportImportQuality
        },
        financialSummary: financialSummary(),
        rtoSummary: {},
        weightDisputeSummary: {},
        codSummary: {},
        courierSummary: [],
        tieOut: options.reportTieOut ?? tieOut(),
        exceptions: {
          byExceptionCode: {},
          deductionUnattributed: { count: 0, amountMinor: "0" },
          unknownEventClassRows: 0,
          unresolvedShipmentRows: 0,
          fileExceptionCount: 0
        },
        rowDetails: input.includeRows ? [{ raw: "must-not-return" }] : undefined
      };
    }
  };
  const correctionPlanner = {
    planCorrection: async (input: Record<string, unknown>) => {
      calls.plan.push(input);
      return {
        batchId: input.persistPlan ? "batch_1" : undefined,
        importFileId: input.importFileId,
        oldFormatPackVersionId: "fpv_old",
        newFormatPackVersionId: input.newFormatPackVersionId,
        items: [{ id: "item_1" }],
        actionCounts: {
          no_change: 0,
          post_new: 1,
          reverse_only: 0,
          reverse_and_repost: 0,
          still_exception: 0,
          unmatched_old_row: 0,
          ambiguous_match: 0
        },
        warnings: []
      };
    }
  };
  const correctionApply = {
    approveCorrectionBatch: async (input: Record<string, unknown>) => {
      calls.approve.push(input);
      return { status: "approved", approvedBy: input.approvedBy };
    },
    applyCorrectionBatch: async (input: Record<string, unknown>) => {
      calls.apply.push(input);
      return {
        status: "applied",
        itemCount: 1,
        postedReversalCount: 1,
        postedCorrectedCount: 1,
        failedCount: 0
      };
    }
  };
  const activation = {
    validateVersion: async (input: Record<string, unknown>) => {
      calls.activation.push({ step: "validate", ...input });
    },
    markCanary: async (input: Record<string, unknown>) => {
      calls.activation.push({ step: "canary", ...input });
    },
    activateVersion: async (input: Record<string, unknown>) => {
      calls.activation.push({ step: "activate", ...input });
    }
  };
  const service = new PilotOpsService({
    client,
    contentProvider,
    fixtureRunner,
    parser,
    importFiles,
    shadowPosting,
    recoveryReports,
    correctionPlanner,
    correctionApply,
    activation
  } as never);
  return { service, calls };
}

function baseImportInput(overrides: Record<string, unknown> = {}) {
  return {
    csvContent: "source,charge,amount\nref,FWD,118.00",
    fileHash: "hash_1",
    source: "courier_mis",
    counterparty: "courier_alpha",
    brandOrgId: "seller_alpha",
    period: "2026-07",
    createdBy: "system:w0d-test",
    ...overrides
  };
}

describe("W0D pilot ops wrapper", () => {
  it("checks W0 readiness without requiring external provider config", async () => {
    const { service } = makeHarness();
    const result = await service.checkW0Readiness({ source: "courier_mis", counterparty: "courier_alpha" });

    assert.equal(result.ok, true);
    assert.equal(result.blockingIssues.length, 0);
    assert.equal(result.checks.some((item) => item.name === "custody_not_required" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.name === "payment_config_not_required" && item.status === "pass"), true);
    assert.equal(result.checks.some((item) => item.name === "active_format_pack" && item.status === "pass"), true);
  });

  it("warns when no active pack is found but keeps nonblocking readiness", async () => {
    const { service } = makeHarness({ activePack: false });
    const result = await service.checkW0Readiness({ source: "courier_mis", counterparty: "courier_alpha" });

    assert.equal(result.ok, true);
    assert.equal(result.checks.some((item) => item.name === "active_format_pack" && item.status === "warn"), true);
    assert.equal(result.warnings.some((item) => item.code === "ACTIVE_FORMAT_PACK_NOT_FOUND"), true);
  });

  it("returns structured readiness output when local W0 tables are not applied", async () => {
    const missingTableError = Object.assign(new Error("missing relation"), { code: "P2021" });
    const service = new PilotOpsService({
      client: {
        accountTypeConfig: { findMany: async () => { throw missingTableError; } },
        formatPackVersion: { findFirst: async () => { throw missingTableError; } }
      }
    } as never);
    const result = await service.checkW0Readiness({ source: "courier_mis", counterparty: "courier_alpha" });

    assert.equal(result.ok, false);
    assert.equal(result.checks.some((item) => item.name === "account_type_config" && item.status === "fail"), true);
    assert.equal(result.checks.some((item) => item.name === "active_format_pack" && item.status === "warn"), true);
    assert.equal(result.warnings.some((item) => item.code === "W0_SCHEMA_NOT_APPLIED"), true);
    assert.equal(result.warnings.some((item) => item.code === "ACTIVE_FORMAT_PACK_NOT_FOUND"), true);
  });

  it("creates CLI runtime service with a complete dependency graph", async () => {
    const service = createPilotOpsServiceForCli({
      client: {
        accountTypeConfig: { findMany: async () => defaultAccountTypeConfigs.map((config) => ({ ...config })) },
        formatPackVersion: { findFirst: async () => null }
      }
    });
    const result = await service.checkW0Readiness({ source: "courier_mis", counterparty: "missing_pack" });

    assert.equal(result.ok, true);
    assert.equal(result.checks.some((item) => item.name === "active_format_pack" && item.status === "warn"), true);
    assert.equal(result.warnings.some((item) => item.code === "ACTIVE_FORMAT_PACK_NOT_FOUND"), true);
  });

  it("rejects incomplete CLI runtime wiring before service execution", () => {
    assert.throws(
      () => createPilotOpsServiceForCli({ client: { formatPackVersion: { findFirst: async () => null } } }),
      /W0_PILOT_CLI_ACCOUNT_TYPE_CONFIG_CLIENT_MISSING/
    );
  });

  it("accepts --file and --csv as local CSV path aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "w0-cli-args-"));
    try {
      writeFileSync(join(root, "sample.csv"), "source,charge,amount\nref,FWD,118.00\n", "utf8");
      writeFileSync(join(root, "orders.csv"), "Name\n#1001\n", "utf8");
      const fromFile = cliBaseImportInput(["import-dry-run", "--source", "courier_mis", "--file", "sample.csv"], root);
      const fromCsv = cliBaseImportInput(["import-dry-run", "--source", "courier_mis", "--csv", "sample.csv", "--orders-file", "orders.csv"], root);

      assert.equal(fromFile.csvContent, fromCsv.csvContent);
      assert.match(String(fromCsv.ordersCsvContent), /#1001/);
      assert.match(String(fromFile.csvContent), /ref,FWD,118\.00/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("computes server-side hash for import-dry-run input loaded through --file", async () => {
    const root = mkdtempSync(join(tmpdir(), "w0-cli-hash-"));
    try {
      const csv = "source,charge,amount\nfile-ref,FWD,118.00\n";
      writeFileSync(join(root, "sample.csv"), csv, "utf8");
      const input = cliBaseImportInput([
        "import-dry-run",
        "--source",
        "courier_mis",
        "--counterparty",
        "courier_alpha",
        "--file",
        "sample.csv"
      ], root);
      const { service } = makeHarness();
      const result = await service.runImportDryRun(input);

      assert.equal(result.fileHash, sha256(csv));
      assert.equal(result.rowCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a clean missing-pack error for CLI file dry-runs when no active pack exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "w0-cli-missing-pack-"));
    try {
      writeFileSync(join(root, "sample.csv"), "source,charge,amount\nref,FWD,118.00\n", "utf8");
      const input = cliBaseImportInput(["import-dry-run", "--source", "courier_mis", "--file", "sample.csv"], root);
      const { service } = makeHarness({ activePack: false });

      await assert.rejects(
        service.runImportDryRun(input),
        (error) => error instanceof ImportPipelineError && error.code === "ACTIVE_FORMAT_PACK_NOT_FOUND"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps missing local format-pack schema to a clean active-pack error", async () => {
    const root = mkdtempSync(join(tmpdir(), "w0-cli-missing-schema-"));
    try {
      const missingTableError = Object.assign(new Error("missing relation"), { code: "P2021" });
      writeFileSync(join(root, "sample.csv"), "source,charge,amount\nref,FWD,118.00\n", "utf8");
      const input = cliBaseImportInput(["import-dry-run", "--source", "courier_mis", "--file", "sample.csv"], root);
      const service = new PilotOpsService({
        client: {
          accountTypeConfig: { findMany: async () => defaultAccountTypeConfigs },
          formatPackVersion: { findFirst: async () => { throw missingTableError; } }
        }
      } as never);

      await assert.rejects(
        service.runImportDryRun(input),
        (error) => error instanceof ImportPipelineError && error.code === "ACTIVE_FORMAT_PACK_NOT_FOUND"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps CLI dry-run aliases and execute gate explicit", () => {
    assert.equal(cliCommandName(["w0:readiness"]), "readiness");
    assert.equal(cliCommandName(["readiness"]), "readiness");
    assert.throws(() => cliRequireExecute([]), /--execute is required/);
    assert.doesNotThrow(() => cliRequireExecute(["--execute"]));
  });

  it("runs format-pack validation as a dry-run by default", async () => {
    const { service, calls } = makeHarness();
    const result = await service.runFormatPackValidationFlow({ packVersionId: "fpv_1", requestedBy: "system:maker" });

    assert.equal(result.dryRun, true);
    assert.equal(result.fixtureRunExecuted, true);
    assert.equal(result.fixtureRunRecorded, true);
    assert.equal(result.fixtureRunSkipped, false);
    assert.equal(result.statusMutationPerformed, false);
    assert.deepEqual(result.intendedTransitions, ["validate"]);
    assert.deepEqual(result.executedTransitions, []);
    assert.equal(result.warnings.some((item) => item.code === "DRY_RUN_FIXTURE_TEST_RUN_RECORDED"), true);
    assert.equal(calls.fixtureRuns.length, 1);
    assert.equal(calls.activation.length, 0);
  });

  it("executes validation and activation only with maker-checker principals", async () => {
    const { service, calls } = makeHarness();
    const result = await service.runFormatPackValidationFlow({
      packVersionId: "fpv_1",
      requestedBy: "system:maker",
      approvedBy: "system:checker",
      activate: true,
      dryRun: false
    });

    assert.deepEqual(result.executedTransitions, ["validate", "canary", "activate"]);
    assert.equal(result.statusMutationPerformed, true);
    assert.deepEqual(calls.activation.map((call) => call.step), ["validate", "canary", "activate"]);
  });

  it("rejects same principal for format-pack activation", async () => {
    const { service } = makeHarness();
    await assert.rejects(
      service.runFormatPackValidationFlow({
        packVersionId: "fpv_1",
        requestedBy: "system:maker",
        approvedBy: "system:maker",
        activate: true,
        dryRun: false
      }),
      (error) => error instanceof ImportPipelineError && error.code === "PRINCIPAL_NOT_DISTINCT"
    );
  });

  it("runs import dry-run without persisting staged rows", async () => {
    const { service, calls } = makeHarness();
    const result = await service.runImportDryRun(baseImportInput());

    assert.equal(result.fileHash, sha256(String(baseImportInput().csvContent)));
    assert.equal(result.rowCount, 1);
    assert.equal(result.shippable, true);
    assert.deepEqual(result.blockingIssues, []);
    assert.equal(result.metrics.autoPostRateBps, null);
    assert.equal(result.metrics.humanTouchPerThousandRows, 0);
    assert.equal(calls.parse.length, 1);
    assert.equal(calls.parse[0]?.persistStagingRows, false);
    assert.equal(calls.land.length, 0);
  });

  it("rejects mismatched expectedFileHash", async () => {
    const { service } = makeHarness();
    await assert.rejects(
      service.runImportDryRun(baseImportInput({ expectedFileHash: "0".repeat(64) })),
      (error) => error instanceof ImportPipelineError && error.code === "FILE_HASH_MISMATCH"
    );
  });

  it("uses server-derived hash for stage dedupe and ignores stale caller fileHash", async () => {
    const { service, calls } = makeHarness();
    const csvContent = String(baseImportInput().csvContent);
    const first = await service.runImportAndStage(baseImportInput({ execute: true, fileHash: "caller_a" }));
    const second = await service.runImportAndStage(baseImportInput({ execute: true, fileHash: "caller_b" }));
    const third = await service.runImportAndStage(baseImportInput({
      execute: true,
      fileHash: "caller_a",
      csvContent: `${csvContent}\nref2,FWD,20.00`
    }));

    assert.equal(first.fileHash, sha256(csvContent));
    assert.equal(second.fileHash, first.fileHash);
    assert.equal(second.importFileId, first.importFileId);
    assert.notEqual(third.fileHash, first.fileHash);
    assert.notEqual(third.importFileId, first.importFileId);
    assert.deepEqual(calls.land.map((call) => call.fileHash), [first.fileHash, first.fileHash, third.fileHash]);
  });

  it("marks import summaries non-shippable when stated and parsed totals diverge", async () => {
    const { service } = makeHarness({
      parserOverrides: {
        parsedTotalMinor: "11800",
        postableTotalMinor: "11800",
        rawFileTotalMinor: "11800",
        allRowsTotalMinor: "11800",
        statedTotalMinor: "12000",
        fileTies: false,
        fileExceptionCode: "TOTAL_MISMATCH",
        exceptionCount: 1,
        fileExceptionCount: 1,
        exceptionCodes: ["TOTAL_MISMATCH"]
      }
    });
    const result = await service.runImportDryRun(baseImportInput({ statedTotalMinor: "12000" }));

    assert.equal(result.shippable, false);
    assert.deepEqual(result.blockingIssues, ["IMPORT_TOTAL_MISMATCH"]);
  });

  it("keeps raw file ties separate from postable row exceptions", async () => {
    const { service } = makeHarness({
      parserOverrides: {
        parsedCount: 1,
        parsedRowCount: 1,
        exceptionCount: 1,
        exceptionRowCount: 1,
        postableRowCount: 1,
        parsedTotalMinor: "11800",
        postableTotalMinor: "11800",
        rawFileTotalMinor: "12000",
        allRowsTotalMinor: "12000",
        statedTotalMinor: "12000",
        fileTies: true,
        rowExceptionCodes: ["UNKNOWN_CHARGE_CODE"],
        exceptionCodes: ["UNKNOWN_CHARGE_CODE"],
        statusCounts: { resolved: 1, exception: 1 }
      }
    });
    const result = await service.runImportDryRun(baseImportInput({ statedTotalMinor: "12000" }));

    assert.equal(result.fileTies, true);
    assert.equal(result.rawFileTotalMinor, "12000");
    assert.equal(result.postableTotalMinor, "11800");
    assert.equal(result.blockingIssues.includes("IMPORT_TOTAL_MISMATCH"), false);
    assert.equal(result.blockingIssues.includes("IMPORT_ROW_EXCEPTIONS_PRESENT"), true);
  });

  it("does not expose raw readable refs from parser output", async () => {
    const markerA = ["A", "W", "B", "-VISIBLE"].join("");
    const markerB = ["order", "_", "VISIBLE"].join("");
    const contact = ["lead", "@", "example.test"].join("");
    const calls = parseCallList();
    const service = new PilotOpsService({
      client: {
        accountTypeConfig: { findMany: async () => defaultAccountTypeConfigs },
        formatPackVersion: { findFirst: async () => ({ id: "fpv_1", status: "active" }) }
      },
      parser: {
        dryRunParseCsv: async (input: Record<string, unknown>) => {
          calls.push(input);
          return parserResult({
            rowResults: [{ raw: { token: markerA, other: markerB, contact } }]
          });
        }
      }
    } as never);

    const output = JSON.stringify(await service.runImportDryRun(baseImportInput()));
    assert.equal(output.includes(markerA), false);
    assert.equal(output.includes(markerB), false);
    assert.equal(output.includes(contact), false);
  });

  it("stages imports only when execute is explicit", async () => {
    const { service, calls } = makeHarness();
    const preview = await service.runImportAndStage(baseImportInput());

    assert.equal(preview.execute, false);
    assert.equal(calls.land.length, 0);
    assert.equal(calls.parse.length, 0);

    const executed = await service.runImportAndStage(baseImportInput({ execute: true }));
    assert.equal(executed.execute, true);
    assert.equal(executed.importFileId, "file_1");
    assert.equal(executed.shippable, true);
    assert.equal(executed.metrics.humanTouchPerThousandRows, 0);
    assert.equal(calls.land.length, 1);
    assert.equal(calls.parse[0]?.persistStagingRows, true);
  });

  it("posts staged rows through the shadow posting service and defaults to dry-run", async () => {
    const { service, calls } = makeHarness();
    const preview = await service.postStagedRowsToShadowLedger({ fileId: "file_1", createdBy: "system:poster" });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.postedCount, 0);
    assert.equal(preview.metrics.autoPostRateBps, 0);
    assert.equal(calls.post[0]?.dryRun, true);

    const executed = await service.postStagedRowsToShadowLedger({ fileId: "file_1", createdBy: "system:poster", dryRun: false });
    assert.equal(executed.dryRun, false);
    assert.equal(executed.postedCount, 1);
    assert.equal(executed.metrics.autoPostRateBps, 10000);
    assert.equal(executed.metrics.humanTouchPerThousandRows, 0);
    assert.equal(calls.post[1]?.dryRun, false);
  });

  it("generates recovery reports without row detail output", async () => {
    const { service, calls } = makeHarness();
    const report = await service.generatePilotRecoveryReport({ brandOrgId: "seller_alpha", includeRows: true });

    assert.equal(calls.report[0]?.includeRows, false);
    assert.equal(report.importQuality.postedRowCount, 1);
    assert.equal(report.shippable, true);
    assert.equal(report.metrics.autoPostRateBps, 10000);
    assert.equal(report.metrics.humanTouchPerThousandRows, 0);
    assert.equal(report.warnings.some((item) => item.code === "ROW_DETAILS_SUPPRESSED"), true);
    assert.equal(Object.hasOwn(report, "rowDetails"), false);
  });

  it("blocks non-shippable reports when tie-out fails", async () => {
    const { service } = makeHarness({
      reportTieOut: {
        ...tieOut(),
        balanced: false,
        rowsWithPostedEntryRefButMissingLedgerEntry: 1,
        ledgerEntriesWithoutMatchingPostedStagingRow: 1,
        warnings: ["tie-out mismatch"]
      }
    });
    const report = await service.generatePilotRecoveryReport({ brandOrgId: "seller_alpha" });

    assert.equal(report.shippable, false);
    assert.deepEqual(report.blockingIssues, [
      "TIE_OUT_NOT_BALANCED",
      "POSTED_ROW_MISSING_LEDGER_ENTRY",
      "LEDGER_ENTRY_MISSING_STAGING_ROW"
    ]);
    assert.equal(report.warnings.some((item) => item.code === "REPORT_TIE_OUT_WARNING"), true);
  });

  it("computes human-touch proxy from exception rows and handles zero denominators", async () => {
    const normal = makeHarness({
      parserOverrides: {
        rowCount: 4,
        exceptionCount: 1,
        exceptionRowCount: 1
      },
      reportImportQuality: {
        stagedRowCount: 4,
        postedRowCount: 3,
        exceptionRowCount: 1
      }
    });
    const dryRun = await normal.service.runImportDryRun(baseImportInput());
    const report = await normal.service.generatePilotRecoveryReport({ brandOrgId: "seller_alpha" });

    assert.equal(dryRun.metrics.humanTouchPerThousandRows, 250);
    assert.equal(report.metrics.autoPostRateBps, 7500);
    assert.equal(report.metrics.humanTouchPerThousandRows, 250);

    const zero = makeHarness({
      parserOverrides: {
        rowCount: 0,
        exceptionCount: 0,
        exceptionRowCount: 0
      },
      reportImportQuality: {
        stagedRowCount: 0,
        postedRowCount: 0,
        exceptionRowCount: 0
      }
    });
    const zeroSummary = await zero.service.runImportDryRun(baseImportInput());
    const zeroReport = await zero.service.generatePilotRecoveryReport({ brandOrgId: "seller_alpha" });
    assert.equal(zeroSummary.metrics.humanTouchPerThousandRows, null);
    assert.equal(zeroReport.metrics.autoPostRateBps, null);
    assert.equal(zeroReport.metrics.humanTouchPerThousandRows, null);
  });

  it("plans correction without persistence unless explicitly requested", async () => {
    const { service, calls } = makeHarness();
    const preview = await service.planImportCorrection({
      importFileId: "file_1",
      newFormatPackVersionId: "fpv_new",
      reason: "local pilot check",
      createdBy: "system:planner"
    });
    const persisted = await service.planImportCorrection({
      importFileId: "file_1",
      newFormatPackVersionId: "fpv_new",
      reason: "local pilot check",
      createdBy: "system:planner",
      persistPlan: true
    });

    assert.equal(preview.persistPlan, false);
    assert.equal(preview.batchId, undefined);
    assert.equal(calls.plan[0]?.persistPlan, false);
    assert.equal(persisted.batchId, "batch_1");
    assert.equal(calls.plan[1]?.persistPlan, true);
  });

  it("previews correction application by default", async () => {
    const { service, calls } = makeHarness();
    const result = await service.approveAndApplyCorrection({ batchId: "batch_1" });

    assert.equal(result.execute, false);
    assert.equal(result.dryRun, true);
    assert.equal(calls.approve.length, 0);
    assert.equal(calls.apply.length, 0);
  });

  it("approves and applies correction only with separate principals", async () => {
    const { service, calls } = makeHarness();
    const result = await service.approveAndApplyCorrection({
      batchId: "batch_1",
      approvedBy: "system:checker",
      appliedBy: "system:runner",
      execute: true,
      dryRun: false
    });

    assert.equal(result.apply?.status, "applied");
    assert.equal(calls.approve.length, 1);
    assert.equal(calls.apply.length, 1);
    assert.equal(calls.apply[0]?.dryRun, false);
  });

  it("rejects same principal for correction application", async () => {
    const { service } = makeHarness();
    await assert.rejects(
      service.approveAndApplyCorrection({
        batchId: "batch_1",
        approvedBy: "system:runner",
        appliedBy: "system:runner",
        execute: true,
        dryRun: false
      }),
      (error) => error instanceof ImportPipelineError && error.code === "PRINCIPAL_NOT_DISTINCT"
    );
  });

  it("runs full pilot dry-run without mutating stage or correction state", async () => {
    const { service, calls } = makeHarness();
    const result = await service.runEndToEndPilotDryRun({
      ...baseImportInput({ fileId: "file_1", packVersionId: "fpv_1" })
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.readiness.ok, true);
    assert.equal(result.importDryRun.rowCount, 1);
    assert.equal(result.shadowPostDryRun?.dryRun, true);
    assert.equal(result.reportPreview?.metadata.ledgerScope, "shadow");
    assert.equal(result.shippable, true);
    assert.equal(result.metrics.autoPostRateBps, 10000);
    assert.equal(calls.land.length, 0);
    assert.equal(calls.activation.length, 0);
  });

  it("carries import total mismatch into e2e dry-run shippable status", async () => {
    const { service } = makeHarness({
      parserOverrides: {
        parsedTotalMinor: "11800",
        postableTotalMinor: "11800",
        rawFileTotalMinor: "11800",
        allRowsTotalMinor: "11800",
        statedTotalMinor: "12000",
        fileTies: false,
        fileExceptionCode: "TOTAL_MISMATCH",
        exceptionCount: 1,
        fileExceptionCount: 1,
        exceptionCodes: ["TOTAL_MISMATCH"]
      }
    });
    const result = await service.runEndToEndPilotDryRun(baseImportInput({ fileId: "file_1", statedTotalMinor: "12000" }));

    assert.equal(result.shippable, false);
    assert.equal(result.blockingIssues.includes("IMPORT_TOTAL_MISMATCH"), true);
    assert.equal(result.checklist.some((item) => item.name === "shippable" && item.status === "fail"), true);
  });

  it("runs local pilot execution only when execute is true", async () => {
    const { service, calls } = makeHarness();
    const preview = await service.runEndToEndPilotLocal(baseImportInput());

    assert.equal(preview.execute, false);
    assert.equal(preview.stagedRowCount, 0);
    assert.equal(calls.land.length, 0);

    const executed = await service.runEndToEndPilotLocal(baseImportInput({ execute: true }));
    assert.equal(executed.execute, true);
    assert.equal(executed.importFileId, "file_1");
    assert.equal(executed.postedCount, 1);
    assert.equal(executed.shippable, true);
    assert.equal(executed.metrics.autoPostRateBps, 10000);
    assert.equal(calls.land.length, 1);
    assert.equal(calls.post.at(-1)?.dryRun, false);
  });

  it("validates local pilot principals", () => {
    assert.equal(cleanW0PilotPrincipal("import_pipeline_w0"), "import_pipeline_w0");
    assert.equal(cleanW0PilotPrincipal("system:pilot"), "system:pilot");
    assert.equal(cleanW0PilotPrincipal("usr_internal"), "usr_internal");
    assert.throws(() => cleanW0PilotPrincipal(["person", "@", "example.test"].join("")), ImportPipelineError);
    assert.throws(() => cleanW0PilotPrincipal("external-user"), ImportPipelineError);
  });

  it("keeps W0D source free of public APIs, direct ledger writes, floats, and future work markers", () => {
    const root = process.cwd();
    const files = [
      join(root, "src/modules/importPipeline/pilot-ops.service.ts"),
      join(root, "src/modules/importPipeline/pilot-ops-cli-runtime.ts"),
      join(root, "src/modules/importPipeline/synthetic-bigship-format-pack.ts"),
      join(root, "src/modules/importPipeline/pilot-ops.types.ts"),
      join(root, "src/modules/importPipeline/import-pipeline.module.ts"),
      join(root, "scripts/wallet-w0-pilot.mjs")
    ];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    const blocked = [
      ["journal", "Entry.create"].join(""),
      ["journal", "Posting.create"].join(""),
      ["account", "Balance.update"].join(""),
      ["wallet", "EventOutbox.create"].join(""),
      ["parse", "Float"].join(""),
      ["Math", ".round"].join(""),
      ["Num", "ber("].join(""),
      ["platform", "_escrow"].join(""),
      ["gateway", "_clearing"].join(""),
      ["platform", "_revenue"].join(""),
      ["fee", "_expense"].join(""),
      ["tax", "_payable"].join(""),
      ["courier", "_suspense"].join(""),
      ["courier", "_leakage"].join(""),
      ["Router", "("].join(""),
      [".get", "("].join(""),
      [".post", "("].join(""),
      ["weight_dispute", "_capture"].join(""),
      ["dispute", " aging"].join(""),
      ["aging", " job"].join(""),
      ["repeat-billing", " resolver"].join(""),
      ["repeat billing", " resolver"].join(""),
      ["double-billing", " classifier"].join(""),
      ["repeat", "Billing"].join("")
    ];

    for (const marker of blocked) {
      assert.equal(source.includes(marker), false, marker);
    }
  });
});
