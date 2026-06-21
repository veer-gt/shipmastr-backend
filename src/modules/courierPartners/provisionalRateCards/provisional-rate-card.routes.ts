import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  approveInternalProvisionalRateCard,
  archiveProvisionalRateCard,
  getCommercialRateCardGroup,
  getProvisionalRateCardReview,
  importProvisionalRateCard,
  listCommercialRateCardGroups,
  listProvisionalRateCardReviews,
  listShipmastrOutcomeTiers,
  previewProvisionalRateCardImport,
  rejectProvisionalRateCard,
  sampleProvisionalRateCardImport,
  simulateProvisionalRateCard
} from "./provisional-rate-card.service.js";
import {
  serializeCommercialRateCardGroup,
  serializeAdminProvisionalRateCardImportPreview,
  serializeAdminProvisionalRateCardReview,
  serializeAdminProvisionalRateCardSimulation,
  serializeShipmastrOutcomeTier
} from "./provisional-rate-card.serializer.js";
import {
  provisionalRateCardImportSchema,
  provisionalRateCardReviewActionSchema,
  provisionalRateCardSimulationSchema
} from "./provisional-rate-card.validation.js";

export const adminRateCardGroupsRouter = Router();
export const adminRateCardTiersRouter = Router();
export const adminProvisionalRateCardsRouter = Router();

adminRateCardGroupsRouter.get("/", (_req, res) => res.json(successEnvelope(
  "Commercial rate card groups fetched safely.",
  { groups: listCommercialRateCardGroups().map(serializeCommercialRateCardGroup) }
)));

adminRateCardGroupsRouter.get("/:groupCode", (req, res) => res.json(successEnvelope(
  "Commercial rate card group fetched safely.",
  { group: serializeCommercialRateCardGroup(getCommercialRateCardGroup(req.params.groupCode)) }
)));

adminRateCardTiersRouter.get("/", (_req, res) => res.json(successEnvelope(
  "Shipmastr outcome tiers fetched safely.",
  { tiers: listShipmastrOutcomeTiers().map(serializeShipmastrOutcomeTier) }
)));

adminProvisionalRateCardsRouter.get("/", (_req, res) => res.json(successEnvelope(
  "Provisional rate cards fetched safely.",
  {
    rate_cards: listProvisionalRateCardReviews().map(serializeAdminProvisionalRateCardReview),
    official_rate_claim: false,
    settlement_allowed: false,
    reconciliation_allowed: false,
    live_provider_call_performed: false
  }
)));

adminProvisionalRateCardsRouter.get("/sample-template", (_req, res) => res.json(successEnvelope(
  "Safe provisional rate card import template fetched.",
  {
    template: sampleProvisionalRateCardImport(),
    official_rate_claim: false,
    settlement_allowed: false,
    reconciliation_allowed: false
  }
)));

adminProvisionalRateCardsRouter.post("/import-preview", (req, res) => {
  const template = provisionalRateCardImportSchema.parse(req.body ?? {});
  const preview = previewProvisionalRateCardImport(template, req.auth?.userId ?? null);
  res.json(successEnvelope(
    "Provisional rate card import preview completed safely.",
    { preview: serializeAdminProvisionalRateCardImportPreview(preview) }
  ));
});

adminProvisionalRateCardsRouter.post("/import", (req, res) => {
  const template = provisionalRateCardImportSchema.parse(req.body ?? {});
  const card = importProvisionalRateCard(template, req.auth?.userId ?? null);
  res.status(201).json(successEnvelope(
    "Provisional rate card imported for admin review.",
    {
      rate_card: serializeAdminProvisionalRateCardReview(card),
      mutation_performed: true,
      official_rate_claim: false,
      settlement_allowed: false,
      reconciliation_allowed: false,
      live_provider_call_performed: false
    }
  ));
});

adminProvisionalRateCardsRouter.get("/:id", (req, res) => res.json(successEnvelope(
  "Provisional rate card fetched safely.",
  { rate_card: serializeAdminProvisionalRateCardReview(getProvisionalRateCardReview(req.params.id)) }
)));

adminProvisionalRateCardsRouter.post("/:id/simulate", (req, res) => {
  const body = provisionalRateCardSimulationSchema.parse(req.body ?? {});
  const simulation = simulateProvisionalRateCard(req.params.id, {
    outcomeCode: body.outcome_code,
    zoneCode: body.zone_code,
    weightKg: body.weight_kg,
    sellerFacing: body.seller_facing
  });
  res.json(successEnvelope(
    "Provisional rate card simulation completed safely.",
    {
      simulation: serializeAdminProvisionalRateCardSimulation(simulation),
      mutation_performed: false,
      live_provider_call_performed: false
    }
  ));
});

adminProvisionalRateCardsRouter.post("/:id/approve-internal", (req, res) => {
  provisionalRateCardReviewActionSchema.parse(req.body ?? {});
  const card = approveInternalProvisionalRateCard(req.params.id, req.auth?.userId ?? null);
  res.json(successEnvelope(
    "Provisional rate card approved for internal benchmark review only.",
    {
      rate_card: serializeAdminProvisionalRateCardReview(card),
      official_rate_claim: false,
      settlement_allowed: false,
      reconciliation_allowed: false,
      public_seller_visible: false
    }
  ));
});

adminProvisionalRateCardsRouter.post("/:id/reject", (req, res) => {
  const body = provisionalRateCardReviewActionSchema.parse(req.body ?? {});
  const card = rejectProvisionalRateCard(req.params.id, req.auth?.userId ?? null, body.reason || body.note || null);
  res.json(successEnvelope(
    "Provisional rate card rejected safely.",
    { rate_card: serializeAdminProvisionalRateCardReview(card) }
  ));
});

adminProvisionalRateCardsRouter.post("/:id/archive", (req, res) => {
  const body = provisionalRateCardReviewActionSchema.parse(req.body ?? {});
  const card = archiveProvisionalRateCard(req.params.id, req.auth?.userId ?? null, body.reason || body.note || null);
  res.json(successEnvelope(
    "Provisional rate card archived safely.",
    { rate_card: serializeAdminProvisionalRateCardReview(card) }
  ));
});
