import { Router } from "express";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getCommercialRateCardGroup,
  listCommercialRateCardGroups,
  listShipmastrOutcomeTiers
} from "./provisional-rate-card.service.js";
import {
  serializeCommercialRateCardGroup,
  serializeShipmastrOutcomeTier
} from "./provisional-rate-card.serializer.js";

export const adminRateCardGroupsRouter = Router();
export const adminRateCardTiersRouter = Router();

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
