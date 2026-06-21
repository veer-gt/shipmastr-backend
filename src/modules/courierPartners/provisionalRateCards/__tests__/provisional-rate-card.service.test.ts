import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  listCommercialRateCardGroups,
  listProvisionalRateCards,
  listShipmastrOutcomeTiers,
  normalizeProvisionalRateCard,
  simulateProvisionalRateCard
} from "../provisional-rate-card.service.js";
import { evaluateOfficialRateCardIngestionReadiness } from "../provisional-rate-card.rules.js";
import {
  serializeAdminProvisionalRateCard,
  serializeAdminProvisionalRateCardSimulation,
  serializeSellerSafeProvisionalQuote
} from "../provisional-rate-card.serializer.js";
import type { ProvisionalRateCardDefinition } from "../provisional-rate-card.types.js";

function fixtureCard(overrides: Partial<ProvisionalRateCardDefinition> = {}): ProvisionalRateCardDefinition {
  return {
    id: "fixture-card",
    name: "Fixture Card",
    groupCode: "SILVER",
    sourceType: "MANUAL_BENCHMARK",
    status: "BENCHMARK_ONLY",
    official: false,
    officialContractRef: null,
    settlementAllowed: false,
    reconciliationAllowed: false,
    publicSellerVisible: false,
    effectiveFrom: null,
    effectiveTo: null,
    reviewBy: null,
    allowedOutcomeTierCodes: ["SHIPMASTR_SMART"],
    providerLaneMappings: [{ outcomeCode: "SHIPMASTR_SMART", laneCodes: ["DELHIVERY_B2C_SURFACE"] }],
    chargeCells: [{
      laneCode: "DELHIVERY_B2C_SURFACE",
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightSlab: {
        minWeightKg: 0,
        maxWeightKg: 0.5,
        slabOrder: 1,
        packageType: "ANY",
        active: true
      },
      chargeAAmount: 11,
      chargeBAmount: 12,
      chargeALabel: "PRIMARY_CHARGE",
      chargeBLabel: "SECONDARY_CHARGE",
      codChargeA: 1,
      codChargeB: 2,
      codChargePolicy: "COMPONENTS_ONLY",
      volumetricDivisor: 5000,
      rtoPercentage: 0,
      currency: "INR",
      gstTaxHandling: { status: "REVIEW_REQUIRED", gstPercent: null },
      notes: []
    }],
    internalNotes: [],
    ...overrides
  };
}

describe("provisional rate card group and tier foundation", () => {
  it("models the required commercial groups", () => {
    const codes = listCommercialRateCardGroups().map((group) => group.groupCode).sort();
    assert.deepEqual(codes, ["CUSTOM", "ENTERPRISE", "GOLD", "PILOT", "PLATINUM", "SILVER"]);
  });

  it("models the required seller-facing outcome tiers", () => {
    const names = listShipmastrOutcomeTiers().map((tier) => tier.displayName);
    assert.deepEqual(names, [
      "Shipmastr Smart",
      "Shipmastr Economy",
      "Shipmastr Express",
      "Shipmastr COD Shield",
      "Shipmastr Weight Guard",
      "Shipmastr Autopilot"
    ]);
  });

  it("maps commercial groups to enabled Shipmastr outcome tiers", () => {
    const silver = listCommercialRateCardGroups().find((group) => group.groupCode === "SILVER");
    const platinum = listCommercialRateCardGroups().find((group) => group.groupCode === "PLATINUM");
    assert.ok(silver?.defaultOutcomeTierCodes.includes("SHIPMASTR_SMART"));
    assert.ok(silver?.defaultOutcomeTierCodes.includes("SHIPMASTR_EXPRESS"));
    assert.equal(silver?.defaultOutcomeTierCodes.includes("SHIPMASTR_COD_SHIELD"), false);
    assert.equal(platinum?.defaultOutcomeTierCodes.length, 6);
  });

  it("keeps manual benchmark cards out of settlement and reconciliation", () => {
    const normalized = normalizeProvisionalRateCard(fixtureCard({
      official: true,
      settlementAllowed: true,
      reconciliationAllowed: true,
      publicSellerVisible: true
    }));

    assert.equal(normalized.official, false);
    assert.equal(normalized.settlementAllowed, false);
    assert.equal(normalized.reconciliationAllowed, false);
    assert.equal(normalized.publicSellerVisible, false);
  });

  it("blocks seller display for benchmark-only non-public cards", () => {
    const result = simulateProvisionalRateCard("silver-benchmark-template", {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: true
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.blockerCode, "BENCHMARK_ONLY_NOT_PUBLIC_SELLER_VISIBLE");
    assert.equal(result.sellerSafeQuote, null);
  });

  it("keeps seller-safe serializer free of lane and source details", () => {
    const result = simulateProvisionalRateCard("silver-benchmark-template", {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: true
    });
    const serialized = JSON.stringify(serializeSellerSafeProvisionalQuote(result));

    for (const forbidden of ["DELHIVERY", "XPRESSBEES", "SHADOWFAX", "EKART", "BIGSHIP", "SHIPROCKET", "MANUAL_BENCHMARK", "BENCHMARK_ONLY"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked to seller-safe quote`);
    }
  });

  it("limits seller-safe quote metadata to Shipmastr-branded tiers", () => {
    const result = simulateProvisionalRateCard("silver-benchmark-template", {
      outcomeCode: "SHIPMASTR_SMART",
      zoneCode: "WITHIN_CITY",
      weightKg: 0.5,
      sellerFacing: true
    });
    const serialized = serializeSellerSafeProvisionalQuote(result);

    assert.deepEqual(serialized.available_tiers.map((tier) => tier.tier_name), [
      "Shipmastr Smart",
      "Shipmastr Economy",
      "Shipmastr Express",
      "Shipmastr COD Shield",
      "Shipmastr Weight Guard",
      "Shipmastr Autopilot"
    ]);
    assert.equal(serialized.powered_by, "Shipmastr network");
    assert.equal(serialized.quote, null);

    const text = JSON.stringify(serialized);
    for (const forbidden of [
      "source_type",
      "settlement_allowed",
      "reconciliation_allowed",
      "public_seller_visible",
      "official",
      "lane_code",
      "DELHIVERY",
      "XPRESSBEES",
      "SHADOWFAX",
      "EKART",
      "BIGSHIP",
      "SHIPROCKET",
      "MANUAL_BENCHMARK",
      "BENCHMARK_ONLY"
    ]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} leaked to seller-safe quote metadata`);
    }
  });

  it("lets admin serializer show safe internal lane diagnostics", () => {
    const card = listProvisionalRateCards()[0]!;
    const serialized = serializeAdminProvisionalRateCard(card);

    assert.equal(serialized.source_type, "MANUAL_BENCHMARK");
    assert.equal(serialized.official, false);
    assert.equal(serialized.settlement_allowed, false);
    assert.equal(serialized.reconciliation_allowed, false);
    assert.ok(JSON.stringify(serialized).includes("DELHIVERY_B2C_SURFACE"));
  });

  it("uses a two-charge component model without assuming meaning", () => {
    const normalized = normalizeProvisionalRateCard(fixtureCard());
    const cell = normalized.chargeCells[0]!;

    assert.equal(cell.chargeALabel, "PRIMARY_CHARGE");
    assert.equal(cell.chargeBLabel, "SECONDARY_CHARGE");
    assert.equal(cell.codChargePolicy, "COMPONENTS_ONLY");
  });

  it("rejects unknown zones safely", () => {
    assert.throws(() => normalizeProvisionalRateCard(fixtureCard({
      chargeCells: [{ ...fixtureCard().chargeCells[0]!, zoneCode: "UNKNOWN" as never }]
    })), /PROVISIONAL_RATE_CARD_ZONE_UNSUPPORTED/);
  });

  it("rejects unknown provider lanes safely", () => {
    assert.throws(() => normalizeProvisionalRateCard(fixtureCard({
      providerLaneMappings: [{ outcomeCode: "SHIPMASTR_SMART", laneCodes: ["UNKNOWN_LANE" as never] }]
    })), /PROVISIONAL_RATE_CARD_LANE_UNSUPPORTED/);
  });

  it("flags benchmark cards past review date in simulation diagnostics", () => {
    const oldReview = fixtureCard({ reviewBy: "2026-01-01T00:00:00.000Z" });
    const normalized = normalizeProvisionalRateCard(oldReview);
    assert.equal(normalized.reviewBy, "2026-01-01T00:00:00.000Z");

    const admin = serializeAdminProvisionalRateCardSimulation({
      status: "NO_MATCH",
      blockerCode: "PROVISIONAL_RATE_CARD_CELL_NOT_CONFIGURED",
      sellerSafeQuote: null,
      adminDiagnostics: {
        sourceType: normalized.sourceType,
        status: normalized.status,
        official: normalized.official,
        settlementAllowed: normalized.settlementAllowed,
        reconciliationAllowed: normalized.reconciliationAllowed,
        publicSellerVisible: normalized.publicSellerVisible,
        laneCode: null,
        chargeComponents: null,
        warnings: ["PROVISIONAL_RATE_CARD_REVIEW_PAST"]
      }
    });
    assert.ok(admin.admin_diagnostics.warnings.includes("PROVISIONAL_RATE_CARD_REVIEW_PAST"));
  });

  it("requires explicit metadata before official contract rates can be official", () => {
    assert.throws(() => normalizeProvisionalRateCard(fixtureCard({
      sourceType: "OFFICIAL_CONTRACT",
      status: "OFFICIAL_ACTIVE",
      official: true,
      officialContractRef: null
    })), /PROVISIONAL_RATE_CARD_OFFICIAL_METADATA_REQUIRED/);
  });

  it("blocks manual benchmark and benchmark-only records from official ingestion readiness", () => {
    const readiness = evaluateOfficialRateCardIngestionReadiness({
      sourceType: "MANUAL_BENCHMARK",
      status: "BENCHMARK_ONLY",
      sourceLabel: "USER_PROVIDED_REVIEWED_PROVISIONAL",
      sourceRecordId: "phase-66-silver-rate-card-source-capture.csv",
      contractId: "contract-1",
      signedDate: "2026-06-21",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2027-06-30",
      approvedBy: "admin-1",
      documentRef: "secure-ref-1"
    });

    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.includes("OFFICIAL_INGESTION_SOURCE_MUST_BE_OFFICIAL_CONTRACT"));
    assert.ok(readiness.blockers.includes("MANUAL_BENCHMARK_CANNOT_BECOME_OFFICIAL_CONTRACT"));
    assert.ok(readiness.blockers.includes("BENCHMARK_ONLY_CANNOT_BECOME_OFFICIAL_ACTIVE"));
    assert.ok(readiness.blockers.includes("USER_PROVIDED_REVIEWED_PROVISIONAL_CANNOT_BECOME_OFFICIAL_CONTRACT"));
    assert.ok(readiness.blockers.includes("SILVER_BENCHMARK_CANNOT_BE_OFFICIAL_SOURCE"));
    assert.equal(readiness.officialRatesEnabled, false);
    assert.equal(readiness.mutationPerformed, false);
    assert.equal(readiness.liveProviderCallPerformed, false);
  });

  it("requires signed contract metadata before official activation readiness", () => {
    const readiness = evaluateOfficialRateCardIngestionReadiness({
      sourceType: "OFFICIAL_CONTRACT",
      status: "OFFICIAL_ACTIVE"
    });

    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_CONTRACT_ID_REQUIRED"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_SIGNED_DATE_REQUIRED"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_EFFECTIVE_FROM_REQUIRED"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_EFFECTIVE_TO_REQUIRED"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_APPROVED_BY_REQUIRED"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_DOCUMENT_REF_REQUIRED"));
  });

  it("keeps official readiness separate from settlement, reconciliation, and seller visibility gates", () => {
    const readiness = evaluateOfficialRateCardIngestionReadiness({
      sourceType: "OFFICIAL_CONTRACT",
      status: "OFFICIAL_PENDING",
      contractId: "contract-1",
      signedDate: "2026-06-21",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2027-06-30",
      approvedBy: "admin-1",
      documentRef: "secure-ref-1",
      settlementAllowed: true,
      reconciliationAllowed: true,
      publicSellerVisible: true
    });

    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_FINANCE_GATE_REQUIRED_FOR_SETTLEMENT"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_FINANCE_GATE_REQUIRED_FOR_RECONCILIATION"));
    assert.ok(readiness.blockers.includes("OFFICIAL_RATE_CARD_SELLER_VISIBILITY_GATE_REQUIRED"));
    assert.equal(readiness.settlementAllowed, false);
    assert.equal(readiness.reconciliationAllowed, false);
    assert.equal(readiness.officialRatesEnabled, false);
  });

  it("allows official ingestion readiness only after contract metadata is complete and non-mutating", () => {
    const readiness = evaluateOfficialRateCardIngestionReadiness({
      sourceType: "OFFICIAL_CONTRACT",
      status: "OFFICIAL_PENDING",
      sourceLabel: "Signed courier contract",
      sourceRecordId: "secure-official-contract-ref",
      contractId: "contract-1",
      signedDate: "2026-06-21",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2027-06-30",
      approvedBy: "admin-1",
      documentRef: "secure-ref-1"
    });

    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.blockers, []);
    assert.equal(readiness.officialRatesEnabled, false);
    assert.equal(readiness.settlementAllowed, false);
    assert.equal(readiness.reconciliationAllowed, false);
    assert.equal(readiness.mutationPerformed, false);
    assert.equal(readiness.liveProviderCallPerformed, false);
  });

  it("does not make courier API or shipment mutation calls", () => {
    const source = readFileSync(
      `${process.cwd()}/src/modules/courierPartners/provisionalRateCards/provisional-rate-card.service.ts`,
      "utf8"
    );
    for (const forbidden of ["createLabel", "getRates", "manifestOrder", "sendMail", "awbNumber", "trackingLastSyncedAt"]) {
      assert.equal(source.includes(forbidden), false, `${forbidden} should not appear in provisional rate card service`);
    }
  });

  it("documents route protection through admin-only mounts", () => {
    const routes = readFileSync(`${process.cwd()}/src/routes/index.ts`, "utf8");
    assert.match(routes, /apiRouter\.use\("\/admin\/rate-card-groups", requireAdminJwt, adminRateCardGroupsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/rate-card-tiers", requireAdminJwt, adminRateCardTiersRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/provisional-rate-cards", requireAdminJwt, adminProvisionalRateCardsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/rate-card-quotes", requireJwtAuth, sellerProvisionalRateCardQuotesRouter\);/);
  });

  it("forces seller-facing mode on the seller-safe quote route", () => {
    const routeSource = readFileSync(
      `${process.cwd()}/src/modules/courierPartners/provisionalRateCards/provisional-rate-card.routes.ts`,
      "utf8"
    );

    assert.match(routeSource, /sellerProvisionalRateCardQuotesRouter\.post\("\/:id\/simulate"/);
    assert.match(routeSource, /seller_facing:\s*true/);
    assert.match(routeSource, /sellerFacing:\s*true/);
    assert.match(routeSource, /serializeSellerSafeProvisionalQuote/);
  });
});
