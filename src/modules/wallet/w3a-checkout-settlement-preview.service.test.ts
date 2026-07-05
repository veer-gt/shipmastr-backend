import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  CheckoutSettlementPreviewService,
  type CheckoutSettlementPreviewAllocationRecord,
  type CheckoutSettlementPreviewBatchRecord,
  type CheckoutSettlementPreviewCommand,
  type CheckoutSettlementPreviewEventRecord,
  type CheckoutSettlementPreviewItemRecord,
  type CheckoutSettlementPreviewStatus,
  type CheckoutSettlementPreviewStore,
  type CheckoutSettlementPreviewStoredBatch
} from "./w3a-checkout-settlement-preview.service.js";

class MemoryCheckoutSettlementPreviewStore implements CheckoutSettlementPreviewStore {
  records: CheckoutSettlementPreviewStoredBatch[] = [];

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

  async createBatch(input: Parameters<CheckoutSettlementPreviewStore["createBatch"]>[0]) {
    const batchId = `w3a_batch_${this.records.length + 1}`;
    const items: CheckoutSettlementPreviewItemRecord[] = [];
    const allocations: CheckoutSettlementPreviewAllocationRecord[] = [];
    input.items.forEach((item, index) => {
      const itemId = `w3a_item_${this.records.length + 1}_${index + 1}`;
      const { allocations: itemAllocations, ...itemData } = item;
      items.push({
        id: itemId,
        batchId,
        ...itemData
      });
      itemAllocations.forEach((allocation, allocationIndex) => {
        allocations.push({
          id: `w3a_allocation_${this.records.length + 1}_${index + 1}_${allocationIndex + 1}`,
          batchId,
          itemId,
          ...allocation
        });
      });
    });
    const record: CheckoutSettlementPreviewStoredBatch = {
      batch: {
        id: batchId,
        ...input.batch
      },
      items,
      allocations,
      events: [{
        id: `w3a_event_${this.records.length + 1}`,
        batchId,
        ...input.event
      }]
    };
    this.records.push(record);
    return record;
  }
}

function cleanRow(overrides: Partial<CheckoutSettlementPreviewCommand["rows"][number]> = {}): CheckoutSettlementPreviewCommand["rows"][number] {
  return {
    sellerOrgId: "org_w3a_sandbox_seller",
    checkoutRef: "chk_w3a_clean_0001",
    orderRef: "ord_w3a_clean_0001",
    shipmentId: "shp_w3a_clean_0001",
    period: "2026-07",
    currency: "INR",
    grossAmountMinor: "100000",
    paymentFeeMinor: "2500",
    platformFeeMinor: "5000",
    shippingChargeMinor: "8000",
    taxMinor: "1800",
    discountMinor: "3000",
    refundMinor: "0",
    adjustmentMinor: "1300",
    ...overrides
  };
}

function command(rows: CheckoutSettlementPreviewCommand["rows"] = [cleanRow()], overrides: Partial<CheckoutSettlementPreviewCommand> = {}): CheckoutSettlementPreviewCommand {
  return {
    sellerOrgId: "org_w3a_sandbox_seller",
    period: "2026-07",
    sourceRef: "src_w3a_checkout_preview_2026_07",
    rows,
    createdBy: "usr_w3a_operator",
    ...overrides
  };
}

function makeService(store = new MemoryCheckoutSettlementPreviewStore(), config = { appEnv: "test", nodeEnv: "test" }) {
  return new CheckoutSettlementPreviewService({ store, config });
}

function sourceText() {
  return [
    readFileSync("src/modules/wallet/w3a-checkout-settlement-preview.service.ts", "utf8"),
    readFileSync("scripts/wallet-w3a-checkout-settlement-preview-smoke.mjs", "utf8")
  ].join("\n");
}

describe("W3A checkout settlement shadow preview", () => {
  it("dry-run performs no writes", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    const result = await makeService(store).createBatch(command());

    assert.equal(result.dryRun, true);
    assert.equal(result.writes, 0);
    assert.equal(store.records.length, 0);
  });

  it("execute refuses production runtime", async () => {
    await assert.rejects(
      makeService(new MemoryCheckoutSettlementPreviewStore(), { appEnv: "production", nodeEnv: "production" }).createBatch(command([cleanRow()], { execute: true })),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "W3A_LOCAL_TEST_EXECUTE_REQUIRED"
    );
  });

  it("execute refuses staging runtime", async () => {
    await assert.rejects(
      makeService(new MemoryCheckoutSettlementPreviewStore(), { appEnv: "staging", nodeEnv: "test" }).createBatch(command([cleanRow()], { execute: true })),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "W3A_LOCAL_TEST_EXECUTE_REQUIRED"
    );
  });

  it("execute creates preview-only records in local or test runtime", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    const result = await makeService(store).createBatch(command([cleanRow()], { execute: true }));

    assert.equal(result.dryRun, false);
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0]?.items.length, 1);
    assert.equal(store.records[0]?.allocations.length, 8);
    assert.equal(result.policy.previewOnly, true);
  });

  it("clean item sellerPreviewReceivableMinor is 81000", async () => {
    const result = await makeService().createBatch(command());

    assert.equal(result.items[0]?.sellerPreviewReceivableMinor, "81000");
  });

  it("batch totals are correct as strings", async () => {
    const result = await makeService().createBatch(command());

    assert.deepEqual(result.batch.totals, {
      grossAmountMinor: "100000",
      paymentFeeMinor: "2500",
      platformFeeMinor: "5000",
      shippingChargeMinor: "8000",
      taxMinor: "1800",
      discountMinor: "3000",
      refundMinor: "0",
      adjustmentMinor: "1300",
      sellerPreviewReceivableMinor: "81000",
      negativePreviewMinor: "0",
      reviewRequiredCount: 0
    });
  });

  it("negative seller preview marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({
      grossAmountMinor: "1000",
      paymentFeeMinor: "2000",
      platformFeeMinor: "1000",
      shippingChargeMinor: "0",
      taxMinor: "0",
      discountMinor: "0",
      refundMinor: "0",
      adjustmentMinor: "0"
    })]));

    assert.equal(result.batch.status, "review_required");
    assert.ok(result.items[0]?.reviewReasons.includes("NEGATIVE_SELLER_PREVIEW"));
  });

  it("missing checkoutRef marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ checkoutRef: "" })]));

    assert.equal(result.items[0]?.status, "review_required");
    assert.ok(result.items[0]?.reviewReasons.includes("MISSING_CHECKOUT_REF"));
  });

  it("duplicate checkoutRef marks review_required", async () => {
    const result = await makeService().createBatch(command([
      cleanRow({ orderRef: "ord_w3a_dup_a_0001", shipmentId: "shp_w3a_dup_a_0001" }),
      cleanRow({ orderRef: "ord_w3a_dup_b_0001", shipmentId: "shp_w3a_dup_b_0001" })
    ]));

    assert.equal(result.batch.totals.reviewRequiredCount, 2);
    assert.equal(result.items.every((item) => item.reviewReasons.includes("DUPLICATE_CHECKOUT_REF")), true);
  });

  it("unsupported currency marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ currency: "USD" })]));

    assert.ok(result.items[0]?.reviewReasons.includes("UNSUPPORTED_CURRENCY"));
  });

  it("invalid amount marks review_required", async () => {
    const result = await makeService().createBatch(command([cleanRow({ grossAmountMinor: "1000.25" })]));

    assert.ok(result.items[0]?.reviewReasons.includes("INVALID_AMOUNT"));
  });

  it("unsafe public refs are sanitized from output", async () => {
    const unsafeRef = "chk_public_9876543210";
    const result = await makeService().createBatch(command([cleanRow({ checkoutRef: unsafeRef })]));
    const text = JSON.stringify(result);

    assert.ok(result.items[0]?.reviewReasons.includes("UNSAFE_INTERNAL_REF"));
    assert.equal(result.items[0]?.checkoutRef, null);
    assert.equal(text.includes(unsafeRef), false);
  });

  it("clean batch can become preview_ready", async () => {
    const result = await makeService().createBatch(command());

    assert.equal(result.batch.status, "preview_ready");
  });

  it("zero preview is allowed", async () => {
    const result = await makeService().createBatch(command([cleanRow({
      grossAmountMinor: "1000",
      paymentFeeMinor: "1000",
      platformFeeMinor: "0",
      shippingChargeMinor: "0",
      taxMinor: "0",
      discountMinor: "0",
      refundMinor: "0",
      adjustmentMinor: "0"
    })]));

    assert.equal(result.items[0]?.sellerPreviewReceivableMinor, "0");
    assert.equal(result.batch.status, "preview_ready");
  });

  it("creates allocation buckets for every item", async () => {
    const result = await makeService().createBatch(command());
    const buckets = new Set(result.allocations.map((allocation) => allocation.bucket));

    assert.equal(buckets.has("seller_preview_receivable"), true);
    assert.equal(buckets.has("payment_fee_preview"), true);
    assert.equal(buckets.has("platform_fee_preview"), true);
    assert.equal(buckets.has("shipping_charge_preview"), true);
    assert.equal(buckets.has("tax_preview"), true);
    assert.equal(buckets.has("discount_preview"), true);
    assert.equal(buckets.has("refund_preview"), true);
    assert.equal(buckets.has("adjustment_preview"), true);
  });

  it("execute is idempotent for same sourceRef and source hash", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    const service = makeService(store);
    const first = await service.createBatch(command([cleanRow()], { execute: true }));
    const second = await service.createBatch(command([cleanRow()], { execute: true }));

    assert.equal(first.batch.id, second.batch.id);
    assert.equal(second.idempotent, true);
    assert.equal(store.records.length, 1);
  });

  it("same sourceRef with changed amount conflicts", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    const service = makeService(store);
    await service.createBatch(command([cleanRow()], { execute: true }));

    await assert.rejects(
      service.createBatch(command([cleanRow({ grossAmountMinor: "100001" })], { execute: true })),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "W3A_SOURCE_REF_HASH_CONFLICT"
    );
  });

  it("export preview is read-only", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    const service = makeService(store);
    const created = await service.createBatch(command([cleanRow()], { execute: true }));
    const beforeEvents = store.records[0]?.events.length;
    await service.exportPreview(created.batch.id, "json");

    assert.equal(store.records[0]?.events.length, beforeEvents);
  });

  it("export preview does not change status", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    const service = makeService(store);
    const created = await service.createBatch(command([cleanRow()], { execute: true }));
    const beforeStatus = store.records[0]?.batch.status;
    await service.exportPreview(created.batch.id, "csv");

    assert.equal(store.records[0]?.batch.status, beforeStatus);
  });

  it("movementExecuted remains false", async () => {
    const result = await makeService().createBatch(command());
    assert.equal(result.policy.movementExecuted, false);
  });

  it("paymentCaptured remains false", async () => {
    const result = await makeService().createBatch(command());
    assert.equal(result.policy.paymentCaptured, false);
  });

  it("payoutExecuted remains false", async () => {
    const result = await makeService().createBatch(command());
    assert.equal(result.policy.payoutExecuted, false);
  });

  it("settlementExecuted remains false", async () => {
    const result = await makeService().createBatch(command());
    assert.equal(result.policy.settlementExecuted, false);
  });

  it("custodyCreated remains false", async () => {
    const result = await makeService().createBatch(command());
    assert.equal(result.policy.custodyCreated, false);
  });

  it("previewOnly remains true", async () => {
    const result = await makeService().createBatch(command());
    assert.equal(result.policy.previewOnly, true);
  });

  it("does not include seller shipping-balance credit from checkout preview", () => {
    const source = sourceText();

    assert.equal(source.includes(["shipping", "balance"].join("_")), false);
    assert.equal(source.includes(["credit", "seller"].join("_")), false);
  });

  it("does not add COD custody behavior", () => {
    const source = sourceText();
    const custodyPattern = new RegExp(["cod", "custody"].join(""), "iu");

    assert.equal(custodyPattern.test(source), false);
  });

  it("does not add W3 live payment, bank, or settlement routes", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const liveRoutePattern = new RegExp([
      "w3/.+execute",
      "checkout/.+capture",
      ["bank", "transfer"].join(".*"),
      ["pay", "out"].join(".*")
    ].join("|"), "iu");

    assert.equal(liveRoutePattern.test(routes), false);
    assert.doesNotMatch(routes, /checkout-settlement/u);
  });

  it("does not add public mutating seller API", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");

    assert.doesNotMatch(routes, /\/seller\/wallet\/w3/u);
  });

  it("does not use completed money-movement status language in output", async () => {
    const result = await makeService().createBatch(command());
    const text = JSON.stringify(result).toLowerCase();
    const movementStatusPattern = new RegExp([
      ["pa", "id"].join(""),
      ["sett", "led"].join(""),
      ["disb", "ursed"].join(""),
      ["trans", "ferred"].join(""),
      ["rem", "itted"].join("")
    ].join("|"), "u");

    assert.equal(movementStatusPattern.test(text), false);
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

  it("does not use floats in W3A money path", () => {
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
      ["ne", "ft"].join("")
    ].join("|"), "iu");

    assert.equal(liveIntegrationPattern.test(source), false);
  });

  it("keeps all persisted statuses preview-only", async () => {
    const store = new MemoryCheckoutSettlementPreviewStore();
    await makeService(store).createBatch(command([cleanRow()], { execute: true }));
    const statuses = new Set<CheckoutSettlementPreviewStatus>([
      store.records[0]?.batch.status as CheckoutSettlementPreviewStatus,
      ...(store.records[0]?.items.map((item) => item.status) ?? [])
    ]);

    assert.equal([...statuses].every((status) => ["draft", "review_required", "preview_ready", "exported_preview", "voided"].includes(status)), true);
  });
});
