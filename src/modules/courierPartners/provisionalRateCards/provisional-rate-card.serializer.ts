import type {
  CommercialRateCardGroup,
  ProvisionalRateCardDefinition,
  ProvisionalRateCardSimulationResult,
  ShipmastrOutcomeTier
} from "./provisional-rate-card.types.js";

export function serializeCommercialRateCardGroup(group: CommercialRateCardGroup) {
  return {
    group_code: group.groupCode,
    group_name: group.groupName,
    group_level: group.groupLevel,
    description: group.description,
    seller_segment: group.sellerSegment,
    default_outcome_tiers: group.defaultOutcomeTierCodes,
    margin_policy: {
      strategy: group.marginPolicy.strategy,
      settlement_allowed: group.marginPolicy.settlementAllowed,
      reconciliation_allowed: group.marginPolicy.reconciliationAllowed
    },
    active: group.active,
    internal_notes: group.internalNotes
  };
}

export function serializeShipmastrOutcomeTier(tier: ShipmastrOutcomeTier) {
  return {
    outcome_code: tier.outcomeCode,
    display_name: tier.displayName,
    description: tier.description,
    priority: tier.priority,
    seller_visible: tier.sellerVisible,
    active: tier.active,
    eligibility_rules: tier.eligibilityRules
  };
}

export function serializeAdminProvisionalRateCard(card: ProvisionalRateCardDefinition) {
  return {
    id: card.id,
    name: card.name,
    group_code: card.groupCode,
    source_type: card.sourceType,
    status: card.status,
    official: card.official,
    official_contract_ref_configured: Boolean(card.officialContractRef),
    settlement_allowed: card.settlementAllowed,
    reconciliation_allowed: card.reconciliationAllowed,
    public_seller_visible: card.publicSellerVisible,
    effective_from: card.effectiveFrom,
    effective_to: card.effectiveTo,
    review_by: card.reviewBy,
    allowed_outcome_tiers: card.allowedOutcomeTierCodes,
    provider_lane_mappings: card.providerLaneMappings.map((mapping) => ({
      outcome_code: mapping.outcomeCode,
      lane_codes: mapping.laneCodes
    })),
    charge_cell_count: card.chargeCells.length,
    charge_cell_model: {
      charge_a_label_default: "PRIMARY_CHARGE",
      charge_b_label_default: "SECONDARY_CHARGE",
      meaning_confirmed: false
    },
    internal_notes: card.internalNotes
  };
}

export function serializeAdminProvisionalRateCardSimulation(result: ProvisionalRateCardSimulationResult) {
  return {
    status: result.status,
    blocker_code: result.blockerCode,
    seller_safe_quote: result.sellerSafeQuote
      ? {
        service_tier: result.sellerSafeQuote.serviceTier,
        price_estimate: result.sellerSafeQuote.priceEstimate,
        currency: result.sellerSafeQuote.currency,
        weight_slab: result.sellerSafeQuote.weightSlab,
        zone_label: result.sellerSafeQuote.zoneLabel,
        group_label: result.sellerSafeQuote.groupLabel
      }
      : null,
    admin_diagnostics: {
      source_type: result.adminDiagnostics.sourceType,
      status: result.adminDiagnostics.status,
      official: result.adminDiagnostics.official,
      settlement_allowed: result.adminDiagnostics.settlementAllowed,
      reconciliation_allowed: result.adminDiagnostics.reconciliationAllowed,
      public_seller_visible: result.adminDiagnostics.publicSellerVisible,
      lane_code: result.adminDiagnostics.laneCode,
      charge_components: result.adminDiagnostics.chargeComponents,
      warnings: result.adminDiagnostics.warnings
    }
  };
}

export function serializeSellerSafeProvisionalQuote(result: ProvisionalRateCardSimulationResult) {
  return {
    status: result.status,
    blocker_code: result.blockerCode ? "QUOTE_NOT_PUBLICLY_AVAILABLE" : null,
    quote: result.sellerSafeQuote
      ? {
        service_tier: result.sellerSafeQuote.serviceTier,
        price_estimate: result.sellerSafeQuote.priceEstimate,
        currency: result.sellerSafeQuote.currency,
        weight_slab: result.sellerSafeQuote.weightSlab,
        zone_label: result.sellerSafeQuote.zoneLabel,
        group_label: result.sellerSafeQuote.groupLabel
      }
      : null
  };
}
