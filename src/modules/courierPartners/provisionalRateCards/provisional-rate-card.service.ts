import { createHash } from "node:crypto";
import { HttpError } from "../../../lib/httpError.js";
import {
  commercialRateCardGroups,
  isReviewPast,
  normalizeCommercialGroupCode,
  normalizeOutcomeTierCode,
  normalizeProvisionalRateCardDefinition,
  normalizeRateCardLaneCode,
  normalizeRateCardReviewStatus,
  normalizeRateCardSourceType,
  normalizeRateCardStatus,
  normalizeRateCardZoneCode,
  provisionalRateCardTemplates,
  sampleProvisionalRateCardImportTemplate,
  shipmastrOutcomeTiers
} from "./provisional-rate-card.rules.js";
import type {
  CommercialRateCardGroupCode,
  ProvisionalRateCardDefinition,
  ProvisionalRateCardImportPreview,
  ProvisionalRateCardImportMetadata,
  ProvisionalRateCardReviewRecord,
  ProvisionalRateCardReviewStatus,
  ProvisionalRateCardSimulationInput,
  ProvisionalRateCardSimulationResult,
  ProvisionalRateCardZoneCode,
  ShipmastrOutcomeTierCode
} from "./provisional-rate-card.types.js";

function cloneCard(card: ProvisionalRateCardDefinition) {
  return normalizeProvisionalRateCardDefinition(JSON.parse(JSON.stringify(card)) as ProvisionalRateCardDefinition);
}

function displayNameForTier(outcomeCode: ShipmastrOutcomeTierCode) {
  return shipmastrOutcomeTiers.find((tier) => tier.outcomeCode === outcomeCode)?.displayName ?? "Shipmastr Smart";
}

function displayNameForGroup(groupCode: CommercialRateCardGroupCode) {
  return commercialRateCardGroups.find((group) => group.groupCode === groupCode)?.groupName ?? groupCode;
}

function zoneLabel(zoneCode: ProvisionalRateCardZoneCode) {
  return zoneCode
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

function isoOrNull(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cleanText(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function checksumFor(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function recordFromCard(
  card: ProvisionalRateCardDefinition,
  metadata: Partial<ProvisionalRateCardImportMetadata> = {},
  reviewStatus: ProvisionalRateCardReviewStatus = "DRAFT",
  validationWarnings: string[] = []
): ProvisionalRateCardReviewRecord {
  const normalized = normalizeProvisionalRateCardDefinition(card);
  return {
    ...normalized,
    reviewStatus: normalizeRateCardReviewStatus(reviewStatus),
    validationErrors: [],
    validationWarnings,
    importMetadata: {
      sourceLabel: metadata.sourceLabel ?? null,
      sourceNotes: metadata.sourceNotes ?? null,
      uploadedBy: metadata.uploadedBy ?? null,
      createdBy: metadata.createdBy ?? null,
      importedAt: metadata.importedAt ?? null,
      reviewedBy: metadata.reviewedBy ?? null,
      reviewedAt: metadata.reviewedAt ?? null,
      rejectedBy: metadata.rejectedBy ?? null,
      rejectedAt: metadata.rejectedAt ?? null,
      rejectionReason: metadata.rejectionReason ?? null,
      archivedBy: metadata.archivedBy ?? null,
      archivedAt: metadata.archivedAt ?? null,
      archiveReason: metadata.archiveReason ?? null,
      expiresAt: metadata.expiresAt ?? null,
      originalFileName: metadata.originalFileName ?? null,
      checksum: metadata.checksum ?? null
    }
  };
}

const importedRateCardStore = new Map<string, ProvisionalRateCardReviewRecord>();

function seedImportedRateCardStore() {
  if (importedRateCardStore.size) return;
  for (const template of provisionalRateCardTemplates) {
    importedRateCardStore.set(template.id, recordFromCard(template, {
      sourceLabel: "Phase 61 template",
      sourceNotes: "Template only. No external benchmark values loaded.",
      checksum: checksumFor(template)
    }, "DRAFT", [
      "TEMPLATE_ONLY",
      "NOT_OFFICIAL",
      "NOT_FOR_SETTLEMENT",
      "NOT_FOR_RECONCILIATION",
      "HIDDEN_FROM_SELLERS"
    ]));
  }
}

function cloneReviewRecord(record: ProvisionalRateCardReviewRecord) {
  return recordFromCard(
    JSON.parse(JSON.stringify(record)) as ProvisionalRateCardDefinition,
    JSON.parse(JSON.stringify(record.importMetadata)) as ProvisionalRateCardImportMetadata,
    record.reviewStatus,
    [...record.validationWarnings]
  );
}

function rawArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrDefault(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_NUMBER_INVALID");
  return number;
}

function nullableNonNegative(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new HttpError(400, "PROVISIONAL_RATE_CARD_CHARGE_INVALID");
  return number;
}

function chargeLabel(value: unknown, fallback: "PRIMARY_CHARGE" | "SECONDARY_CHARGE", warnings: string[]) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (!/^[A-Z0-9_ -]{1,40}$/i.test(text)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_CHARGE_LABEL_INVALID");
  const normalized = text.toUpperCase().replace(/\s+/g, "_");
  if (normalized !== fallback) warnings.push("CUSTOM_CHARGE_LABEL_REQUIRES_ADMIN_REVIEW");
  return normalized;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, errorCode: string): T {
  const normalized = String(value ?? fallback).trim().toUpperCase();
  if (!allowed.includes(normalized as T)) throw new HttpError(400, errorCode);
  return normalized as T;
}

function parseImportedDefinition(rawInput: unknown, actorId: string | null, now = new Date()) {
  const raw = rawObject(typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput);
  const warnings: string[] = [
    "BENCHMARK_ONLY_NOT_OFFICIAL",
    "NOT_FOR_SETTLEMENT",
    "NOT_FOR_RECONCILIATION",
    "HIDDEN_FROM_SELLERS"
  ];

  const sourceType = normalizeRateCardSourceType(raw.source_type ?? "MANUAL_BENCHMARK");
  const status = normalizeRateCardStatus(raw.status ?? "BENCHMARK_ONLY");
  const groupCode = normalizeCommercialGroupCode(raw.group_code);

  if (sourceType !== "MANUAL_BENCHMARK") throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_SOURCE_MUST_BE_MANUAL_BENCHMARK");
  if (status === "OFFICIAL_ACTIVE") throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_CANNOT_BE_OFFICIAL_ACTIVE");
  if (raw.official === true) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_CANNOT_BE_OFFICIAL");
  if (raw.settlement_allowed === true) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_SETTLEMENT_BLOCKED");
  if (raw.reconciliation_allowed === true) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_RECONCILIATION_BLOCKED");
  if (raw.public_seller_visible === true) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_SELLER_VISIBILITY_BLOCKED");

  const allowedOutcomeTierCodes = rawArray(raw.allowed_outcome_tiers).map(normalizeOutcomeTierCode);
  if (!allowedOutcomeTierCodes.length) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_OUTCOME_TIER_REQUIRED");

  const providerLaneMappings = rawArray(raw.provider_lane_mappings).map((item) => {
    const mapping = rawObject(item);
    const laneCodes = rawArray(mapping.lane_codes).map(normalizeRateCardLaneCode);
    if (!laneCodes.length) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_LANE_REQUIRED");
    return {
      outcomeCode: normalizeOutcomeTierCode(mapping.outcome_code),
      laneCodes
    };
  });

  const chargeCells = rawArray(raw.charge_cells).map((item, index) => {
    const cell = rawObject(item);
    const minWeightKg = numberOrDefault(cell.min_weight_kg, Number.NaN);
    const maxWeightKg = numberOrDefault(cell.max_weight_kg, Number.NaN);
    const slabOrder = Math.trunc(numberOrDefault(cell.slab_order, index + 1));
    if (!Number.isFinite(minWeightKg) || minWeightKg < 0) throw new HttpError(400, "PROVISIONAL_RATE_CARD_WEIGHT_SLAB_INVALID");
    if (!Number.isFinite(maxWeightKg) || maxWeightKg <= 0 || maxWeightKg < minWeightKg) throw new HttpError(400, "PROVISIONAL_RATE_CARD_WEIGHT_SLAB_INVALID");
    if (slabOrder <= 0) throw new HttpError(400, "PROVISIONAL_RATE_CARD_WEIGHT_SLAB_INVALID");

    const chargeAAmount = nullableNonNegative(cell.charge_a_amount);
    const chargeBAmount = nullableNonNegative(cell.charge_b_amount);
    const codChargeA = nullableNonNegative(cell.cod_charge_a);
    const codChargeB = nullableNonNegative(cell.cod_charge_b);
    const volumetricDivisor = numberOrDefault(cell.volumetric_divisor, 5000);
    const rtoPercentage = numberOrDefault(cell.rto_percentage, 0);
    const gstPercent = cell.gst_percent === null || cell.gst_percent === undefined || cell.gst_percent === ""
      ? null
      : numberOrDefault(cell.gst_percent, 0);

    if (volumetricDivisor <= 0) throw new HttpError(400, "PROVISIONAL_RATE_CARD_VOLUMETRIC_DIVISOR_INVALID");
    if (rtoPercentage < 0) throw new HttpError(400, "PROVISIONAL_RATE_CARD_RTO_PERCENTAGE_INVALID");
    if (gstPercent !== null && gstPercent < 0) throw new HttpError(400, "PROVISIONAL_RATE_CARD_GST_INVALID");

    return {
      laneCode: normalizeRateCardLaneCode(cell.lane_code),
      outcomeCode: normalizeOutcomeTierCode(cell.outcome_code),
      zoneCode: normalizeRateCardZoneCode(cell.zone_code),
      weightSlab: {
        minWeightKg,
        maxWeightKg,
        slabOrder,
        packageType: oneOf(cell.package_type, ["ANY", "DOCUMENT", "PARCEL"] as const, "ANY", "PROVISIONAL_RATE_CARD_PACKAGE_TYPE_INVALID"),
        active: cell.active !== false
      },
      chargeAAmount,
      chargeBAmount,
      chargeALabel: chargeLabel(cell.charge_a_label, "PRIMARY_CHARGE", warnings),
      chargeBLabel: chargeLabel(cell.charge_b_label, "SECONDARY_CHARGE", warnings),
      codChargeA,
      codChargeB,
      codChargePolicy: oneOf(
        cell.cod_charge_policy,
        ["NOT_CONFIGURED", "COMPONENTS_ONLY"] as const,
        "COMPONENTS_ONLY",
        "PROVISIONAL_RATE_CARD_COD_POLICY_INVALID"
      ),
      volumetricDivisor,
      rtoPercentage,
      currency: "INR" as const,
      gstTaxHandling: {
        status: oneOf(
          cell.gst_status,
          ["NOT_CONFIGURED", "INCLUSIVE", "EXCLUSIVE", "REVIEW_REQUIRED"] as const,
          "REVIEW_REQUIRED",
          "PROVISIONAL_RATE_CARD_GST_STATUS_INVALID"
        ),
        gstPercent
      },
      notes: rawArray(cell.notes).map((note) => String(note).slice(0, 300))
    };
  });

  if (!providerLaneMappings.length) throw new HttpError(400, "PROVISIONAL_RATE_CARD_IMPORT_LANE_MAPPING_REQUIRED");
  if (!chargeCells.length) warnings.push("PROVISIONAL_RATE_CARD_IMPORT_HAS_NO_CHARGE_CELLS");

  const expiresAt = isoOrNull(raw.expires_at);
  const reviewBy = isoOrNull(raw.review_by);
  const checksum = checksumFor(raw);
  const id = cleanText(raw.id, 80) ?? `provisional-${checksum.slice(0, 12)}`;
  const card: ProvisionalRateCardDefinition = {
    id,
    name: cleanText(raw.name, 120) ?? `${groupCode} Provisional Benchmark`,
    groupCode,
    sourceType,
    status: "BENCHMARK_ONLY",
    official: false,
    officialContractRef: null,
    settlementAllowed: false,
    reconciliationAllowed: false,
    publicSellerVisible: false,
    effectiveFrom: isoOrNull(raw.effective_from),
    effectiveTo: expiresAt,
    reviewBy,
    allowedOutcomeTierCodes,
    providerLaneMappings,
    chargeCells,
    internalNotes: rawArray(raw.internal_notes).map((note) => String(note).slice(0, 300))
  };

  const normalized = normalizeProvisionalRateCardDefinition(card);
  const expired = expiresAt ? new Date(expiresAt).getTime() < now.getTime() : false;
  const reviewPast = isReviewPast(normalized, now);
  if (expired) warnings.push("PROVISIONAL_RATE_CARD_EXPIRED");
  if (reviewPast) warnings.push("PROVISIONAL_RATE_CARD_REVIEW_PAST");

  return recordFromCard(normalized, {
    sourceLabel: cleanText(raw.source_label, 160),
    sourceNotes: cleanText(raw.source_notes, 1000),
    uploadedBy: actorId,
    createdBy: actorId,
    importedAt: now.toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    archivedBy: null,
    archivedAt: null,
    archiveReason: null,
    expiresAt,
    originalFileName: cleanText(raw.original_file_name, 180),
    checksum
  }, expired ? "EXPIRED" : "READY_FOR_REVIEW", warnings);
}

export function listCommercialRateCardGroups() {
  return commercialRateCardGroups.map((group) => ({
    ...group,
    defaultOutcomeTierCodes: [...group.defaultOutcomeTierCodes],
    internalNotes: [...group.internalNotes],
    marginPolicy: { ...group.marginPolicy }
  }));
}

export function getCommercialRateCardGroup(groupCode: string) {
  const normalized = normalizeCommercialGroupCode(groupCode);
  const group = listCommercialRateCardGroups().find((item) => item.groupCode === normalized);
  if (!group) throw new HttpError(404, "PROVISIONAL_RATE_CARD_GROUP_NOT_FOUND");
  return group;
}

export function listShipmastrOutcomeTiers() {
  return shipmastrOutcomeTiers.map((tier) => ({
    ...tier,
    eligibilityRules: { ...tier.eligibilityRules }
  }));
}

export function listProvisionalRateCards() {
  return provisionalRateCardTemplates.map(cloneCard);
}

export function getProvisionalRateCard(id: string) {
  seedImportedRateCardStore();
  const imported = importedRateCardStore.get(id);
  if (imported) return cloneCard(imported);
  const card = provisionalRateCardTemplates.find((item) => item.id === id);
  if (!card) throw new HttpError(404, "PROVISIONAL_RATE_CARD_NOT_FOUND");
  return cloneCard(card);
}

export function normalizeProvisionalRateCard(card: ProvisionalRateCardDefinition) {
  return normalizeProvisionalRateCardDefinition(card);
}

export function sampleProvisionalRateCardImport() {
  return JSON.parse(JSON.stringify(sampleProvisionalRateCardImportTemplate));
}

export function listProvisionalRateCardReviews() {
  seedImportedRateCardStore();
  return [...importedRateCardStore.values()].map(cloneReviewRecord);
}

export function getProvisionalRateCardReview(id: string) {
  seedImportedRateCardStore();
  const record = importedRateCardStore.get(id);
  if (!record) throw new HttpError(404, "PROVISIONAL_RATE_CARD_NOT_FOUND");
  return cloneReviewRecord(record);
}

export function previewProvisionalRateCardImport(
  payload: unknown,
  actorId: string | null = null,
  now = new Date()
): ProvisionalRateCardImportPreview {
  const checksum = checksumFor(payload ?? {});
  try {
    const card = parseImportedDefinition(payload, actorId, now);
    return {
      previewId: `preview-${checksum.slice(0, 12)}`,
      valid: true,
      errors: [],
      warnings: card.validationWarnings,
      mutationPerformed: false,
      liveProviderCallPerformed: false,
      officialRateClaim: false,
      settlementAllowed: false,
      reconciliationAllowed: false,
      publicSellerVisible: false,
      checksum,
      card
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "PROVISIONAL_RATE_CARD_IMPORT_INVALID";
    return {
      previewId: `preview-${checksum.slice(0, 12)}`,
      valid: false,
      errors: [message],
      warnings: ["IMPORT_PREVIEW_ONLY", "NO_MUTATION_PERFORMED"],
      mutationPerformed: false,
      liveProviderCallPerformed: false,
      officialRateClaim: false,
      settlementAllowed: false,
      reconciliationAllowed: false,
      publicSellerVisible: false,
      checksum,
      card: null
    };
  }
}

export function importProvisionalRateCard(payload: unknown, actorId: string | null = null, now = new Date()) {
  seedImportedRateCardStore();
  const preview = previewProvisionalRateCardImport(payload, actorId, now);
  if (!preview.valid || !preview.card) {
    throw new HttpError(400, preview.errors[0] ?? "PROVISIONAL_RATE_CARD_IMPORT_INVALID");
  }

  const record = {
    ...preview.card,
    reviewStatus: preview.card.reviewStatus === "EXPIRED" ? "EXPIRED" as const : "IMPORTED" as const
  };
  importedRateCardStore.set(record.id, record);
  return cloneReviewRecord(record);
}

export function approveInternalProvisionalRateCard(id: string, actorId: string | null = null, now = new Date()) {
  seedImportedRateCardStore();
  const existing = getProvisionalRateCardReview(id);
  if (existing.reviewStatus === "ARCHIVED") throw new HttpError(409, "PROVISIONAL_RATE_CARD_ARCHIVED");
  if (existing.reviewStatus === "REJECTED") throw new HttpError(409, "PROVISIONAL_RATE_CARD_REJECTED");
  if (existing.reviewStatus === "EXPIRED" || isReviewPast(existing, now)) throw new HttpError(409, "PROVISIONAL_RATE_CARD_EXPIRED");
  const next = recordFromCard({
    ...existing,
    status: "ACTIVE_INTERNAL",
    official: false,
    officialContractRef: null,
    settlementAllowed: false,
    reconciliationAllowed: false,
    publicSellerVisible: false
  }, {
    ...existing.importMetadata,
    reviewedBy: actorId,
    reviewedAt: now.toISOString()
  }, "APPROVED_INTERNAL", [
    ...existing.validationWarnings,
    "APPROVED_INTERNAL_NOT_OFFICIAL",
    "SETTLEMENT_STILL_BLOCKED",
    "RECONCILIATION_STILL_BLOCKED"
  ]);
  importedRateCardStore.set(id, next);
  return cloneReviewRecord(next);
}

export function rejectProvisionalRateCard(id: string, actorId: string | null = null, reason: string | null = null, now = new Date()) {
  seedImportedRateCardStore();
  const existing = getProvisionalRateCardReview(id);
  const rejectionReason = cleanText(reason, 500);
  if (!rejectionReason) throw new HttpError(400, "PROVISIONAL_RATE_CARD_REJECTION_REASON_REQUIRED");
  if (existing.reviewStatus === "ARCHIVED") throw new HttpError(409, "PROVISIONAL_RATE_CARD_ARCHIVED");
  const next = recordFromCard(existing, {
    ...existing.importMetadata,
    rejectedBy: actorId,
    rejectedAt: now.toISOString(),
    rejectionReason
  }, "REJECTED", [
    ...existing.validationWarnings,
    `REJECTED: ${rejectionReason.slice(0, 160)}`
  ]);
  importedRateCardStore.set(id, next);
  return cloneReviewRecord(next);
}

export function archiveProvisionalRateCard(id: string, actorId: string | null = null, reason: string | null = null, now = new Date()) {
  seedImportedRateCardStore();
  const existing = getProvisionalRateCardReview(id);
  const archiveReason = cleanText(reason, 500);
  if (!archiveReason) throw new HttpError(400, "PROVISIONAL_RATE_CARD_ARCHIVE_REASON_REQUIRED");
  const next = recordFromCard({
    ...existing,
    status: "ARCHIVED"
  }, {
    ...existing.importMetadata,
    archivedBy: actorId,
    archivedAt: now.toISOString(),
    archiveReason
  }, "ARCHIVED", [
    ...existing.validationWarnings,
    "ARCHIVED_NOT_ACTIVE",
    `ARCHIVED: ${archiveReason.slice(0, 160)}`
  ]);
  importedRateCardStore.set(id, next);
  return cloneReviewRecord(next);
}

export function resetProvisionalRateCardReviewStoreForTests() {
  importedRateCardStore.clear();
}

function matchingChargeCell(card: ProvisionalRateCardDefinition, input: ProvisionalRateCardSimulationInput) {
  return card.chargeCells.find((cell) => (
    cell.outcomeCode === input.outcomeCode &&
    cell.zoneCode === input.zoneCode &&
    cell.weightSlab.active &&
    input.weightKg >= cell.weightSlab.minWeightKg &&
    input.weightKg <= cell.weightSlab.maxWeightKg
  )) ?? null;
}

export function simulateProvisionalRateCard(
  id: string,
  input: ProvisionalRateCardSimulationInput,
  now = new Date()
): ProvisionalRateCardSimulationResult {
  let reviewStatus: ProvisionalRateCardReviewStatus | null = null;
  let card: ProvisionalRateCardDefinition;
  try {
    const reviewRecord = getProvisionalRateCardReview(id);
    reviewStatus = reviewRecord.reviewStatus;
    card = reviewRecord;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      card = getProvisionalRateCard(id);
    } else {
      throw error;
    }
  }
  const outcomeCode = normalizeOutcomeTierCode(input.outcomeCode);
  const zoneCode = normalizeRateCardZoneCode(input.zoneCode);

  if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) {
    throw new HttpError(400, "PROVISIONAL_RATE_CARD_WEIGHT_INVALID");
  }

  const warnings = [
    ...(isReviewPast(card, now) ? ["PROVISIONAL_RATE_CARD_REVIEW_PAST"] : []),
    ...(card.sourceType === "MANUAL_BENCHMARK" ? ["MANUAL_BENCHMARK_NOT_OFFICIAL"] : []),
    ...(card.settlementAllowed ? [] : ["SETTLEMENT_BLOCKED"]),
    ...(card.reconciliationAllowed ? [] : ["RECONCILIATION_BLOCKED"])
  ];

  const closedBlocker = reviewStatus === "REJECTED"
    ? "PROVISIONAL_RATE_CARD_REJECTED"
    : reviewStatus === "ARCHIVED"
      ? "PROVISIONAL_RATE_CARD_ARCHIVED"
      : reviewStatus === "EXPIRED" || card.status === "EXPIRED"
        ? "PROVISIONAL_RATE_CARD_EXPIRED"
        : isReviewPast(card, now)
          ? "PROVISIONAL_RATE_CARD_REVIEW_PAST"
          : null;

  if (closedBlocker) {
    return {
      status: "BLOCKED",
      blockerCode: closedBlocker,
      sellerSafeQuote: null,
      adminDiagnostics: {
        sourceType: card.sourceType,
        status: card.status,
        official: card.official,
        settlementAllowed: card.settlementAllowed,
        reconciliationAllowed: card.reconciliationAllowed,
        publicSellerVisible: card.publicSellerVisible,
        laneCode: null,
        chargeComponents: null,
        warnings: [...warnings, closedBlocker]
      }
    };
  }

  const blockedForSeller = input.sellerFacing === true
    && card.publicSellerVisible === false;

  if (blockedForSeller) {
    return {
      status: "BLOCKED",
      blockerCode: "BENCHMARK_ONLY_NOT_PUBLIC_SELLER_VISIBLE",
      sellerSafeQuote: null,
      adminDiagnostics: {
        sourceType: card.sourceType,
        status: card.status,
        official: card.official,
        settlementAllowed: card.settlementAllowed,
        reconciliationAllowed: card.reconciliationAllowed,
        publicSellerVisible: card.publicSellerVisible,
        laneCode: null,
        chargeComponents: null,
        warnings
      }
    };
  }

  const cell = matchingChargeCell(card, { ...input, outcomeCode, zoneCode });
  if (!cell) {
    return {
      status: "NO_MATCH",
      blockerCode: "PROVISIONAL_RATE_CARD_CELL_NOT_CONFIGURED",
      sellerSafeQuote: null,
      adminDiagnostics: {
        sourceType: card.sourceType,
        status: card.status,
        official: card.official,
        settlementAllowed: card.settlementAllowed,
        reconciliationAllowed: card.reconciliationAllowed,
        publicSellerVisible: card.publicSellerVisible,
        laneCode: null,
        chargeComponents: null,
        warnings
      }
    };
  }

  return {
    status: "SIMULATED",
    blockerCode: null,
    sellerSafeQuote: card.publicSellerVisible ? {
      serviceTier: displayNameForTier(outcomeCode),
      priceEstimate: null,
      currency: "INR",
      weightSlab: `${cell.weightSlab.minWeightKg}-${cell.weightSlab.maxWeightKg} kg`,
      zoneLabel: zoneLabel(zoneCode),
      groupLabel: displayNameForGroup(card.groupCode)
    } : null,
    adminDiagnostics: {
      sourceType: card.sourceType,
      status: card.status,
      official: card.official,
      settlementAllowed: card.settlementAllowed,
      reconciliationAllowed: card.reconciliationAllowed,
      publicSellerVisible: card.publicSellerVisible,
      laneCode: cell.laneCode,
      chargeComponents: {
        chargeALabel: cell.chargeALabel,
        chargeAAmount: cell.chargeAAmount,
        chargeBLabel: cell.chargeBLabel,
        chargeBAmount: cell.chargeBAmount,
        codChargeA: cell.codChargeA,
        codChargeB: cell.codChargeB,
        codChargePolicy: cell.codChargePolicy
      },
      warnings
    }
  };
}
