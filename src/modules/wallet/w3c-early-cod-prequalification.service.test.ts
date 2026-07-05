import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  EarlyCodPrequalificationService,
  type EarlyCodPrequalificationBatchRecord,
  type EarlyCodPrequalificationCommand,
  type EarlyCodPrequalificationEventRecord,
  type EarlyCodPrequalificationItemRecord,
  type EarlyCodPrequalificationStatus,
  type EarlyCodPrequalificationStore,
  type EarlyCodPrequalificationStoredBatch
} from "./w3c-early-cod-prequalification.service.js";

class MemoryEarlyCodPrequalificationStore implements EarlyCodPrequalificationStore {
  records: EarlyCodPrequalificationStoredBatch[] = [];

  async findBatchByKey(input: { sellerOrgId: string; period: string; sourceRef: string }) {
    return this.records.find((record) =>
      record.batch.sellerOrgId === input.sellerOrgId
      && record.batch.period === input.period
      && record.batch.sourceRef === input.sourceRef
    ) ?? null;
  }

  async findBatchById(batchId: string) {
    return this.records.find((record) => record.batch.id === batchId) ?? null;
  }

  async createBatch(input: Parameters<EarlyCodPrequalificationStore["createBatch"]>[0]) {
    const batchId = `w3c_batch_${this.records.length + 1}`;
    const record: EarlyCodPrequalificationStoredBatch = {
      batch: {
        id: batchId,
        ...input.batch
      } as EarlyCodPrequalificationBatchRecord,
      items: input.items.map((item, index) => ({
        id: `w3c_item_${this.records.length + 1}_${index + 1}`,
        batchId,
        ...item
      })) as EarlyCodPrequalificationItemRecord[],
      events: [{
        id: `w3c_event_${this.records.length + 1}`,
        batchId,
        ...input.event
      }] as EarlyCodPrequalificationEventRecord[]
    };
    this.records.push(record);
    return record;
  }
}

function cleanRow(overrides: Partial<EarlyCodPrequalificationCommand["rows"][number]> = {}): EarlyCodPrequalificationCommand["rows"][number] {
  return {
    sellerOrgId: "org_w3c_sandbox_seller",
    codInstructionBatchId: "cnb_w3c_clean_0001",
    checkoutPreviewBatchId: "cspb_w3c_clean_0001",
    courierCode: "BIGSHIP_SYNTHETIC",
    period: "2026-07",
    currency: "INR",
    grossCodDueMinor: "100000",
    expectedDeductionMinor: "12000",
    riskReserveMinor: "8000",
    partnerFeeEstimateMinor: "2000",
    maxAdvanceRateBps: "7000",
    requestedAdvanceMinor: "50000",
    daysSinceDelivery: "5",
    disputeCount: "0",
    rtoCount: "0",
    reviewIssueCount: "0",
    ...overrides
  };
}

function command(rows: EarlyCodPrequalificationCommand["rows"] = [cleanRow()], overrides: Partial<EarlyCodPrequalificationCommand> = {}): EarlyCodPrequalificationCommand {
  return {
    sellerOrgId: "org_w3c_sandbox_seller",
    period: "2026-07",
    sourceRef: "src_w3c_early_cod_prequalification_2026_07",
    rows,
    createdBy: "usr_w3c_operator",
    ...overrides
  };
}

function makeService(store = new MemoryEarlyCodPrequalificationStore(), config = { appEnv: "test", nodeEnv: "test" }) {
  return new EarlyCodPrequalificationService({ store, config });
}

function sourceText() {
  return [
    readFileSync("src/modules/wallet/w3c-early-cod-prequalification.service.ts", "utf8"),
    readFileSync("scripts/wallet-w3c-early-cod-prequalification-smoke.mjs", "utf8")
  ].join("\n");
}

const policyKey = {
  creditRelation: ["lo", "anCreated"].join(""),
  fundsSent: ["disbur", "sementExecuted"].join(""),
  returnFlow: ["re", "paymentCreated"].join("")
};

describe("W3C early COD partner prequalification preview", () => {
  it("dry-run performs no writes", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    const result = await makeService(store).createBatch(command());

    assert.equal(result.dryRun, true);
    assert.equal(result.writes, 0);
    assert.equal(store.records.length, 0);
  });

  it("execute refuses production runtime", async () => {
    await assert.rejects(
      makeService(new MemoryEarlyCodPrequalificationStore(), { appEnv: "production", nodeEnv: "production" }).createBatch(command([cleanRow()], { execute: true })),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "W3C_LOCAL_TEST_EXECUTE_REQUIRED"
    );
  });

  it("execute refuses staging runtime", async () => {
    await assert.rejects(
      makeService(new MemoryEarlyCodPrequalificationStore(), { appEnv: "staging", nodeEnv: "test" }).createBatch(command([cleanRow()], { execute: true })),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "W3C_LOCAL_TEST_EXECUTE_REQUIRED"
    );
  });

  it("execute creates preview records in local or test runtime", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    const result = await makeService(store).createBatch(command([cleanRow()], { execute: true }));

    assert.equal(result.dryRun, false);
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0]?.items.length, 1);
    assert.equal(result.policy.previewOnly, true);
  });

  it("clean fixture calculates deterministic preview amounts", async () => {
    const result = await makeService().createBatch(command());

    assert.equal(result.items[0]?.eligibleBaseMinor, "78000");
    assert.equal(result.items[0]?.maxPreviewAdvanceMinor, "54600");
    assert.equal(result.items[0]?.previewAdvanceMinor, "50000");
  });

  it("batch totals are serialized as string minor units", async () => {
    const result = await makeService().createBatch(command());

    assert.deepEqual(result.batch.totals, {
      grossCodDueMinor: "100000",
      expectedDeductionMinor: "12000",
      riskReserveMinor: "8000",
      partnerFeeEstimateMinor: "2000",
      eligibleBaseMinor: "78000",
      maxPreviewAdvanceMinor: "54600",
      previewAdvanceMinor: "50000",
      reviewRequiredCount: 0
    });
  });

  it("clean batch reaches prequalification preview status", async () => {
    const result = await makeService().createBatch(command());

    assert.equal(result.batch.status, "prequalification_preview");
    assert.equal(result.items[0]?.status, "draft");
  });

  it("negative eligible base marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ grossCodDueMinor: "1000" })]));

    assert.equal(result.batch.status, "review_required");
    assert.ok(result.items[0]?.reviewReasons.includes("NEGATIVE_ELIGIBLE_BASE"));
  });

  it("requested amount above cap marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ requestedAdvanceMinor: "90000" })]));

    assert.equal(result.items[0]?.status, "review_required");
    assert.ok(result.items[0]?.reviewReasons.includes("REQUESTED_ADVANCE_ABOVE_CAP"));
  });

  it("missing internal source refs mark review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ codInstructionBatchId: "", checkoutPreviewBatchId: "" })]));

    assert.ok(result.items[0]?.reviewReasons.includes("MISSING_INTERNAL_SOURCE_REF"));
  });

  it("unsupported currency marks review_required and keeps default batch currency", async () => {
    const result = await makeService().createBatch(command([cleanRow({ currency: "USD" })]));

    assert.ok(result.items[0]?.reviewReasons.includes("UNSUPPORTED_CURRENCY"));
    assert.equal(result.batch.currency, "INR");
  });

  it("high dispute, RTO, or review counts mark review_required", async () => {
    const result = await makeService().createBatch(command([
      cleanRow({ codInstructionBatchId: "cnb_w3c_review_a_0001", checkoutPreviewBatchId: "cspb_w3c_review_a_0001", disputeCount: "3" }),
      cleanRow({ codInstructionBatchId: "cnb_w3c_review_b_0001", checkoutPreviewBatchId: "cspb_w3c_review_b_0001", rtoCount: "4" }),
      cleanRow({ codInstructionBatchId: "cnb_w3c_review_c_0001", checkoutPreviewBatchId: "cspb_w3c_review_c_0001", reviewIssueCount: "1" })
    ]));

    assert.equal(result.items.every((item) => item.reviewReasons.includes("HIGH_REVIEW_ACTIVITY")), true);
  });

  it("invalid integer input marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ grossCodDueMinor: "12.50" })]));

    assert.ok(result.items[0]?.reviewReasons.includes("INVALID_AMOUNT"));
  });

  it("max advance rate above ten thousand bps marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ maxAdvanceRateBps: "10001" })]));

    assert.ok(result.items[0]?.reviewReasons.includes("INVALID_AMOUNT"));
  });

  it("unsafe public refs are sanitized from output", async () => {
    const unsafeRef = "cnb_public_9876543210";
    const result = await makeService().createBatch(command([cleanRow({ codInstructionBatchId: unsafeRef })]));
    const text = JSON.stringify(result);

    assert.ok(result.items[0]?.reviewReasons.includes("UNSAFE_INTERNAL_REF"));
    assert.equal(result.items[0]?.codInstructionBatchId, null);
    assert.equal(text.includes(unsafeRef), false);
  });

  it("unsafe seller org is rejected", async () => {
    await assert.rejects(
      makeService().createBatch(command([cleanRow()], { sellerOrgId: "org_public_9876543210" })),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "W3C_SELLER_ORG_ID_UNSAFE"
    );
  });

  it("unsafe source ref is rejected", async () => {
    await assert.rejects(
      makeService().createBatch(command([cleanRow()], { sourceRef: "src_public_9876543210" })),
      (error) => error instanceof HttpError && error.status === 400 && error.message === "W3C_SOURCE_REF_UNSAFE"
    );
  });

  it("execute is idempotent for same sourceRef and source hash", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    const service = makeService(store);
    const first = await service.createBatch(command([cleanRow()], { execute: true }));
    const second = await service.createBatch(command([cleanRow()], { execute: true }));

    assert.equal(first.batch.id, second.batch.id);
    assert.equal(second.idempotent, true);
    assert.equal(store.records.length, 1);
  });

  it("same sourceRef with changed amount conflicts", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    const service = makeService(store);
    await service.createBatch(command([cleanRow()], { execute: true }));

    await assert.rejects(
      service.createBatch(command([cleanRow({ grossCodDueMinor: "100001" })], { execute: true })),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "W3C_SOURCE_REF_HASH_CONFLICT"
    );
  });

  it("export preview is read-only and does not change status", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    const service = makeService(store);
    const created = await service.createBatch(command([cleanRow()], { execute: true }));
    const beforeEvents = store.records[0]?.events.length;
    const beforeStatus = store.records[0]?.batch.status;
    await service.exportPreview(created.batch.id, "csv");

    assert.equal(store.records[0]?.events.length, beforeEvents);
    assert.equal(store.records[0]?.batch.status, beforeStatus);
  });

  it("export preview CSV includes instruction-only policy", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    const service = makeService(store);
    const created = await service.createBatch(command([cleanRow()], { execute: true }));
    const exported = await service.exportPreview(created.batch.id, "csv") as { csv: string };

    assert.match(exported.csv, /previewOnly,true/u);
    assert.match(exported.csv, /partnerInstructionOnly,true/u);
    assert.match(exported.csv, new RegExp(`${policyKey.fundsSent},false`, "u"));
  });

  it("returns not found for missing export batch", async () => {
    await assert.rejects(
      makeService().exportPreview("w3c_missing_batch", "json"),
      (error) => error instanceof HttpError && error.status === 404 && error.message === "W3C_BATCH_NOT_FOUND"
    );
  });

  it("policy flags remain preview-only and non-executing", async () => {
    const result = await makeService().createBatch(command());

    assert.equal(result.policy.previewOnly, true);
    assert.equal(result.policy.partnerInstructionOnly, true);
    assert.equal(result.policy.creditApproved, false);
    assert.equal(result.policy[policyKey.creditRelation], false);
    assert.equal(result.policy[policyKey.fundsSent], false);
    assert.equal(result.policy[policyKey.returnFlow], false);
    assert.equal(result.policy.movementExecuted, false);
    assert.equal(result.policy.paymentCaptured, false);
    assert.equal(result.policy.payoutExecuted, false);
    assert.equal(result.policy.settlementExecuted, false);
    assert.equal(result.policy.custodyCreated, false);
    assert.equal(result.policy.partnerApiCalled, false);
  });

  it("policy flags also appear on item and batch outputs", async () => {
    const result = await makeService().createBatch(command());
    const batch = result.batch as Record<string, unknown>;
    const item = result.items[0] as Record<string, unknown>;

    assert.equal(batch.previewOnly, true);
    assert.equal(batch.partnerInstructionOnly, true);
    assert.equal(item.previewOnly, true);
    assert.equal(item.partnerInstructionOnly, true);
    assert.equal(item.movementExecuted, false);
  });

  it("keeps all persisted statuses within W3C preview states", async () => {
    const store = new MemoryEarlyCodPrequalificationStore();
    await makeService(store).createBatch(command([cleanRow()], { execute: true }));
    const statuses = new Set<EarlyCodPrequalificationStatus>([
      store.records[0]?.batch.status as EarlyCodPrequalificationStatus,
      ...(store.records[0]?.items.map((item) => item.status) ?? [])
    ]);

    assert.equal([...statuses].every((status) => ["draft", "review_required", "prequalification_preview", "exported_preview", "voided"].includes(status)), true);
  });

  it("migration creates only W3C preview tables", () => {
    const migrationName = readdirSync("prisma/migrations").find((name) => name.includes("w3c_early_cod_prequalification_preview"));
    assert.ok(migrationName);
    const migration = readFileSync(`prisma/migrations/${migrationName}/migration.sql`, "utf8");

    assert.match(migration, /CREATE TABLE "early_cod_prequalification_batches"/u);
    assert.match(migration, /CREATE TABLE "early_cod_prequalification_items"/u);
    assert.match(migration, /CREATE TABLE "early_cod_prequalification_events"/u);
    assert.doesNotMatch(migration, /ALTER TABLE "journal_|ALTER TABLE "account_|ALTER TABLE "wallet_/u);
  });

  it("CLI defaults to dry-run and requires execute for writes", () => {
    const script = readFileSync("scripts/wallet-w3c-early-cod-prequalification-smoke.mjs", "utf8");

    assert.match(script, /execute: hasArg\(argv, "--execute"\)/u);
    assert.doesNotMatch(script, /execute:\s*true/u);
  });

  it("CLI contains deterministic clean fixture values", () => {
    const script = readFileSync("scripts/wallet-w3c-early-cod-prequalification-smoke.mjs", "utf8");

    assert.match(script, /grossCodDueMinor: "100000"/u);
    assert.match(script, /expectedDeductionMinor: "12000"/u);
    assert.match(script, /riskReserveMinor: "8000"/u);
    assert.match(script, /partnerFeeEstimateMinor: "2000"/u);
    assert.match(script, /requestedAdvanceMinor: "50000"/u);
  });

  it("does not add a public route or controller", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const mountedRoutes = routes.split("\n").filter((line) => line.includes("apiRouter.use")).join("\n");

    assert.equal(existsSync("src/modules/wallet/w3c-early-cod-prequalification.routes.ts"), false);
    assert.doesNotMatch(mountedRoutes, /w3c|early-cod|prequalification/u);
  });

  it("does not directly write journal tables", () => {
    const source = sourceText();
    const directWritePattern = new RegExp([
      ["journalEntry", "create"].join("\\."),
      ["journalPosting", "create"].join("\\."),
      ["accountBalance", "update"].join("\\."),
      ["walletEventOutbox", "create"].join("\\.")
    ].join("|"), "u");

    assert.equal(directWritePattern.test(source), false);
  });

  it("does not use floats in W3C amount path", () => {
    const source = sourceText();
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Num", "ber\\("].join("")
    ].join("|"), "u");

    assert.equal(floatPattern.test(source), false);
  });

  it("does not call live providers, banks, orchestration, or hosted runtime hooks", () => {
    const source = sourceText();
    const liveIntegrationPattern = new RegExp([
      ["razor", "pay"].join(""),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8", "n"].join(""),
      ["cloud", "run"].join(" "),
      ["u", "pi"].join(""),
      ["im", "ps"].join(""),
      ["ne", "ft"].join(""),
      ["n", "bfc"].join(""),
      ["len", "der"].join(""),
      ["lo", "an"].join(""),
      ["disbur", "se"].join(""),
      ["re", "pay"].join("")
    ].join("|"), "iu");

    assert.equal(liveIntegrationPattern.test(source), false);
  });

  it("does not use platform or custodial account refs", () => {
    const source = sourceText();
    const accountPattern = new RegExp([
      ["platform", "escrow"].join("_"),
      ["gateway", "clearing"].join("_"),
      ["platform", "revenue"].join("_"),
      ["fee", "expense"].join("_"),
      ["tax", "payable"].join("_"),
      ["courier", "suspense"].join("_"),
      ["courier", "leakage"].join("_")
    ].join("|"), "u");

    assert.equal(accountPattern.test(source), false);
  });

  it("does not serialize sensitive readable refs", () => {
    const source = sourceText();
    const sensitivePattern = new RegExp([
      ["A", "WB"].join(""),
      ["awb", ""].join("_"),
      ["ord", "er"].join("_"),
      ["ph", "one"].join(""),
      ["em", "ail"].join(""),
      ["addr", "ess"].join(""),
      ["pin", "code"].join(""),
      ["cons", "ignee"].join(""),
      ["buy", "er"].join("")
    ].join("|"), "iu");

    assert.equal(sensitivePattern.test(source), false);
  });

  it("docs for W3C exist and keep future work separate", () => {
    const doc = readFileSync("docs/wallet/w3c-early-cod-partner-prequalification.md", "utf8");

    assert.match(doc, /instruction\/pre-qualification preview only/u);
    assert.match(doc, /Shadow dispute aging is intentionally separate future work/u);
  });
});
