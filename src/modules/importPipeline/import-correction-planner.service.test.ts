import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctionRowFingerprint } from "./import-correction-fingerprint.js";
import { ImportCorrectionPlannerService } from "./import-correction-planner.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";

type TestRow = {
  id: bigint;
  rowNo: number;
  parsed?: Record<string, unknown> | null;
  eventClass: string | null;
  shipmentId: string | null;
  status: string;
  exceptionCode: string | null;
  exceptionDetail?: Record<string, unknown> | null;
  postedEntryRef: string | null;
};

type NewRow = {
  rowNo: number;
  status: string;
  parsed?: Record<string, unknown>;
  eventClass?: string;
  shipmentId?: string;
  exceptionCode?: string;
  exceptionDetail?: Record<string, unknown>;
};

type NewRowOverride = Omit<Partial<NewRow>, "shipmentId" | "eventClass"> & {
  shipmentId?: string | null;
  eventClass?: string;
  amount?: string;
};

function parsed(amount: string, key: string, overrides: Record<string, unknown> = {}) {
  return {
    amount_minor: amount,
    event_date: "2026-07-04",
    charge_code: "base_charge",
    source_event_category: "courier_charge",
    duplicate_key: key,
    ...overrides
  };
}

function oldRow(overrides: Partial<TestRow> & { shipmentId?: string | null; eventClass?: string | null; amount?: string } = {}): TestRow {
  const id = overrides.id ?? 1n;
  const eventClass = overrides.eventClass ?? "freight_charged";
  const shipmentId = overrides.shipmentId ?? `shp_${id.toString()}`;
  return {
    id,
    rowNo: overrides.rowNo ?? parseInt(id.toString(), 10),
    parsed: overrides.parsed === undefined ? parsed(overrides.amount ?? "1000", `dup_${id.toString()}`) : overrides.parsed,
    eventClass,
    shipmentId,
    status: overrides.status ?? "resolved",
    exceptionCode: overrides.exceptionCode ?? null,
    exceptionDetail: overrides.exceptionDetail ?? null,
    postedEntryRef: overrides.postedEntryRef ?? `ile_${id.toString()}`,
    ...overrides
  };
}

function newRow(overrides: NewRowOverride = {}): NewRow {
  const rowNo = overrides.rowNo ?? 1;
  const eventClass = overrides.eventClass ?? "freight_charged";
  const shipmentId = overrides.shipmentId === null ? null : overrides.shipmentId ?? `shp_${rowNo.toString()}`;
  return {
    rowNo,
    status: overrides.status ?? "resolved",
    parsed: overrides.parsed ?? parsed(overrides.amount ?? "1000", `dup_${rowNo.toString()}`),
    eventClass,
    ...(shipmentId ? { shipmentId } : {}),
    ...(overrides.exceptionCode ? { exceptionCode: overrides.exceptionCode } : {}),
    ...(overrides.exceptionDetail ? { exceptionDetail: overrides.exceptionDetail } : {})
  };
}

function makeHarness(rows: TestRow[], nextRows: NewRow[]) {
  const state = {
    readCount: 0,
    parseInputs: [] as Array<Record<string, unknown>>,
    batches: [] as Array<Record<string, unknown>>,
    items: [] as Array<Record<string, unknown>>,
    file: {
      id: "file_w0c3a",
      source: "courier_mis",
      counterparty: "courier_alpha",
      brandOrgId: "brand_alpha",
      storagePath: "fixtures/correction.csv",
      formatPackVersionId: "fmt_old",
      statedTotalMinor: 1000n,
      stagingRows: rows
    }
  };

  const client = {
    importFile: {
      findUnique: async () => ({
        ...state.file,
        stagingRows: [...state.file.stagingRows].sort((left, right) => left.rowNo - right.rowNo)
      })
    },
    importCorrectionBatch: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.batches.push(data);
        return { id: `batch_${state.batches.length}` };
      }
    },
    importCorrectionItem: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.items.push(...data);
        return { count: data.length };
      }
    }
  };
  const parser = {
    dryRunParseCsv: async (input: Record<string, unknown>) => {
      state.parseInputs.push(input);
      return {
        rowCount: nextRows.length,
        parsedCount: nextRows.filter((row) => row.status !== "exception" && row.status !== "skipped").length,
        parsedRowCount: nextRows.filter((row) => row.status !== "exception" && row.status !== "skipped").length,
        resolvedCount: nextRows.filter((row) => row.status === "resolved").length,
        exceptionCount: nextRows.filter((row) => row.status === "exception").length,
        exceptionRowCount: nextRows.filter((row) => row.status === "exception").length,
        fileExceptionCount: 0,
        skippedCount: nextRows.filter((row) => row.status === "skipped").length,
        skippedRowCount: nextRows.filter((row) => row.status === "skipped").length,
        postableRowCount: nextRows.filter((row) => row.status !== "exception" && row.status !== "skipped").length,
        statusCounts: {},
        parsedTotalMinor: "1000",
        postableTotalMinor: "1000",
        rawFileTotalMinor: "1000",
        allRowsTotalMinor: "1000",
        statedTotalMinor: "1000",
        fileTies: true,
        fileStatus: "validated",
        rowExceptionCodes: [],
        exceptionCodes: [],
        eventClassCounts: {},
        rowResults: nextRows
      };
    }
  };
  const provider = {
    readText: async (path: string) => {
      assert.equal(path, state.file.storagePath);
      state.readCount += 1;
      return "header\nrow";
    }
  };

  const service = new ImportCorrectionPlannerService(client as never, parser as never, provider);
  return { service, state };
}

async function planWith(service: ImportCorrectionPlannerService, persistPlan = false) {
  return service.planCorrection({
    importFileId: "file_w0c3a",
    newFormatPackVersionId: "fmt_new",
    reason: "rerun upgraded parser",
    createdBy: "import_pipeline_w0",
    persistPlan
  });
}

describe("ImportCorrectionPlannerService", () => {
  it("plans every correction action without posting or staging mutation", async () => {
    const sameOld = oldRow({ id: 1n, shipmentId: "shp_same", amount: "1000", postedEntryRef: "ile_same" });
    const sameNew = newRow({ rowNo: 1, shipmentId: "shp_same", amount: "1000", parsed: sameOld.parsed as Record<string, unknown> });
    const exceptionOld = oldRow({
      id: 8n,
      rowNo: 8,
      shipmentId: null,
      eventClass: "unknown",
      parsed: parsed("1000", "dup_8"),
      status: "exception",
      exceptionCode: "UNKNOWN_EVENT_CLASS",
      postedEntryRef: null
    });
    const exceptionNew = newRow({
      rowNo: 8,
      shipmentId: null,
      eventClass: "unknown",
      parsed: exceptionOld.parsed as Record<string, unknown>,
      status: "exception",
      exceptionCode: "UNKNOWN_EVENT_CLASS"
    });
    const { service, state } = makeHarness([
      sameOld,
      oldRow({ id: 2n, shipmentId: "shp_amount", amount: "1000", postedEntryRef: "ile_amount" }),
      oldRow({ id: 3n, shipmentId: "shp_event", amount: "1000", postedEntryRef: "ile_event" }),
      oldRow({ id: 4n, shipmentId: "shp_removed", amount: "1000", postedEntryRef: "ile_removed" }),
      oldRow({ id: 5n, shipmentId: "shp_old_exception", parsed: null, status: "exception", exceptionCode: "ROW_PARSE_ERROR", postedEntryRef: null }),
      exceptionOld,
      oldRow({ id: 9n, shipmentId: "shp_ambiguous", amount: "1000", postedEntryRef: "ile_ambiguous" })
    ], [
      sameNew,
      newRow({ rowNo: 2, shipmentId: "shp_amount", amount: "1250" }),
      newRow({ rowNo: 3, shipmentId: "shp_event", amount: "1000", eventClass: "rto_freight_charged" }),
      newRow({ rowNo: 6, shipmentId: "shp_new", amount: "2000" }),
      exceptionNew,
      newRow({ rowNo: 10, shipmentId: "shp_ambiguous", amount: "1100" }),
      newRow({ rowNo: 11, shipmentId: "shp_ambiguous", amount: "1200" }),
      newRow({ rowNo: 12, eventClass: "deduction_unattributed", amount: "300", status: "validated" }),
      newRow({ rowNo: 13, shipmentId: "shp_unknown", eventClass: "unknown", amount: "400", status: "validated" })
    ]);

    const plan = await planWith(service);
    assert.equal(state.readCount, 1);
    assert.equal(state.parseInputs[0]?.persistStagingRows, false);
    assert.equal(state.batches.length, 0);
    assert.equal(state.items.length, 0);
    assert.equal(plan.actionCounts.no_change, 1);
    assert.equal(plan.actionCounts.reverse_and_repost, 2);
    assert.equal(plan.actionCounts.reverse_only, 1);
    assert.equal(plan.actionCounts.unmatched_old_row, 1);
    assert.equal(plan.actionCounts.post_new, 1);
    assert.equal(plan.actionCounts.still_exception, 3);
    assert.equal(plan.actionCounts.ambiguous_match, 1);
    assert.ok(plan.items.some((item) => item.action === "reverse_and_repost" && item.diff.reasonCode === "amount_changed"));
    assert.ok(plan.items.some((item) => item.action === "reverse_and_repost" && item.diff.reasonCode === "event_changed"));
    assert.ok(plan.items.some((item) => item.action === "still_exception" && item.diff.newEventClass === "deduction_unattributed"));
    assert.ok(plan.items.some((item) => item.action === "still_exception" && item.diff.newEventClass === "unknown"));
  });

  it("persists only correction plan tables when requested", async () => {
    const row = oldRow({ id: 1n, shipmentId: "shp_persist", amount: "1000", postedEntryRef: "ile_persist" });
    const { service, state } = makeHarness([row], [
      newRow({ rowNo: 1, shipmentId: "shp_persist", amount: "1000", parsed: row.parsed as Record<string, unknown> })
    ]);
    const plan = await planWith(service, true);
    assert.equal(plan.batchId, "batch_1");
    assert.equal(state.batches.length, 1);
    assert.equal(state.items.length, 1);
    assert.equal(state.batches[0]?.oldFormatPackVersionId, "fmt_old");
    assert.equal(state.batches[0]?.newFormatPackVersionId, "fmt_new");
    assert.equal(state.items[0]?.oldStagingRowId, 1n);
    assert.equal(state.items[0]?.action, "no_change");
  });

  it("rejects non-internal createdBy values", async () => {
    const { service } = makeHarness([], []);
    await assert.rejects(
      service.planCorrection({
        importFileId: "file_w0c3a",
        newFormatPackVersionId: "fmt_new",
        reason: "bad principal",
        createdBy: ["person", "@", "example.test"].join("")
      }),
      (error) => error instanceof ImportPipelineError && error.code === "IMPORT_CORRECTION_CREATED_BY_INVALID"
    );
  });

  it("keeps sensitive source tokens out of plan output", async () => {
    const transportToken = ["A", "W", "B"].join("") + "-source-777";
    const contactToken = ["person", "@", "example.test"].join("");
    const row = oldRow({
      id: 1n,
      shipmentId: "shp_safe",
      parsed: parsed("1000", "dup_safe", {
        external_ref: transportToken,
        contact_token: contactToken,
        route_hint: "560001"
      }),
      postedEntryRef: "ile_safe"
    });
    const { service } = makeHarness([row], [
      newRow({
        rowNo: 1,
        shipmentId: "shp_safe",
        parsed: row.parsed as Record<string, unknown>
      })
    ]);

    const plan = await planWith(service);
    const output = JSON.stringify(plan);
    assert.equal(output.includes(transportToken), false);
    assert.equal(output.includes(contactToken), false);
    assert.equal(output.includes("560001"), false);
  });

  it("generates deterministic fingerprints from normalized internal fields", () => {
    const first = correctionRowFingerprint({
      rowNo: 2,
      status: "resolved",
      parsed: parsed("1000", "dup_1", { noisy_source_value: "left" }),
      eventClass: "freight_charged",
      shipmentId: "shp_hash"
    });
    const second = correctionRowFingerprint({
      rowNo: 8,
      status: "resolved",
      parsed: parsed("1000", "dup_1", { noisy_source_value: "right" }),
      eventClass: "freight_charged",
      shipmentId: "shp_hash"
    });
    const changed = correctionRowFingerprint({
      rowNo: 8,
      status: "resolved",
      parsed: parsed("1100", "dup_1", { noisy_source_value: "right" }),
      eventClass: "freight_charged",
      shipmentId: "shp_hash"
    });
    assert.equal(first, second);
    assert.notEqual(first, changed);
  });
});
