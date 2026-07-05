import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  W2BCodNettingReadService,
  type W2BCodNettingReadStore
} from "./w2-cod-netting-read.service.js";
import {
  assertW2CodSellerQueryScope,
  sellerOrgIdFromW2CodAuth
} from "./w2-cod-netting-read.routes.js";
import type {
  CodNettingBatchRecord,
  CodNettingEventRecord,
  CodNettingItemRecord,
  CodNettingStoredBatch
} from "./w2a-cod-netting.service.js";

const now = new Date("2026-07-05T11:00:00.000Z");

function cloneState<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function cleanBatch(overrides: Partial<CodNettingBatchRecord> = {}): CodNettingBatchRecord {
  return {
    id: "cnb_w2b_clean_0001",
    sellerOrgId: "org_w2b_seller_a",
    courierCode: "BIGSHIP_SYNTHETIC",
    period: "2026-07",
    sourceRef: "w2b_source_clean",
    sourceHash: "hash_w2b_clean",
    status: "approved_instruction",
    currency: "INR",
    codCollectedMinor: 100000n,
    freightDeductionMinor: 18000n,
    rtoDeductionMinor: 5000n,
    adjustmentMinor: 3000n,
    sellerNetReceivableMinor: 80000n,
    negativeNetMinor: 0n,
    reviewRequiredCount: 0,
    metadata: { instructionOnly: true, movementExecuted: false },
    createdBy: "usr_w2b_admin",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function cleanItem(overrides: Partial<CodNettingItemRecord> = {}): CodNettingItemRecord {
  return {
    id: "cni_w2b_clean_0001",
    batchId: "cnb_w2b_clean_0001",
    sellerOrgId: "org_w2b_seller_a",
    courierCode: "BIGSHIP_SYNTHETIC",
    period: "2026-07",
    shipmentId: "shp_w2b_internal_0001",
    deliveredAt: now,
    codCollectedMinor: 100000n,
    freightDeductionMinor: 18000n,
    rtoDeductionMinor: 5000n,
    adjustmentMinor: 3000n,
    expectedRemittanceMinor: 80000n,
    remittanceRef: "rem_w2b_internal_0001",
    sellerNetReceivableMinor: 80000n,
    instructionType: "seller_receivable_instruction",
    status: "approved_instruction",
    reviewReasons: [],
    sourceRowHash: "row_hash_w2b_clean",
    metadata: { instructionOnly: true },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function cleanEvent(overrides: Partial<CodNettingEventRecord> = {}): CodNettingEventRecord {
  return {
    id: "cne_w2b_clean_0001",
    batchId: "cnb_w2b_clean_0001",
    itemId: null,
    eventType: "w2a.cod_netting_batch.created",
    status: "approved_instruction",
    message: "Instruction batch recorded for review only.",
    metadata: { instructionOnly: true, movementExecuted: false },
    createdBy: "usr_w2b_admin",
    createdAt: now,
    ...overrides
  };
}

function cleanRecord(overrides: {
  batch?: Partial<CodNettingBatchRecord>;
  item?: Partial<CodNettingItemRecord>;
  event?: Partial<CodNettingEventRecord>;
} = {}): CodNettingStoredBatch {
  const batch = cleanBatch(overrides.batch);
  return {
    batch,
    items: [cleanItem({ batchId: batch.id, sellerOrgId: batch.sellerOrgId, ...overrides.item })],
    events: [cleanEvent({ batchId: batch.id, ...overrides.event })]
  };
}

class MemoryW2BReadStore implements W2BCodNettingReadStore {
  constructor(readonly records: CodNettingStoredBatch[] = [cleanRecord()]) {}

  async listBatches(filters: Parameters<W2BCodNettingReadStore["listBatches"]>[0]) {
    const filtered = this.records
      .map((record) => record.batch)
      .filter((batch) => !filters.sellerOrgId || batch.sellerOrgId === filters.sellerOrgId)
      .filter((batch) => !filters.courierCode || batch.courierCode === filters.courierCode)
      .filter((batch) => !filters.period || batch.period === filters.period)
      .filter((batch) => !filters.status || batch.status === filters.status)
      .slice(0, filters.limit);
    return {
      batches: cloneState(filtered),
      nextCursor: null
    };
  }

  async findBatchById(batchId: string) {
    return cloneState(this.records.find((record) => record.batch.id === batchId) ?? null);
  }
}

function makeService(records = [cleanRecord()]) {
  return new W2BCodNettingReadService(new MemoryW2BReadStore(records));
}

describe("W2B COD netting read surfaces", () => {
  it("mounts only protected internal, admin, and seller read routers", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/internal\/wallet\/w2\/cod", requireInternalSecret, internalW2CodNettingRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/wallets\/w2\/cod", requireAdminJwt, adminW2CodNettingRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/seller\/wallet\/w2\/cod", requireJwtAuth, sellerW2CodNettingRouter\);/);
    assert.ok(routes.indexOf("apiRouter.use(\"/admin/wallets/w2/cod\"") < routes.indexOf("apiRouter.use(\"/admin/wallets\""));
  });

  it("adds no mutating W2B COD routes or public seller mutation surface", () => {
    const routeSource = readFileSync("src/modules/wallet/w2-cod-netting-read.routes.ts", "utf8");
    const allRoutes = readFileSync("src/routes/index.ts", "utf8");

    assert.equal(/\.(post|put|patch|delete)\(/u.test(routeSource), false);
    assert.doesNotMatch(allRoutes, /apiRouter\.use\("\/wallet\/w2/u);
  });

  it("derives seller scope from auth and rejects cross-seller query attempts", () => {
    assert.equal(sellerOrgIdFromW2CodAuth({ userId: "usr_1", merchantId: "org_w2b_seller_a", role: "SELLER" }), "org_w2b_seller_a");
    assert.throws(() => sellerOrgIdFromW2CodAuth(undefined), /Required|invalid_type/i);
    assert.doesNotThrow(() => assertW2CodSellerQueryScope("org_w2b_seller_a", "org_w2b_seller_a"));
    assert.throws(
      () => assertW2CodSellerQueryScope("org_w2b_seller_b", "org_w2b_seller_a"),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "W2B_SELLER_SCOPE_ONLY"
    );
  });

  it("lets admin list COD instruction batches with string money and no spendable COD balance", async () => {
    const page = await makeService().listBatches({ sellerOrgId: "org_w2b_seller_a", limit: 25 });
    const batch = page.batches[0]!;
    const output = JSON.stringify(page);

    assert.equal(batch.status, "approved_instruction");
    assert.equal(batch.totals.sellerNetReceivableMinor, "80000");
    assert.equal(typeof batch.totals.codCollectedMinor, "string");
    assert.equal(batch.movementExecuted, false);
    assert.equal(batch.custodyCreated, false);
    assert.equal(batch.payoutExecuted, false);
    assert.equal(batch.settlementExecuted, false);
    assert.equal(output.includes(["shipping", "balance"].join("_")), false);
    assert.equal(output.includes("spendableBalanceCreated\":true"), false);
  });

  it("lets admin read batch detail with items and instruction events only", async () => {
    const detail = await makeService().getBatchDetail("cnb_w2b_clean_0001");
    const output = JSON.stringify(detail);

    assert.equal(detail.batch.id, "cnb_w2b_clean_0001");
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0]!.sellerNetReceivableMinor, "80000");
    assert.equal(detail.events.length, 1);
    assert.equal(detail.policy.mode, "instruction_only");
    assert.equal(detail.policy.movementExecuted, false);
    assert.equal(/\bpaid\b|\bsettled\b|\bdisbursed\b|\btransferred\b|\bremitted\b/iu.test(output), false);
  });

  it("keeps export-preview read-only and does not create instruction events or status changes", async () => {
    const record = cleanRecord();
    const service = makeService([record]);
    const beforeStatus = record.batch.status;
    const beforeEvents = record.events.length;
    const preview = await service.exportPreview(record.batch.id, "json");
    if (!("batch" in preview)) throw new Error("expected json preview");

    assert.equal(preview.batch.status, beforeStatus);
    assert.equal(record.batch.status, beforeStatus);
    assert.equal(record.events.length, beforeEvents);
    assert.equal(preview.exportPreview.movementExecuted, false);
    assert.equal(preview.exportPreview.payoutExecuted, false);
    assert.equal(preview.exportPreview.settlementExecuted, false);
  });

  it("returns CSV export-preview text with instruction disclaimer and no execution mutation", async () => {
    const record = cleanRecord();
    const preview = await makeService([record]).exportPreview(record.batch.id, "csv");
    if (!("csv" in preview)) throw new Error("expected csv preview");

    assert.equal(preview.policy.movementExecuted, false);
    assert.match(preview.csv, /^# Instruction preview only\. No money movement has been executed by Shipmastr\./u);
    assert.match(preview.csv, /movementExecuted,false/u);
    assert.match(preview.csv, /seller_receivable_instruction/u);
    assert.equal(record.batch.status, "approved_instruction");
    assert.equal(record.events.length, 1);
  });

  it("omits public refs from output", async () => {
    const refTerm = ["ord", "er_"].join("");
    const unsafeRecord = cleanRecord({
      batch: {
        sourceRef: `${refTerm}public_9999999999`
      },
      item: {
        shipmentId: `${refTerm}public_9999999999`,
        remittanceRef: null,
        sourceRowHash: "row_hash_safe_only"
      }
    });
    const detail = await makeService([unsafeRecord]).getBatchDetail(unsafeRecord.batch.id);
    const output = JSON.stringify(detail);
    const blockedPattern = new RegExp([
      ["A", "WB"].join(""),
      ["a", "wb_"].join(""),
      ["ord", "er_"].join(""),
      "@",
      "9876543210",
      "110001",
      ["consig", "nee"].join(""),
      ["buy", "er"].join("")
    ].join("|"), "i");

    assert.equal(blockedPattern.test(output), false);
    assert.equal("remittanceRef" in detail.items[0]!, false);
    assert.equal(detail.batch.sourceRef, null);
    assert.equal(detail.items[0]!.shipmentInternalId, null);
  });

  it("keeps seller reads seller-scoped and summary read-only", async () => {
    const records = [
      cleanRecord(),
      cleanRecord({
        batch: { id: "cnb_w2b_other_0001", sellerOrgId: "org_w2b_seller_b", sourceRef: "w2b_source_other" },
        item: { sellerOrgId: "org_w2b_seller_b", batchId: "cnb_w2b_other_0001" }
      })
    ];
    const service = makeService(records);
    const summary = await service.sellerSummary("org_w2b_seller_a");
    const page = await service.listBatches({ sellerOrgId: "org_w2b_seller_a", limit: 50 });

    assert.equal(summary.sellerOrgId, "org_w2b_seller_a");
    assert.equal(summary.recentBatches.length, 1);
    assert.equal(page.batches.length, 1);
    assert.equal(page.batches[0]!.sellerOrgId, "org_w2b_seller_a");
    assert.equal(summary.policy.payoutExecuted, false);
  });

  it("keeps W2B source free of direct ledger writes, floats, live calls, and custody account usage", () => {
    const source = [
      readFileSync("src/modules/wallet/w2-cod-netting-read.service.ts", "utf8"),
      readFileSync("src/modules/wallet/w2-cod-netting-read.routes.ts", "utf8")
    ].join("\n");
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"));
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

    assert.equal(directWritePattern.test(source), false);
    assert.equal(floatPattern.test(source), false);
    assert.equal(livePattern.test(source), false);
    assert.equal(custodyAccountPattern.test(source), false);
  });
});
