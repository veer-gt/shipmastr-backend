import { Router, type Response } from "express";
import multer from "multer";
import {
  cancelShipmentSchema,
  createPickupLocationSchema,
  createShippingOrderSchema,
  createShipmentFromOrderSchema,
  createShipmentSchema,
  listShippingOrdersQuerySchema,
  listShipmentsQuerySchema,
  manifestShipmentSchema,
  updatePickupLocationSchema
} from "./shipping-validation.js";
import { successEnvelope } from "./shipping-public-serializers.js";
import { createShippingPickupLocation, listShippingPickupLocations } from "./shipping-pickup-location.service.js";
import { deleteShippingPickupLocation, updateShippingPickupLocation } from "./shipping-pickup-crud.service.js";
import { createShipmentDraft, getShipmentDetails } from "./shipping-shipments.service.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { manifestShipment } from "./shipping-manifest.service.js";
import { fetchShipmentTracking } from "./shipping-tracking.service.js";
import { cancelShipment } from "./shipping-cancel.service.js";
import { listShippingShipments } from "./shipping-list.service.js";
import { createShipmentFromOrder } from "./shipping-order-bridge.service.js";
import {
  cancelShippingOrder,
  createShippingOrder,
  getShippingOrder,
  importShippingOrdersCsv,
  listShippingOrders,
  ShippingValidationError,
  summarizeShippingOrders,
  updateShippingOrder
} from "./shipping-order-ingestion.service.js";

export const shippingNetworkRouter = Router();
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
});

function sendValidationError(res: Response, error: ShippingValidationError) {
  return res.status(400).json({
    error: "VALIDATION_ERROR",
    message: error.message,
    fields: error.fields
  });
}

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

shippingNetworkRouter.put("/pickup-locations/:id", async (req, res) => {
  const body = updatePickupLocationSchema.parse(req.body);
  const data = await updateShippingPickupLocation(req.auth!.merchantId, req.params.id, body);
  return res.json(successEnvelope("Pickup location updated successfully.", data));
});

shippingNetworkRouter.delete("/pickup-locations/:id", async (req, res) => {
  const data = await deleteShippingPickupLocation(req.auth!.merchantId, req.params.id);
  return res.json(successEnvelope("Pickup location deleted successfully.", data));
});

shippingNetworkRouter.post("/orders", async (req, res) => {
  const body = createShippingOrderSchema.parse(req.body);
  try {
    const data = await createShippingOrder(req.auth!.merchantId, body);
    return res.status(201).json(successEnvelope("Order created successfully.", { order: data }));
  } catch (error) {
    if (error instanceof ShippingValidationError) return sendValidationError(res, error);
    throw error;
  }
});

shippingNetworkRouter.post("/orders/import/csv", csvUpload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: "CSV file is required.", fields: [{ field: "file", message: "CSV file is required." }] });
  }
  const data = await importShippingOrdersCsv({
    merchantId: req.auth!.merchantId,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    buffer: req.file.buffer,
    pickupLocationId: typeof req.body.pickupLocationId === "string" ? req.body.pickupLocationId : undefined
  });
  return res.status(201).json(data);
});

shippingNetworkRouter.get("/orders/summary", async (req, res) => {
  const data = await summarizeShippingOrders(req.auth!.merchantId);
  return res.json(successEnvelope("Order summary fetched successfully.", data));
});

shippingNetworkRouter.get("/orders", async (req, res) => {
  const query = listShippingOrdersQuerySchema.parse(req.query);
  const data = await listShippingOrders(req.auth!.merchantId, query);
  return res.json(successEnvelope("Orders fetched successfully.", data));
});

shippingNetworkRouter.get("/orders/:id", async (req, res) => {
  const data = await getShippingOrder(req.auth!.merchantId, req.params.id);
  return res.json(successEnvelope("Order fetched successfully.", { order: data }));
});

shippingNetworkRouter.put("/orders/:id", async (req, res) => {
  const body = createShippingOrderSchema.partial().parse(req.body);
  try {
    const data = await updateShippingOrder(req.auth!.merchantId, req.params.id, body);
    return res.json(successEnvelope("Order updated successfully.", { order: data }));
  } catch (error) {
    if (error instanceof ShippingValidationError) return sendValidationError(res, error);
    throw error;
  }
});

shippingNetworkRouter.delete("/orders/:id", async (req, res) => {
  const data = await cancelShippingOrder(req.auth!.merchantId, req.params.id);
  return res.json(successEnvelope("Order cancelled successfully.", { order: data }));
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

shippingNetworkRouter.get("/shipments", async (req, res) => {
  const query = listShipmentsQuerySchema.parse(req.query);
  const data = await listShippingShipments(req.auth!.merchantId, query);
  return res.json(successEnvelope("Shipments fetched successfully.", data));
});

shippingNetworkRouter.post("/orders/:orderId/create-shipment", async (req, res) => {
  const body = createShipmentFromOrderSchema.parse(req.body);
  const result = await createShipmentFromOrder(req.auth!.merchantId, req.params.orderId, body);
  return res.status(result.existed ? 200 : 201).json(successEnvelope(
    result.existed ? "Shipment draft already exists for this order." : "Shipment draft created from order successfully.",
    result.shipment
  ));
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
