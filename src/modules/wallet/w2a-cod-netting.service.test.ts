import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import { W1ActivationGateService } from "./w1-activation-gate.service.js";
import {
  CodInstructionNettingService,
  CodNettingBatchService,
  CodNettingReadService,
  W2CodReadinessService,
  type CodNettingBatchCommand,
  type CodNettingEventRecord,
  type CodNettingInstructionStatus,
  type CodNettingItemRecord,
  type CodNettingStore,
  type CodNettingStoredBatch
} from "./w2a-cod-netting.service.js";

const now = new Date("2026-07-05T08:00:00.000Z");

function cloneState<T>(value: T): T {
  return structuredClone(value as never) as T;
}

class MemoryCodNettingStore implements CodNettingStore {
  batches: CodNettingStoredBatch[] = [];

  async findBatchByKey(input: { sellerOrgId: string; courierCode: string; period: string; sourceRef: string }) {
    return cloneState(this.batches.find((entry) => entry.batch.sellerOrgId === input.sellerOrgId
      && entry.batch.courierCode === input.courierCode
      && entry.batch.period === input.period
      && entry.batch.sourceRef === input.sourceRef) ?? null);
  }

  async findBatchById(batchId: string) {
    return cloneState(this.batches.find((entry) => entry.batch.id === batchId) ?? null);
  }

  async createBatch(input: Parameters<CodNettingStore["createBatch"]>[0]) {
    const batchId = `cnb_${this.batches.length + 1}`;
    const record: CodNettingStoredBatch = {
      batch: {
        id: batchId,
        ...input.batch,
        createdAt: now,
        updatedAt: now
      },
      items: input.items.map((item, index) => ({
        id: `cni_${this.batches.length + 1}_${index + 1}`,
        batchId,
        ...item,
        createdAt: now,
        updatedAt: now
      })) as CodNettingItemRecord[],
      events: [{
        id: `cne_${this.batches.length + 1}_1`,
        batchId,
        ...input.event,
        createdAt: now
      }] as CodNettingEventRecord[]
    };
    this.batches.push(record);
    return cloneState(record);
  }

  async updateBatchStatus(input: {
    batchId: string;
    status: CodNettingInstructionStatus;
    eventType: string;
    message?: string | null;
    createdBy?: string | null;
  }) {
    const record = this.batches.find((entry) => entry.batch.id === input.batchId);
    if (!record) throw new Error("missing test batch");
    record.batch.status = input.status;
    record.batch.updatedAt = now;
    record.events.push({
      id: `cne_${record.events.length + 1}`,
      batchId: input.batchId,
      itemId: null,
      eventType: input.eventType,
      status: input.status,
      message: input.message ?? null,
      metadata: { instructionOnly: true, movementExecuted: false },
      createdBy: input.createdBy ?? null,
      createdAt: now
    });
    return cloneState(record);
  }
}

function baseRows(): CodNettingBatchCommand["rows"] {
  return [
    {
      sellerOrgId: "org_w2a_seller",
      shipmentId: "shp_w2a_clean_0001",
      courierCode: "BIGSHIP_SYNTHETIC",
      deliveredAt: "2026-07-01T00:00:00.000Z",
      codCollectedMinor: "100000",
      freightDeductionMinor: "18000",
      rtoDeductionMinor: "5000",
      adjustmentMinor: "3000",
      expectedRemittanceMinor: "80000",
      remittanceRef: "rem_w2a_clean_0001",
      period: "2026-07"
    },
    {
      sellerOrgId: "org_w2a_seller",
      shipmentId: "shp_w2a_negative_0002",
      courierCode: "BIGSHIP_SYNTHETIC",
      deliveredAt: "2026-07-01T00:00:00.000Z",
      codCollectedMinor: "10000",
      freightDeductionMinor: "16000",
      rtoDeductionMinor: "1000",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "0",
      remittanceRef: "rem_w2a_negative_0002",
      period: "2026-07"
    },
    {
      sellerOrgId: "org_w2a_seller",
      shipmentId: "shp_w2a_dup_0003",
      courierCode: "BIGSHIP_SYNTHETIC",
      deliveredAt: "2026-07-01T00:00:00.000Z",
      codCollectedMinor: "45000",
      freightDeductionMinor: "5000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "40000",
      remittanceRef: "rem_w2a_dup_0003_a",
      period: "2026-07"
    },
    {
      sellerOrgId: "org_w2a_seller",
      shipmentId: "shp_w2a_dup_0003",
      courierCode: "BIGSHIP_SYNTHETIC",
      deliveredAt: "2026-07-01T00:00:00.000Z",
      codCollectedMinor: "45000",
      freightDeductionMinor: "5000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "40000",
      remittanceRef: "rem_w2a_dup_0003_b",
      period: "2026-07"
    },
    {
      sellerOrgId: "org_w2a_seller",
      shipmentId: "",
      courierCode: "BIGSHIP_SYNTHETIC",
      deliveredAt: "2026-07-01T00:00:00.000Z",
      codCollectedMinor: "20000",
      freightDeductionMinor: "3000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "17000",
      remittanceRef: "rem_w2a_missing_0004",
      period: "2026-07"
    }
  ];
}

function cleanRow() {
  return baseRows()[0]!;
}

function command(rows = baseRows(), overrides: Partial<CodNettingBatchCommand> = {}): CodNettingBatchCommand {
  return {
    sellerOrgId: "org_w2a_seller",
    courierCode: "BIGSHIP_SYNTHETIC",
    period: "2026-07",
    sourceRef: "w2a_source_2026_07",
    rows,
    ...overrides
  };
}

describe("W2A COD instruction-only netting", () => {
  it("calculates net formula and batch totals with string minor units", () => {
    const report = new CodInstructionNettingService({ store: new MemoryCodNettingStore() }).planBatch(command());

    assert.equal(report.batch.totals.codCollectedMinor, "220000");
    assert.equal(report.batch.totals.freightDeductionMinor, "47000");
    assert.equal(report.batch.totals.rtoDeductionMinor, "6000");
    assert.equal(report.batch.totals.adjustmentMinor, "3000");
    assert.equal(report.batch.totals.sellerNetReceivableMinor, "170000");
    assert.equal(report.batch.totals.negativeNetMinor, "7000");
    assert.equal(report.items[0]!.sellerNetReceivableMinor, "80000");
  });

  it("marks negative, missing, duplicate, invalid, and unknown rows for review", () => {
    const rows = [
      ...baseRows(),
      {
        ...cleanRow(),
        shipmentId: "shp_w2a_bad_amount_0005",
        codCollectedMinor: "12.50"
      },
      {
        ...cleanRow(),
        shipmentId: "shp_w2a_unknown_0006",
        courierCode: "UNKNOWN_SYNTHETIC"
      }
    ];
    const report = new CodInstructionNettingService({ store: new MemoryCodNettingStore() }).planBatch(command(rows));
    const reasonsByRef = new Map(report.items.map((item) => [item.shipmentId ?? "missing", item.reviewReasons]));

    assert.ok(reasonsByRef.get("shp_w2a_negative_0002")?.includes("NEGATIVE_NET"));
    assert.ok(reasonsByRef.get("missing")?.includes("MISSING_SHIPMENT_ID"));
    assert.ok(reasonsByRef.get("shp_w2a_dup_0003")?.includes("DUPLICATE_SHIPMENT_ID"));
    assert.ok(reasonsByRef.get("shp_w2a_bad_amount_0005")?.includes("INVALID_AMOUNT"));
    assert.ok(reasonsByRef.get("shp_w2a_unknown_0006")?.includes("UNKNOWN_COURIER_CODE"));
    assert.equal(report.batch.status, "review_required");
  });

  it("keeps negative net as instruction only and does not auto-debit", () => {
    const report = new CodInstructionNettingService({ store: new MemoryCodNettingStore() }).planBatch(command());
    const item = report.items.find((entry) => entry.shipmentId === "shp_w2a_negative_0002");

    assert.equal(item?.instructionType, "seller_payable_to_platform_or_courier_instruction");
    assert.equal(item?.status, "review_required");
    assert.equal(report.batch.movementExecuted, false);
    assert.equal(report.batch.instructionOnly, true);
  });

  it("blocks approval when review issues exist and allows a clean batch to become approved_instruction", async () => {
    const store = new MemoryCodNettingStore();
    const service = new CodInstructionNettingService({ store, config: { appEnv: "test", nodeEnv: "test" } });
    const reviewBatch = await service.createBatch(command(baseRows(), { execute: true }));
    const batchService = new CodNettingBatchService(store);

    await assert.rejects(
      () => batchService.approveInstructionBatch(reviewBatch.batch.id),
      (error) => error instanceof HttpError && error.message === "W2A_REVIEW_REQUIRED"
    );

    const cleanBatch = await service.createBatch(command([cleanRow()], { sourceRef: "w2a_clean_source", execute: true }));
    const approved = await batchService.approveInstructionBatch(cleanBatch.batch.id, { approvedBy: "usr_w2a_checker" });

    assert.equal(approved.batch.status, "approved_instruction");
    assert.equal(approved.batch.movementExecuted, false);
  });

  it("exports report without implying external execution", async () => {
    const store = new MemoryCodNettingStore();
    const created = await new CodInstructionNettingService({ store, config: { appEnv: "test", nodeEnv: "test" } })
      .createBatch(command([cleanRow()], { execute: true }));
    const exported = await new CodNettingBatchService(store).exportInstructionReport(created.batch.id, "csv");

    assert.equal(exported.instructionOnly, true);
    assert.equal(exported.movementExecuted, false);
    assert.ok("csv" in exported);
    assert.match(exported.csv, /seller_receivable_instruction/u);
    assert.doesNotMatch(exported.csv, /executed/i);
  });

  it("is idempotent by sourceRef and conflicts when source hash changes", async () => {
    const store = new MemoryCodNettingStore();
    const service = new CodInstructionNettingService({ store, config: { appEnv: "test", nodeEnv: "test" } });
    const first = await service.createBatch(command([cleanRow()], { execute: true }));
    const second = await service.createBatch(command([cleanRow()], { execute: true }));

    assert.equal(first.batch.id, second.batch.id);
    assert.equal(second.idempotent, true);
    assert.equal(store.batches.length, 1);

    const changed = { ...cleanRow(), codCollectedMinor: "100001" };
    await assert.rejects(
      () => service.createBatch(command([changed], { execute: true })),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "W2A_SOURCE_REF_HASH_CONFLICT"
    );
  });

  it("does not persist unsafe inbound refs in DB-facing records or output", () => {
    const refTerm = ["ord", "er"].join("");
    const rows = [{
      ...cleanRow(),
      shipmentId: `${refTerm}_visible_9999999999`,
      remittanceRef: "rem_visible_9999999999"
    }];
    const report = new CodInstructionNettingService({ store: new MemoryCodNettingStore() }).planBatch(command(rows));
    const output = JSON.stringify(report);

    assert.equal(report.items[0]!.shipmentId, null);
    assert.ok(report.items[0]!.reviewReasons.includes("UNSAFE_INTERNAL_REF"));
    assert.doesNotMatch(output, /visible_9999999999/u);
  });

  it("read service returns instruction-only status and excludes spendable balances", async () => {
    const store = new MemoryCodNettingStore();
    const created = await new CodInstructionNettingService({ store, config: { appEnv: "test", nodeEnv: "test" } })
      .createBatch(command([cleanRow()], { execute: true }));
    const read = await new CodNettingReadService(store).getInstructionBatch(created.batch.id);
    const output = JSON.stringify(read);

    assert.equal(read.policy.mode, "instruction_only");
    assert.equal(read.policy.movementExecuted, false);
    assert.equal(read.policy.spendableBalanceCreated, false);
    assert.equal(output.includes(["shipping", "balance"].join("_")), false);
    assert.equal(/paid|settled/i.test(output), false);
  });

  it("execute defaults to dry-run and refuses non-local execute", async () => {
    const store = new MemoryCodNettingStore();
    const service = new CodInstructionNettingService({ store, config: { appEnv: "test", nodeEnv: "test" } });
    const dryRun = await service.createBatch(command([cleanRow()]));

    assert.equal(dryRun.dryRun, true);
    assert.equal(store.batches.length, 0);

    await assert.rejects(
      () => new CodInstructionNettingService({ store, config: { appEnv: "staging", nodeEnv: "production" } })
        .createBatch(command([cleanRow()], { execute: true })),
      (error) => error instanceof HttpError && error.message === "W2A_LOCAL_TEST_EXECUTE_REQUIRED"
    );
  });

  it("keeps W2 and W3 activation gate items blocked", () => {
    const report = new W1ActivationGateService().getW1ActivationGateStatus({ targetMode: "sandbox" });
    const readiness = new W2CodReadinessService().getReadiness();

    assert.equal(report.checklist.futureW2W3.every((item) => item.status === "blocked"), true);
    assert.equal(readiness.ok, false);
    assert.ok(readiness.blockingIssues.includes("W2_COD_CUSTODY_NOT_APPROVED"));
  });

  it("adds no public mutating W2 route and no direct ledger writes", () => {
    const source = [
      readFileSync("src/modules/wallet/w2a-cod-netting.service.ts", "utf8"),
      readFileSync("scripts/wallet-w2a-cod-netting-smoke.mjs", "utf8")
    ].join("\n");
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"));

    assert.match(routes, /apiRouter\.use\("\/internal\/wallet\/w2\/cod", requireInternalSecret, internalW2CodNettingRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/wallets\/w2\/cod", requireAdminJwt, adminW2CodNettingRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/seller\/wallet\/w2\/cod", requireJwtAuth, sellerW2CodNettingRouter\);/);
    assert.doesNotMatch(routes, /apiRouter\.use\("\/wallet\/w2/u);
    assert.equal(/\.(post|put|patch|delete)\(/u.test(readFileSync("src/modules/wallet/w2-cod-netting-read.routes.ts", "utf8")), false);
    assert.equal(directWritePattern.test(source), false);
  });

  it("keeps W2A source free of float conversion, live hooks, and custody account usage", () => {
    const source = [
      readFileSync("src/modules/wallet/w2a-cod-netting.service.ts", "utf8"),
      readFileSync("scripts/wallet-w2a-cod-netting-smoke.mjs", "utf8")
    ].join("\n");
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"));
    const livePattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" "),
      ["u", "pi"].join(""),
      ["im", "ps"].join(""),
      ["ne", "ft"].join("")
    ].join("|"), "i");
    const custodyAccountPattern = new RegExp([
      ["platform", "escrow"].join("_"),
      ["gateway", "clearing"].join("_"),
      ["platform", "revenue"].join("_"),
      ["fee", "expense"].join("_"),
      ["tax", "payable"].join("_"),
      ["courier", "suspense"].join("_"),
      ["courier", "leakage"].join("_")
    ].join("|"));

    assert.equal(floatPattern.test(source), false);
    assert.equal(livePattern.test(source), false);
    assert.equal(custodyAccountPattern.test(source), false);
  });
});
