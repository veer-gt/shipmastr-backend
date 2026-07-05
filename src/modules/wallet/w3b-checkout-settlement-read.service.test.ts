import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  W3BCheckoutPreviewReadService,
  w3bCheckoutPreviewDisclaimer,
  w3bCheckoutReadiness,
  type W3BCheckoutPreviewReadStore
} from "./w3-checkout-settlement-read.service.js";
import {
  assertW3CheckoutSellerQueryScope,
  sellerOrgIdFromW3CheckoutAuth
} from "./w3-checkout-settlement-read.routes.js";
import type {
  CheckoutSettlementPreviewAllocationRecord,
  CheckoutSettlementPreviewBatchRecord,
  CheckoutSettlementPreviewEventRecord,
  CheckoutSettlementPreviewItemRecord,
  CheckoutSettlementPreviewStoredBatch
} from "./w3a-checkout-settlement-preview.service.js";

const now = new Date("2026-07-05T14:00:00.000Z");

function cloneState<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function cleanBatch(overrides: Partial<CheckoutSettlementPreviewBatchRecord> = {}): CheckoutSettlementPreviewBatchRecord {
  return {
    id: "cspb_w3b_clean_0001",
    sellerOrgId: "org_w3b_seller_a",
    period: "2026-07",
    sourceRef: "src_w3a_checkout_preview_2026_07",
    sourceHash: "hash_w3b_clean",
    status: "preview_ready",
    currency: "INR",
    grossAmountMinor: 100000n,
    paymentFeeMinor: 2500n,
    platformFeeMinor: 5000n,
    shippingChargeMinor: 8000n,
    taxMinor: 1800n,
    discountMinor: 3000n,
    refundMinor: 0n,
    adjustmentMinor: 1300n,
    sellerPreviewReceivableMinor: 81000n,
    negativePreviewMinor: 0n,
    reviewRequiredCount: 0,
    metadata: { previewOnly: true },
    createdBy: "usr_w3b_admin",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function cleanItem(overrides: Partial<CheckoutSettlementPreviewItemRecord> = {}): CheckoutSettlementPreviewItemRecord {
  return {
    id: "cspi_w3b_clean_0001",
    batchId: "cspb_w3b_clean_0001",
    sellerOrgId: "org_w3b_seller_a",
    checkoutRef: "chk_w3a_clean_0001",
    orderRef: "ord_w3a_clean_0001",
    shipmentId: "shp_w3a_clean_0001",
    period: "2026-07",
    currency: "INR",
    grossAmountMinor: 100000n,
    paymentFeeMinor: 2500n,
    platformFeeMinor: 5000n,
    shippingChargeMinor: 8000n,
    taxMinor: 1800n,
    discountMinor: 3000n,
    refundMinor: 0n,
    adjustmentMinor: 1300n,
    sellerPreviewReceivableMinor: 81000n,
    status: "draft",
    reviewReasons: [],
    sourceRowHash: "row_hash_w3b_clean",
    metadata: { previewOnly: true },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function cleanAllocation(overrides: Partial<CheckoutSettlementPreviewAllocationRecord> = {}): CheckoutSettlementPreviewAllocationRecord {
  return {
    id: "cspa_w3b_clean_0001",
    batchId: "cspb_w3b_clean_0001",
    itemId: "cspi_w3b_clean_0001",
    bucket: "seller_preview_receivable",
    amountMinor: 81000n,
    currency: "INR",
    metadata: { previewOnly: true },
    createdAt: now,
    ...overrides
  };
}

function cleanEvent(overrides: Partial<CheckoutSettlementPreviewEventRecord> = {}): CheckoutSettlementPreviewEventRecord {
  return {
    id: "cspe_w3b_clean_0001",
    batchId: "cspb_w3b_clean_0001",
    itemId: null,
    eventType: "w3a.checkout_settlement_preview.created",
    status: "preview_ready",
    message: "Preview batch recorded for review only.",
    metadata: { previewOnly: true },
    createdBy: "usr_w3b_admin",
    createdAt: now,
    ...overrides
  };
}

function cleanRecord(overrides: {
  batch?: Partial<CheckoutSettlementPreviewBatchRecord>;
  item?: Partial<CheckoutSettlementPreviewItemRecord>;
  allocation?: Partial<CheckoutSettlementPreviewAllocationRecord>;
  event?: Partial<CheckoutSettlementPreviewEventRecord>;
} = {}): CheckoutSettlementPreviewStoredBatch {
  const batch = cleanBatch(overrides.batch);
  const item = cleanItem({ batchId: batch.id, sellerOrgId: batch.sellerOrgId, ...overrides.item });
  return {
    batch,
    items: [item],
    allocations: [cleanAllocation({ batchId: batch.id, itemId: item.id, ...overrides.allocation })],
    events: [cleanEvent({ batchId: batch.id, ...overrides.event })]
  };
}

class MemoryW3BReadStore implements W3BCheckoutPreviewReadStore {
  constructor(readonly records: CheckoutSettlementPreviewStoredBatch[] = [cleanRecord()]) {}

  async listBatches(filters: Parameters<W3BCheckoutPreviewReadStore["listBatches"]>[0]) {
    const filtered = this.records
      .map((record) => record.batch)
      .filter((batch) => !filters.sellerOrgId || batch.sellerOrgId === filters.sellerOrgId)
      .filter((batch) => !filters.period || batch.period === filters.period)
      .filter((batch) => !filters.status || batch.status === filters.status)
      .filter((batch) => !filters.currency || batch.currency === filters.currency)
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
  return new W3BCheckoutPreviewReadService(new MemoryW3BReadStore(records));
}

function outputWithoutDisclaimer(value: unknown) {
  return JSON.stringify(value).replaceAll(w3bCheckoutPreviewDisclaimer, "");
}

describe("W3B checkout settlement read surfaces", () => {
  it("mounts protected internal, admin, and seller read routers", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/internal\/wallet\/w3\/checkout", requireInternalSecret, internalW3CheckoutPreviewRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/wallets\/w3\/checkout", requireAdminJwt, adminW3CheckoutPreviewRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/seller\/wallet\/w3\/checkout", requireJwtAuth, sellerW3CheckoutPreviewRouter\);/);
    assert.ok(routes.indexOf("apiRouter.use(\"/admin/wallets/w3/checkout\"") < routes.indexOf("apiRouter.use(\"/admin/wallets\""));
  });

  it("adds no mutating checkout wallet routes or public seller mutation surface", () => {
    const routeSource = readFileSync("src/modules/wallet/w3-checkout-settlement-read.routes.ts", "utf8");
    const allRoutes = readFileSync("src/routes/index.ts", "utf8");

    assert.equal(/\.(post|put|patch|delete)\(/u.test(routeSource), false);
    assert.doesNotMatch(allRoutes, /apiRouter\.use\("\/wallet\/w3/u);
  });

  it("derives seller scope from auth and rejects cross-seller query attempts", () => {
    assert.equal(sellerOrgIdFromW3CheckoutAuth({ userId: "usr_1", merchantId: "org_w3b_seller_a", role: "SELLER" }), "org_w3b_seller_a");
    assert.throws(() => sellerOrgIdFromW3CheckoutAuth(undefined), /Required|invalid_type/i);
    assert.doesNotThrow(() => assertW3CheckoutSellerQueryScope("org_w3b_seller_a", "org_w3b_seller_a"));
    assert.throws(
      () => assertW3CheckoutSellerQueryScope("org_w3b_seller_b", "org_w3b_seller_a"),
      (error) => error instanceof HttpError && error.status === 403 && error.message === "W3B_SELLER_SCOPE_ONLY"
    );
  });

  it("returns protected readiness with preview-only flags", () => {
    const readiness = w3bCheckoutReadiness();

    assert.equal(readiness.phase, "W3B");
    assert.equal(readiness.previewOnly, true);
    assert.equal(readiness.movementExecuted, false);
    assert.equal(readiness.paymentCaptured, false);
    assert.equal(readiness.payoutExecuted, false);
    assert.equal(readiness.settlementExecuted, false);
    assert.equal(readiness.custodyCreated, false);
    assert.equal(readiness.exportPreviewOnly, true);
  });

  it("lets admin list checkout preview batches with string money and no spendable balance", async () => {
    const page = await makeService().listBatches({ sellerOrgId: "org_w3b_seller_a", limit: 25 });
    const batch = page.batches[0]!;
    const output = JSON.stringify(page);

    assert.equal(batch.status, "preview_ready");
    assert.equal(batch.totals.sellerPreviewReceivableMinor, "81000");
    assert.equal(typeof batch.totals.grossAmountMinor, "string");
    assert.equal(batch.previewOnly, true);
    assert.equal(batch.movementExecuted, false);
    assert.equal(batch.paymentCaptured, false);
    assert.equal(batch.payoutExecuted, false);
    assert.equal(batch.settlementExecuted, false);
    assert.equal(batch.custodyCreated, false);
    assert.equal(output.includes(["shipping", "balance"].join("_")), false);
    assert.equal(output.includes("spendableBalance"), false);
  });

  it("lets admin read checkout preview detail with items, allocations, and events", async () => {
    const detail = await makeService().getBatchDetail("cspb_w3b_clean_0001");
    const output = outputWithoutDisclaimer(detail);

    assert.equal(detail.batch.id, "cspb_w3b_clean_0001");
    assert.equal(detail.items.length, 1);
    assert.equal(detail.allocations.length, 1);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.items[0]!.sellerPreviewReceivableMinor, "81000");
    assert.equal(detail.policy.previewOnly, true);
    assert.equal(/\bpaid\b|\bsettled\b|\bdisbursed\b|\btransferred\b|\bremitted\b|\bcaptured\b|\bexecuted\b/iu.test(output), false);
  });

  it("keeps export-preview read-only and does not create payment or settlement events", async () => {
    const record = cleanRecord();
    const service = makeService([record]);
    const beforeStatus = record.batch.status;
    const beforeEvents = record.events.length;
    const preview = await service.exportPreview(record.batch.id, "json");
    if (!("batch" in preview)) throw new Error("expected json preview");

    assert.equal(preview.batch.status, beforeStatus);
    assert.equal(record.batch.status, beforeStatus);
    assert.equal(record.events.length, beforeEvents);
    assert.equal(preview.exportPreview.previewOnly, true);
    assert.equal(preview.exportPreview.movementExecuted, false);
    assert.equal(preview.exportPreview.paymentCaptured, false);
    assert.equal(preview.exportPreview.payoutExecuted, false);
    assert.equal(preview.exportPreview.settlementExecuted, false);
    assert.equal(preview.exportPreview.custodyCreated, false);
    assert.equal(preview.exportPreview.statusChanged, false);
  });

  it("returns CSV export-preview text with disclaimer and safe flags", async () => {
    const record = cleanRecord();
    const preview = await makeService([record]).exportPreview(record.batch.id, "csv");
    if (!("csv" in preview)) throw new Error("expected csv preview");

    assert.equal(preview.policy.previewOnly, true);
    assert.match(preview.csv, /^# Checkout settlement preview only\./u);
    assert.match(preview.csv, /previewOnly,true/u);
    assert.match(preview.csv, /movementExecuted,false/u);
    assert.match(preview.csv, /paymentCaptured,false/u);
    assert.match(preview.csv, /payoutExecuted,false/u);
    assert.match(preview.csv, /settlementExecuted,false/u);
    assert.match(preview.csv, /custodyCreated,false/u);
    assert.equal(record.batch.status, "preview_ready");
    assert.equal(record.events.length, 1);
  });

  it("omits unsafe public-facing refs from output", async () => {
    const publicRefTerm = ["ord", "er_"].join("");
    const unsafeRecord = cleanRecord({
      batch: {
        sourceRef: `${publicRefTerm}public_9876543210`
      },
      item: {
        checkoutRef: "chk_public_9876543210",
        orderRef: `${publicRefTerm}public_9876543210`,
        shipmentId: "shp_public_9876543210"
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
      ["buy", "er"].join(""),
      ["pho", "ne"].join(""),
      ["em", "ail"].join(""),
      ["addr", "ess"].join(""),
      ["pin", "code"].join("")
    ].join("|"), "i");

    assert.equal(blockedPattern.test(output), false);
    assert.equal(detail.batch.sourceRef, null);
    assert.equal(detail.items[0]!.checkoutInternalRef, null);
    assert.equal(detail.items[0]!.orderInternalRef, null);
    assert.equal(detail.items[0]!.shipmentInternalId, null);
  });

  it("keeps seller reads seller-scoped and summary read-only", async () => {
    const records = [
      cleanRecord(),
      cleanRecord({
        batch: { id: "cspb_w3b_other_0001", sellerOrgId: "org_w3b_seller_b", sourceRef: "src_w3a_checkout_preview_other" },
        item: { sellerOrgId: "org_w3b_seller_b", batchId: "cspb_w3b_other_0001" }
      })
    ];
    const service = makeService(records);
    const summary = await service.sellerSummary("org_w3b_seller_a");
    const page = await service.listBatches({ sellerOrgId: "org_w3b_seller_a", limit: 50 });

    assert.equal(summary.sellerOrgId, "org_w3b_seller_a");
    assert.equal(summary.recentBatches.length, 1);
    assert.equal(page.batches.length, 1);
    assert.equal(page.batches[0]!.sellerOrgId, "org_w3b_seller_a");
    assert.equal(summary.policy.previewOnly, true);
    assert.equal(summary.policy.payoutExecuted, false);
  });

  it("keeps W3B source free of direct writes, floats, live calls, and custody account usage", () => {
    const source = [
      readFileSync("src/modules/wallet/w3-checkout-settlement-read.service.ts", "utf8"),
      readFileSync("src/modules/wallet/w3-checkout-settlement-read.routes.ts", "utf8")
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
