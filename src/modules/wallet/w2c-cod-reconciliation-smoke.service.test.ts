import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  W2BCodNettingReadService,
  type W2BCodNettingReadStore
} from "./w2-cod-netting-read.service.js";
import {
  CodInstructionNettingService,
  CodNettingBatchService,
  type CodNettingEventRecord,
  type CodNettingInstructionStatus,
  type CodNettingItemRecord,
  type CodNettingStore,
  type CodNettingStoredBatch
} from "./w2a-cod-netting.service.js";
import { W2CCodReconciliationSmokeService } from "./w2c-cod-reconciliation-smoke.service.js";

const now = new Date("2026-07-05T14:00:00.000Z");

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
    const batchId = `cnb_w2c_${this.batches.length + 1}`;
    const record: CodNettingStoredBatch = {
      batch: {
        id: batchId,
        ...input.batch,
        createdAt: now,
        updatedAt: now
      },
      items: input.items.map((item, index) => ({
        id: `cni_w2c_${this.batches.length + 1}_${index + 1}`,
        batchId,
        ...item,
        createdAt: now,
        updatedAt: now
      })) as CodNettingItemRecord[],
      events: [{
        id: `cne_w2c_${this.batches.length + 1}_1`,
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
      id: `cne_w2c_${record.events.length + 1}`,
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

class MemoryW2BReadStore implements W2BCodNettingReadStore {
  constructor(private readonly source: MemoryCodNettingStore) {}

  async listBatches(filters: Parameters<W2BCodNettingReadStore["listBatches"]>[0]) {
    const batches = this.source.batches
      .map((record) => record.batch)
      .filter((batch) => !filters.sellerOrgId || batch.sellerOrgId === filters.sellerOrgId)
      .filter((batch) => !filters.courierCode || batch.courierCode === filters.courierCode)
      .filter((batch) => !filters.period || batch.period === filters.period)
      .filter((batch) => !filters.status || batch.status === filters.status)
      .slice(0, filters.limit);
    return {
      batches: cloneState(batches),
      nextCursor: null
    };
  }

  async findBatchById(batchId: string) {
    return this.source.findBatchById(batchId);
  }
}

function makeService(config = { appEnv: "test", nodeEnv: "test" }) {
  const store = new MemoryCodNettingStore();
  const nettingService = new CodInstructionNettingService({ store, config });
  return {
    store,
    service: new W2CCodReconciliationSmokeService({
      nettingService,
      batchService: new CodNettingBatchService(store),
      readService: new W2BCodNettingReadService(new MemoryW2BReadStore(store)),
      config
    })
  };
}

function asText(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}

function executeCleanBatch(report: Awaited<ReturnType<W2CCodReconciliationSmokeService["run"]>>) {
  assert.equal(report.execute, true);
  return report.cleanBatch as {
    id: string;
    status: string;
    itemCount: number;
    totals: { sellerNetReceivableMinor: string };
    exportPreviewOnly: boolean;
    statusBeforeExportPreview: string;
    statusAfterExportPreview: string;
    eventCountBeforeExportPreview: number;
    eventCountAfterExportPreview: number;
    movementExecuted: boolean;
    payoutExecuted: boolean;
    settlementExecuted: boolean;
  };
}

function moneyValues(value: unknown) {
  return [...asText(value).matchAll(/"[^"]*Minor":"([^"]+)"/gu)].map((match) => match[1]);
}

function forbiddenPublicRefPattern() {
  return new RegExp([
    ["a", "wb"].join(""),
    ["ord", "er_"].join(""),
    ["pho", "ne"].join(""),
    ["em", "ail"].join(""),
    ["addr", "ess"].join(""),
    ["pin", "code"].join(""),
    ["consig", "nee"].join(""),
    ["buy", "er"].join("")
  ].join("|"), "i");
}

describe("W2C COD reconciliation smoke", () => {
  it("keeps dry-run as the default and performs no writes", async () => {
    const { service, store } = makeService();
    const report = await service.run();

    assert.equal(report.dryRun, true);
    assert.equal(report.execute, false);
    assert.deepEqual(report.writes, { batches: 0, items: 0, events: 0 });
    assert.equal(store.batches.length, 0);
  });

  it("refuses execute in production, staging, and live runtime modes", async () => {
    for (const config of [
      { appEnv: "production", nodeEnv: "production" },
      { appEnv: "staging", nodeEnv: "test" },
      { appEnv: "live", nodeEnv: "test" }
    ]) {
      const { service } = makeService(config);
      await assert.rejects(
        () => service.run({ execute: true }),
        (error) => error instanceof HttpError && error.message === "W2C_LOCAL_TEST_EXECUTE_REQUIRED"
      );
    }
  });

  it("executes local/test instruction-only flow with review and clean batches", async () => {
    const { service, store } = makeService();
    const report = await service.run({ execute: true });
    const cleanBatch = executeCleanBatch(report);

    assert.equal(report.dryRun, false);
    assert.equal(report.execute, true);
    assert.equal(store.batches.length, 2);
    assert.equal(report.reviewBatch.status, "review_required");
    assert.equal(report.reviewBatch.approvalBlocked, true);
    assert.ok(report.reviewBatch.reviewRequiredCount >= 3);
    assert.equal(cleanBatch.status, "approved_instruction");
    assert.equal(cleanBatch.totals.sellerNetReceivableMinor, "80000");
  });

  it("uses W2B export-preview as read-only and creates no extra event", async () => {
    const { service } = makeService();
    const report = await service.run({ execute: true });
    const cleanBatch = executeCleanBatch(report);

    assert.equal(cleanBatch.exportPreviewOnly, true);
    assert.equal(cleanBatch.statusBeforeExportPreview, "approved_instruction");
    assert.equal(cleanBatch.statusAfterExportPreview, "approved_instruction");
    assert.equal(cleanBatch.eventCountBeforeExportPreview, cleanBatch.eventCountAfterExportPreview);
    assert.equal(report.checks.exportPreviewReadOnly, true);
  });

  it("keeps all execution policy flags false", async () => {
    const { service } = makeService();
    const report = await service.run({ execute: true });
    const cleanBatch = executeCleanBatch(report);

    assert.equal(cleanBatch.movementExecuted, false);
    assert.equal(cleanBatch.payoutExecuted, false);
    assert.equal(cleanBatch.settlementExecuted, false);
    assert.equal(report.checks.movementExecuted, false);
    assert.equal(report.checks.payoutExecuted, false);
    assert.equal(report.checks.settlementExecuted, false);
    assert.equal(report.checks.custodyCreated, false);
    assert.equal(report.checks.w1CodCreditCreated, false);
  });

  it("keeps money values string minor units and clean net deterministic", async () => {
    const { service } = makeService();
    const report = await service.run({ execute: true });
    const cleanBatch = executeCleanBatch(report);

    assert.equal(report.checks.cleanNetVerified, true);
    assert.equal(cleanBatch.totals.sellerNetReceivableMinor, "80000");
    assert.ok(moneyValues(report).length > 0);
    assert.ok(moneyValues(report).every((value) => typeof value === "string" && /^[0-9]+$/u.test(value)));
  });

  it("does not create completed money-movement events or language", async () => {
    const { service, store } = makeService();
    const report = await service.run({ execute: true });
    const eventText = asText(store.batches.flatMap((record) => record.events));

    assert.equal(/\b(paid|settled|transferred|disbursed|remitted)\b/iu.test(eventText), false);
    assert.equal(report.checks.completedMovementLanguagePresent, false);
  });

  it("does not expose unsafe operational references in output or stored refs", async () => {
    const { service, store } = makeService();
    const report = await service.run({ execute: true });
    const text = `${asText(report)} ${asText(store.batches)}`;

    assert.equal(forbiddenPublicRefPattern().test(text), false);
    assert.equal(report.checks.publicOperationalRefsPresent, false);
  });

  it("is idempotent for repeated deterministic source refs", async () => {
    const { service, store } = makeService();
    const first = await service.run({ execute: true });
    const second = await service.run({ execute: true });
    const firstCleanBatch = executeCleanBatch(first);
    const secondCleanBatch = executeCleanBatch(second);

    assert.equal(store.batches.length, 2);
    assert.equal(firstCleanBatch.id, secondCleanBatch.id);
    assert.equal(secondCleanBatch.eventCountAfterExportPreview, firstCleanBatch.eventCountAfterExportPreview);
  });

  it("does not add public mutating seller APIs", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.doesNotMatch(routes, /apiRouter\.use\("\/seller\/wallet\/w2c/u);
    assert.doesNotMatch(routes, /apiRouter\.use\("\/wallet\/w2c/u);
  });

  it("does not directly write ledger tables from W2C", () => {
    const serviceSource = readFileSync("src/modules/wallet/w2c-cod-reconciliation-smoke.service.ts", "utf8");
    const scriptSource = readFileSync("scripts/wallet-w2c-cod-reconciliation-smoke.mjs", "utf8");
    const pattern = new RegExp([
      "journalEntry\\.create",
      "journalPosting\\.create",
      "accountBalance\\.update",
      "walletEventOutbox\\.create"
    ].join("|"), "u");

    assert.equal(pattern.test(`${serviceSource}\n${scriptSource}`), false);
  });

  it("does not use float conversion or live external calls in W2C", () => {
    const serviceSource = readFileSync("src/modules/wallet/w2c-cod-reconciliation-smoke.service.ts", "utf8");
    const scriptSource = readFileSync("scripts/wallet-w2c-cod-reconciliation-smoke.mjs", "utf8");
    const moneyPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "\\.round"].join(""),
      ["Num", "ber\\("].join("")
    ].join("|"), "u");
    const livePattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank ", "payout"].join(""),
      ["settlement ", "api"].join(""),
      ["n", "8n"].join(""),
      ["cloud ", "run"].join(""),
      ["u", "pi"].join(""),
      ["im", "ps"].join(""),
      ["ne", "ft"].join("")
    ].join("|"), "iu");

    assert.equal(moneyPattern.test(`${serviceSource}\n${scriptSource}`), false);
    assert.equal(livePattern.test(`${serviceSource}\n${scriptSource}`), false);
  });
});
