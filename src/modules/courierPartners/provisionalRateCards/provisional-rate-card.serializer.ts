import type {
  CommercialRateCardGroup,
  ProvisionalRateCardDefinition,
  ProvisionalRateCardImportPreview,
  ProvisionalRateCardReviewRecord,
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

export function serializeAdminProvisionalRateCardReview(card: ProvisionalRateCardReviewRecord) {
  return {
    ...serializeAdminProvisionalRateCard(card),
    review_status: card.reviewStatus,
    validation_errors: card.validationErrors,
    validation_warnings: card.validationWarnings,
    import_metadata: {
      source_label: card.importMetadata.sourceLabel,
      source_notes: card.importMetadata.sourceNotes,
      uploaded_by: card.importMetadata.uploadedBy ? "configured" : null,
      created_by: card.importMetadata.createdBy ? "configured" : null,
      imported_at: card.importMetadata.importedAt,
      reviewed_by: card.importMetadata.reviewedBy ? "configured" : null,
      reviewed_at: card.importMetadata.reviewedAt,
      rejected_by: card.importMetadata.rejectedBy ? "configured" : null,
      rejected_at: card.importMetadata.rejectedAt,
      rejection_reason_configured: Boolean(card.importMetadata.rejectionReason),
      archived_by: card.importMetadata.archivedBy ? "configured" : null,
      archived_at: card.importMetadata.archivedAt,
      archive_reason_configured: Boolean(card.importMetadata.archiveReason),
      expires_at: card.importMetadata.expiresAt,
      original_file_name: card.importMetadata.originalFileName,
      checksum_configured: Boolean(card.importMetadata.checksum)
    },
    charge_cells: card.chargeCells.map((cell) => ({
      lane_code: cell.laneCode,
      outcome_code: cell.outcomeCode,
      zone_code: cell.zoneCode,
      weight_slab: {
        min_weight_kg: cell.weightSlab.minWeightKg,
        max_weight_kg: cell.weightSlab.maxWeightKg,
        slab_order: cell.weightSlab.slabOrder,
        package_type: cell.weightSlab.packageType,
        active: cell.weightSlab.active
      },
      charge_components: {
        charge_a_label: cell.chargeALabel,
        charge_a_amount: cell.chargeAAmount,
        charge_b_label: cell.chargeBLabel,
        charge_b_amount: cell.chargeBAmount,
        cod_charge_a: cell.codChargeA,
        cod_charge_b: cell.codChargeB,
        cod_charge_policy: cell.codChargePolicy,
        volumetric_divisor: cell.volumetricDivisor,
        rto_percentage: cell.rtoPercentage,
        currency: cell.currency,
        gst_tax_handling: {
          status: cell.gstTaxHandling.status,
          gst_percent: cell.gstTaxHandling.gstPercent
        }
      },
      notes: cell.notes
    })),
    benchmark_only: card.sourceType === "MANUAL_BENCHMARK",
    official_rate_claim: false,
    mutation_performed: false,
    live_provider_call_performed: false
  };
}

export function serializeAdminProvisionalRateCardImportPreview(preview: ProvisionalRateCardImportPreview) {
  return {
    preview_id: preview.previewId,
    valid: preview.valid,
    errors: preview.errors,
    warnings: preview.warnings,
    mutation_performed: preview.mutationPerformed,
    live_provider_call_performed: preview.liveProviderCallPerformed,
    official_rate_claim: preview.officialRateClaim,
    settlement_allowed: preview.settlementAllowed,
    reconciliation_allowed: preview.reconciliationAllowed,
    public_seller_visible: preview.publicSellerVisible,
    checksum_configured: Boolean(preview.checksum),
    card: preview.card ? serializeAdminProvisionalRateCardReview(preview.card) : null
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
