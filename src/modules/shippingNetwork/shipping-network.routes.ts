import { Router } from "express";
import { cancelShipmentSchema, createPickupLocationSchema, createShipmentSchema, manifestShipmentSchema } from "./shipping-validation.js";
import { successEnvelope } from "./shipping-public-serializers.js";
import { createShippingPickupLocation, listShippingPickupLocations } from "./shipping-pickup-location.service.js";
import { createShipmentDraft, getShipmentDetails } from "./shipping-shipments.service.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { manifestShipment } from "./shipping-manifest.service.js";
import { fetchShipmentTracking } from "./shipping-tracking.service.js";
import { cancelShipment } from "./shipping-cancel.service.js";

export const shippingNetworkRouter = Router();

shippingNetworkRouter.post("/pickup-locations", async (req, res) => {
  const body = createPickupLocationSchema.parse(req.body);
  const data = await createShippingPickupLocation(req.auth!.merchantId, body);

  return res.status(201).json(successEnvelope("Pickup location created successfully.", {
    pickup_location_id: data.pickup_location_id,
    status: data.status,
    courier_network: data.courier_network
  }));
});

shippingNetworkRouter.get("/pickup-locations", async (req, res) => {
  const data = await listShippingPickupLocations(req.auth!.merchantId);
  return res.json(successEnvelope("Pickup locations fetched successfully.", { pickup_locations: data }));
});

shippingNetworkRouter.post("/shipments", async (req, res) => {
  const body = createShipmentSchema.parse(req.body);
  const data = await createShipmentDraft(req.auth!.merchantId, body);

  return res.status(201).json(successEnvelope("Shipment draft created successfully.", {
    shipment_id: data.shipment_id,
    seller_order_id: data.seller_order_id,
    status: data.status,
    segment: data.segment,
    payment_mode: data.payment_mode
  }));
});

shippingNetworkRouter.get("/shipments/:shipmentId", async (req, res) => {
  const data = await getShipmentDetails(req.auth!.merchantId, req.params.shipmentId);
  return res.json(successEnvelope("Shipment fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/rates", async (req, res) => {
  const data = await fetchShipmentRates(req.auth!.merchantId, req.params.shipmentId);
  return res.json(successEnvelope("Rates fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/manifest", async (req, res) => {
  const body = manifestShipmentSchema.parse(req.body);
  const data = await manifestShipment(req.auth!.merchantId, req.params.shipmentId, body.rate_id);
  return res.json(successEnvelope("Shipment manifested successfully.", data));
});

shippingNetworkRouter.get("/shipments/:shipmentId/tracking", async (req, res) => {
  const data = await fetchShipmentTracking(req.auth!.merchantId, req.params.shipmentId);
  return res.json(successEnvelope("Tracking fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cancel", async (req, res) => {
  const body = cancelShipmentSchema.parse(req.body);
  const data = await cancelShipment(req.auth!.merchantId, req.params.shipmentId, body.reason);
  return res.json(successEnvelope("Shipment cancelled successfully.", data));
});
