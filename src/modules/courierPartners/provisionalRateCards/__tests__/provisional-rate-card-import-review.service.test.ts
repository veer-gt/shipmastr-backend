import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import {
  approveInternalProvisionalRateCard,
  archiveProvisionalRateCard,
  importProvisionalRateCard,
  previewProvisionalRateCardImport,
  rejectProvisionalRateCard,
  resetProvisionalRateCardReviewStoreForTests,
  sampleProvisionalRateCardImport,
  simulateProvisionalRateCard
} from "../provisional-rate-card.service.js";
import {
  serializeAdminProvisionalRateCardImportPreview,
  serializeAdminProvisionalRateCardReview,
  serializeSellerSafeProvisionalQuote
} from "../provisional-rate-card.serializer.js";

function sampleTemplate(overrides: Record<string, unknown> = {}) {
  return {
    ...sampleProvisionalRateCardImport(),
    ...overrides
  };
}

function withFirstChargeCell(overrides: Record<string, unknown>) {
  const template = sampleTemplate();
  return {
    ...template,
    charge_cells: [
      {
        ...template.charge_cells[0],
        ...overrides
      }
    ]
  };
}

describe("provisional rate card import and review workflow", () => {
  beforeEach(() => {
    resetProvisionalRateCardReviewStoreForTests();
  });

  it("validates the fake JSON import template without mutating state", () => {
    const preview = previewProvisionalRateCardImport(sampleTemplate(), "admin-user");
    const serialized = serializeAdminProvisionalRateCardImportPreview(preview);

    assert.equal(preview.valid, true);
    assert.equal(preview.mutationPerformed, false);
    assert.equal(preview.liveProviderCallPerformed, false);
    assert.equal(preview.officialRateClaim, false);
    assert.equal(preview.settlementAllowed, false);
    assert.equal(preview.reconciliationAllowed, false);
    assert.equal(preview.publicSellerVisible, false);
    assert.equal(serialized.card?.benchmark_only, true);
    assert.equal(serialized.card?.official_rate_claim, false);
    assert.ok(serialized.card?.validation_warnings.includes("BENCHMARK_ONLY_NOT_OFFICIAL"));
  });

  it("rejects unknown provider lanes", () => {
    const preview = previewProvisionalRateCardImport(sampleTemplate({
      provider_lane_mappings: [{ outcome_code: "SHIPMASTR_SMART", lane_codes: ["UNKNOWN_LANE"] }]
    }));

    assert.equal(preview.valid, false);
    assert.match(preview.errors.join(","), /PROVISIONAL_RATE_CARD_LANE_UNSUPPORTED/);
  });

  it("rejects unknown zones", () => {
    const preview = previewProvisionalRateCardImport(withFirstChargeCell({ zone_code: "OUTER_SPACE" }));

    assert.equal(preview.valid, false);
    assert.match(preview.errors.join(","), /PROVISIONAL_RATE_CARD_ZONE_UNSUPPORTED/);
  });

  it("rejects negative charge values", () => {
    const preview = previewProvisionalRateCardImport(withFirstChargeCell({ charge_a_amount: -1 }));

    assert.equal(preview.valid, false);
    assert.match(preview.errors.join(","), /PROVISIONAL_RATE_CARD_CHARGE_INVALID/);
  });

  it("keeps manual benchmark imports away from official active status", () => {
    const preview = previewProvisionalRateCardImport(sampleTemplate({ status: "OFFICIAL_ACTIVE" }));

    assert.equal(preview.valid, false);
    assert.match(preview.errors.join(","), /PROVISIONAL_RATE_CARD_IMPORT_CANNOT_BE_OFFICIAL_ACTIVE/);
  });

  it("blocks settlement and reconciliation flags on manual benchmarks", () => {
    const settlementPreview = previewProvisionalRateCardImport(sampleTemplate({ settlement_allowed: true }));
    const reconciliationPreview = previewProvisionalRateCardImport(sampleTemplate({ reconciliation_allowed: true }));

    assert.equal(settlementPreview.valid, false);
    assert.match(settlementPreview.errors.join(","), /PROVISIONAL_RATE_CARD_IMPORT_SETTLEMENT_BLOCKED/);
    assert.equal(reconciliationPreview.valid, false);
    assert.match(reconciliationPreview.errors.join(","), /PROVISIONAL_RATE_CARD_IMPORT_RECONCILIATION_BLOCKED/);
  });

  it("defaults benchmark visibility away from sellers", () => {
    const preview = previewProvisionalRateCardImport(sampleTemplate());

    assert.equal(preview.card?.publicSellerVisible, false);
    assert.equal(preview.publicSellerVisible, false);
  });

  it("approve-internal never makes benchmark cards official or settlement-grade", () => {
    const imported = importProvisionalRateCard(sampleTemplate(), "admin-user");
    const approved = approveInternalProvisionalRateCard(imported.id, "reviewer-user");

    assert.equal(approved.reviewStatus, "APPROVED_INTERNAL");
    assert.equal(approved.status, "ACTIVE_INTERNAL");
    assert.equal(approved.official, false);
    assert.equal(approved.officialContractRef, null);
    assert.equal(approved.settlementAllowed, false);
    assert.equal(approved.reconciliationAllowed, false);
    assert.equal(approved.publicSellerVisible, false);
    assert.equal(approved.importMetadata.reviewedBy, "reviewer-user");
    assert.ok(approved.importMetadata.reviewedAt);
    assert.equal(approved.importMetadata.rejectedBy, null);
    assert.equal(approved.importMetadata.archivedBy, null);
    assert.ok(approved.validationWarnings.includes("APPROVED_INTERNAL_NOT_OFFICIAL"));
  });

  it("reject requires a reason and keeps the record soft-blocked", () => {
    const imported = importProvisionalRateCard(sampleTemplate(), "admin-user");

    assert.throws(
      () => rejectProvisionalRateCard(imported.id, "checker-user", ""),
      /PROVISIONAL_RATE_CARD_REJECTION_REASON_REQUIRED/
    );

    const rejected = rejectProvisionalRateCard(imported.id, "checker-user", "Source does not match reviewed commercial file.");

    assert.equal(rejected.reviewStatus, "REJECTED");
    assert.equal(rejected.status, "BENCHMARK_ONLY");
    assert.equal(rejected.official, false);
    assert.equal(rejected.settlementAllowed, false);
    assert.equal(rejected.reconciliationAllowed, false);
    assert.equal(rejected.publicSellerVisible, false);
    assert.equal(rejected.importMetadata.rejectedBy, "checker-user");
    assert.ok(rejected.importMetadata.rejectedAt);
    assert.equal(rejected.importMetadata.rejectionReason, "Source does not match reviewed commercial file.");

    const simulation = simulateProvisionalRateCard(imported.id, {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: false
    });

    assert.equal(simulation.status, "BLOCKED");
    assert.equal(simulation.blockerCode, "PROVISIONAL_RATE_CARD_REJECTED");
    assert.equal(simulation.sellerSafeQuote, null);
  });

  it("archive requires a reason and keeps the record out of quote eligibility", () => {
    const imported = importProvisionalRateCard(sampleTemplate(), "admin-user");

    assert.throws(
      () => archiveProvisionalRateCard(imported.id, "checker-user", ""),
      /PROVISIONAL_RATE_CARD_ARCHIVE_REASON_REQUIRED/
    );

    const archived = archiveProvisionalRateCard(imported.id, "checker-user", "Superseded by newer benchmark review.");

    assert.equal(archived.reviewStatus, "ARCHIVED");
    assert.equal(archived.status, "ARCHIVED");
    assert.equal(archived.official, false);
    assert.equal(archived.settlementAllowed, false);
    assert.equal(archived.reconciliationAllowed, false);
    assert.equal(archived.publicSellerVisible, false);
    assert.equal(archived.importMetadata.archivedBy, "checker-user");
    assert.ok(archived.importMetadata.archivedAt);
    assert.equal(archived.importMetadata.archiveReason, "Superseded by newer benchmark review.");

    const simulation = simulateProvisionalRateCard(imported.id, {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: true
    });

    assert.equal(simulation.status, "BLOCKED");
    assert.equal(simulation.blockerCode, "PROVISIONAL_RATE_CARD_ARCHIVED");
    assert.equal(simulation.sellerSafeQuote, null);
    assert.equal(simulation.adminDiagnostics.laneCode, null);
  });

  it("blocks expired benchmark cards from simulation and internal approval", () => {
    const imported = importProvisionalRateCard(sampleTemplate({
      expires_at: "2026-01-01T00:00:00.000Z"
    }), "admin-user", new Date("2026-06-21T00:00:00.000Z"));

    assert.equal(imported.reviewStatus, "EXPIRED");
    assert.throws(
      () => approveInternalProvisionalRateCard(imported.id, "checker-user", new Date("2026-06-21T00:00:00.000Z")),
      /PROVISIONAL_RATE_CARD_EXPIRED/
    );

    const simulation = simulateProvisionalRateCard(imported.id, {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: false
    }, new Date("2026-06-21T00:00:00.000Z"));

    assert.equal(simulation.status, "BLOCKED");
    assert.equal(simulation.blockerCode, "PROVISIONAL_RATE_CARD_EXPIRED");
    assert.equal(simulation.sellerSafeQuote, null);
  });

  it("blocks seller-facing simulations whenever benchmark data is hidden from sellers", () => {
    const imported = importProvisionalRateCard(sampleTemplate(), "admin-user");
    const approved = approveInternalProvisionalRateCard(imported.id, "reviewer-user");

    assert.equal(approved.status, "ACTIVE_INTERNAL");
    assert.equal(approved.publicSellerVisible, false);

    const simulation = simulateProvisionalRateCard(imported.id, {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: true
    });

    assert.equal(simulation.status, "BLOCKED");
    assert.equal(simulation.blockerCode, "BENCHMARK_ONLY_NOT_PUBLIC_SELLER_VISIBLE");
    assert.equal(simulation.sellerSafeQuote, null);
    const sellerSerialized = JSON.stringify(serializeSellerSafeProvisionalQuote(simulation));
    for (const forbidden of ["DELHIVERY", "XPRESSBEES", "SHADOWFAX", "EKART", "BIGSHIP", "SHIPROCKET", "MANUAL_BENCHMARK", "BENCHMARK_ONLY"]) {
      assert.equal(sellerSerialized.includes(forbidden), false, `${forbidden} leaked to seller-safe serialization`);
    }
  });

  it("shows lane diagnostics to admin while seller serializer hides provider lanes", () => {
    const imported = importProvisionalRateCard(sampleTemplate(), "admin-user");
    const adminSerialized = JSON.stringify(serializeAdminProvisionalRateCardReview(imported));
    const simulation = simulateProvisionalRateCard(imported.id, {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: true
    });
    const sellerSerialized = JSON.stringify(serializeSellerSafeProvisionalQuote(simulation));

    assert.ok(adminSerialized.includes("DELHIVERY_B2C_SURFACE"));
    for (const forbidden of ["DELHIVERY", "XPRESSBEES", "SHADOWFAX", "EKART", "BIGSHIP", "SHIPROCKET", "MANUAL_BENCHMARK", "BENCHMARK_ONLY"]) {
      assert.equal(sellerSerialized.includes(forbidden), false, `${forbidden} leaked to seller-safe serialization`);
    }
  });

  it("does not serialize any official-rate claim as true", () => {
    const preview = previewProvisionalRateCardImport(sampleTemplate());
    const serialized = JSON.stringify(serializeAdminProvisionalRateCardImportPreview(preview));

    assert.equal(serialized.includes("\"official_rate_claim\":true"), false);
    assert.equal(serialized.includes("\"official\":true"), false);
    assert.equal(serialized.includes("\"settlement_allowed\":true"), false);
    assert.equal(serialized.includes("\"reconciliation_allowed\":true"), false);
    assert.equal(serialized.includes("\"public_seller_visible\":true"), false);
  });

  it("does not add courier API or shipment mutation hooks", () => {
    const source = readFileSync(
      `${process.cwd()}/src/modules/courierPartners/provisionalRateCards/provisional-rate-card.service.ts`,
      "utf8"
    );
    for (const forbidden of [
      "createLabel",
      "getRates",
      "manifestOrder",
      "bookPickup",
      "createAwb",
      "sendNdr",
      "triggerCodPayout",
      "mutateWeightDispute",
      "trackingLastSyncedAt"
    ]) {
      assert.equal(source.includes(forbidden), false, `${forbidden} should not appear in provisional import review service`);
    }
  });
});
