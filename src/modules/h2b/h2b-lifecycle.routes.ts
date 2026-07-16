import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  createH2BEndpoint,
  getH2BEndpointStatus,
  revokeH2BEndpoint,
  rotateH2BEndpoint
} from "./h2b-endpoint.service.js";

export const h2bLifecycleRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

h2bLifecycleRouter.post("/platform-connections/:connectionId/h2b-endpoint", async (req, res) => {
  const data = await createH2BEndpoint(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.status(201).json(successEnvelope("H2B endpoint created safely.", data));
});

h2bLifecycleRouter.get("/platform-connections/:connectionId/h2b-endpoint", async (req, res) => {
  const data = await getH2BEndpointStatus(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("H2B endpoint status fetched safely.", data));
});

h2bLifecycleRouter.post("/platform-connections/:connectionId/h2b-endpoint/rotate", async (req, res) => {
  const data = await rotateH2BEndpoint(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.status(201).json(successEnvelope("H2B endpoint rotated safely.", data));
});

h2bLifecycleRouter.post("/platform-connections/:connectionId/h2b-endpoint/revoke", async (req, res) => {
  const data = await revokeH2BEndpoint(req.auth!.merchantId, routeParam(req.params.connectionId));
  return res.json(successEnvelope("H2B endpoint revoked safely.", data));
});
