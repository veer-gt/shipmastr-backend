import { Router, type Response } from "express";
import multer from "multer";
import {
  autopilotPreferenceSchema,
  autopilotRecommendSchema,
  bulkRatesSchema,
  bulkShipNowSchema,
  cancelShipmentSchema,
  codLedgerEntrySchema,
  createNdrCaseSchema,
  createPickupLocationSchema,
  createRtoCaseSchema,
  createShippingOrderSchema,
  createShipmentFromOrderSchema,
  createShipmentSchema,
  detectWeightDiscrepancySchema,
  fetchShipmentRatesSchema,
  listCodLedgerQuerySchema,
  listOperationalCasesQuerySchema,
  listShippingOrdersQuerySchema,
  listShipmentsQuerySchema,
  manifestShipmentSchema,
  recordNdrActionSchema,
  resolveNdrCaseSchema,
  slaStatsQuerySchema,
  shipNowSchema,
  updateRtoStatusSchema,
  updateWeightEvidenceSchema,
  weightDisputeStatusSchema,
  updatePickupLocationSchema
} from "./shipping-validation.js";
import { successEnvelope } from "./shipping-public-serializers.js";
import { createShippingPickupLocation, listShippingPickupLocations } from "./shipping-pickup-location.service.js";
import { deleteShippingPickupLocation, updateShippingPickupLocation } from "./shipping-pickup-crud.service.js";
import { createShipmentDraft, getShipmentDetails } from "./shipping-shipments.service.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { manifestShipment } from "./shipping-manifest.service.js";
import { shipNowShipment } from "./shipping-ship-now.service.js";
import { fetchShipmentTracking } from "./shipping-tracking.service.js";
import { cancelShipment } from "./shipping-cancel.service.js";
import { listShippingShipments } from "./shipping-list.service.js";
import { createShipmentFromOrder } from "./shipping-order-bridge.service.js";
import { getAutopilotPreferences, upsertAutopilotPreferences } from "./shipping-autopilot-preferences.service.js";
import { recommendAutopilotForShipment } from "./shipping-autopilot.service.js";
import { getCourierSlaStats } from "./shipping-sla-learning.service.js";
import { bulkFetchRates, bulkShipNow } from "./shipping-bulk.service.js";
import {
  createOrUpdateNdrCaseFromShipment,
  getNdrCase,
  listNdrCases,
  recordNdrAction,
  resolveNdrCase
} from "./shipping-ndr.service.js";
import {
  createOrUpdateRtoCaseFromShipment,
  getRtoCase,
  listRtoCases,
  updateRtoStatus
} from "./shipping-rto.service.js";
import {
  createExpectedCodEntryForCodShipment,
  getCodLedgerSummary,
  listCodLedger,
  recordCodCollected,
  recordCodRemittanceDue,
  recordCodRemitted
} from "./shipping-cod-ledger.service.js";
import {
  closeWeightDispute,
  detectWeightDiscrepancy,
  getWeightDiscrepancyCase,
  listWeightDiscrepancyCases,
  markWeightDisputeSubmitted,
  updateWeightDisputeEvidence
} from "./shipping-weight-dispute.service.js";
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

function operationalQuery(input: unknown) {
  const query = listOperationalCasesQuerySchema.parse(input);
  return {
    ...(query.status ? { status: query.status } : {}),
    page: query.page,
    perPage: query.per_page
  };
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

shippingNetworkRouter.get("/autopilot/preferences", async (req, res) => {
  const data = await getAutopilotPreferences(req.auth!.merchantId);
  return res.json(successEnvelope("Autopilot preferences fetched successfully.", data));
});

shippingNetworkRouter.put("/autopilot/preferences", async (req, res) => {
  const body = autopilotPreferenceSchema.parse(req.body);
  const data = await upsertAutopilotPreferences(req.auth!.merchantId, Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined)
  ));
  return res.json(successEnvelope("Autopilot preferences updated successfully.", data));
});

shippingNetworkRouter.get("/sla/stats", async (req, res) => {
  const query = slaStatsQuerySchema.parse(req.query);
  const data = await getCourierSlaStats(Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined)
  ));
  return res.json(successEnvelope("Courier SLA stats fetched successfully.", data));
});

shippingNetworkRouter.post("/bulk/rates", async (req, res) => {
  const body = bulkRatesSchema.parse(req.body);
  const data = await bulkFetchRates(req.auth!.merchantId, {
    shipmentIds: body.shipmentIds,
    ...(body.refresh === undefined ? {} : { refresh: body.refresh })
  });
  return res.json(successEnvelope("Bulk rates processed successfully.", data));
});

shippingNetworkRouter.post("/bulk/ship-now", async (req, res) => {
  const body = bulkShipNowSchema.parse(req.body);
  const data = await bulkShipNow(req.auth!.merchantId, {
    shipmentIds: body.shipmentIds,
    tier: body.tier,
    ...(body.useAutopilot === undefined ? {} : { useAutopilot: body.useAutopilot }),
    ...(body.acknowledgeProtectionWarnings === undefined ? {} : { acknowledgeProtectionWarnings: body.acknowledgeProtectionWarnings })
  });
  return res.json(successEnvelope("Bulk Ship Now processed successfully.", data));
});

shippingNetworkRouter.get("/ndr", async (req, res) => {
  const data = await listNdrCases(req.auth!.merchantId, operationalQuery(req.query));
  return res.json(successEnvelope("NDR cases fetched successfully.", data));
});

shippingNetworkRouter.get("/ndr/:caseId", async (req, res) => {
  const data = await getNdrCase(req.auth!.merchantId, req.params.caseId);
  return res.json(successEnvelope("NDR case fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/ndr", async (req, res) => {
  const body = createNdrCaseSchema.parse(req.body);
  const data = await createOrUpdateNdrCaseFromShipment(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(201).json(successEnvelope("NDR case recorded successfully.", data));
});

shippingNetworkRouter.post("/ndr/:caseId/actions", async (req, res) => {
  const body = recordNdrActionSchema.parse(req.body);
  const data = await recordNdrAction(req.auth!.merchantId, req.params.caseId, body);
  return res.status(201).json(successEnvelope("NDR action recorded successfully.", data));
});

shippingNetworkRouter.put("/ndr/:caseId/resolve", async (req, res) => {
  const body = resolveNdrCaseSchema.parse(req.body);
  const data = await resolveNdrCase(req.auth!.merchantId, req.params.caseId, body);
  return res.json(successEnvelope("NDR case resolved successfully.", data));
});

shippingNetworkRouter.get("/rto", async (req, res) => {
  const data = await listRtoCases(req.auth!.merchantId, operationalQuery(req.query));
  return res.json(successEnvelope("RTO cases fetched successfully.", data));
});

shippingNetworkRouter.get("/rto/:caseId", async (req, res) => {
  const data = await getRtoCase(req.auth!.merchantId, req.params.caseId);
  return res.json(successEnvelope("RTO case fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/rto", async (req, res) => {
  const body = createRtoCaseSchema.parse(req.body);
  const data = await createOrUpdateRtoCaseFromShipment(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(201).json(successEnvelope("RTO case recorded successfully.", data));
});

shippingNetworkRouter.put("/rto/:caseId/status", async (req, res) => {
  const body = updateRtoStatusSchema.parse(req.body);
  const data = await updateRtoStatus(req.auth!.merchantId, req.params.caseId, body);
  return res.json(successEnvelope("RTO case updated successfully.", data));
});

shippingNetworkRouter.get("/cod-ledger/summary", async (req, res) => {
  const query = listCodLedgerQuerySchema.parse(req.query);
  const data = await getCodLedgerSummary(req.auth!.merchantId, {
    ...(query.status ? { status: query.status } : {}),
    ...(query.entryType ? { entryType: query.entryType } : {})
  });
  return res.json(successEnvelope("COD ledger summary fetched successfully.", data));
});

shippingNetworkRouter.get("/cod-ledger", async (req, res) => {
  const query = listCodLedgerQuerySchema.parse(req.query);
  const data = await listCodLedger(req.auth!.merchantId, {
    ...(query.status ? { status: query.status } : {}),
    ...(query.entryType ? { entryType: query.entryType } : {}),
    page: query.page,
    perPage: query.per_page
  });
  return res.json(successEnvelope("COD ledger entries fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/expected", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await createExpectedCodEntryForCodShipment(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(201).json(successEnvelope("Expected COD collection recorded successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/collected", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await recordCodCollected(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(201).json(successEnvelope("COD collection recorded successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/remittance-due", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await recordCodRemittanceDue(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(201).json(successEnvelope("COD remittance due recorded successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/remitted", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await recordCodRemitted(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(201).json(successEnvelope("COD remittance recorded successfully.", data));
});

shippingNetworkRouter.get("/weight-disputes", async (req, res) => {
  const data = await listWeightDiscrepancyCases(req.auth!.merchantId, operationalQuery(req.query));
  return res.json(successEnvelope("Weight discrepancy cases fetched successfully.", data));
});

shippingNetworkRouter.get("/weight-disputes/:caseId", async (req, res) => {
  const data = await getWeightDiscrepancyCase(req.auth!.merchantId, req.params.caseId);
  return res.json(successEnvelope("Weight discrepancy case fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/weight-discrepancy", async (req, res) => {
  const body = detectWeightDiscrepancySchema.parse(req.body);
  const data = await detectWeightDiscrepancy(req.auth!.merchantId, req.params.shipmentId, body);
  return res.status(data.created ? 201 : 200).json(successEnvelope(
    data.created ? "Weight discrepancy case recorded successfully." : "No billable weight discrepancy detected.",
    data
  ));
});

shippingNetworkRouter.put("/weight-disputes/:caseId/evidence", async (req, res) => {
  const body = updateWeightEvidenceSchema.parse(req.body);
  const data = await updateWeightDisputeEvidence(req.auth!.merchantId, req.params.caseId, body);
  return res.json(successEnvelope("Weight dispute evidence updated successfully.", data));
});

shippingNetworkRouter.put("/weight-disputes/:caseId/submitted", async (req, res) => {
  const body = weightDisputeStatusSchema.parse(req.body);
  const data = await markWeightDisputeSubmitted(req.auth!.merchantId, req.params.caseId, body);
  return res.json(successEnvelope("Weight dispute marked submitted successfully.", data));
});

shippingNetworkRouter.put("/weight-disputes/:caseId/close", async (req, res) => {
  const body = weightDisputeStatusSchema.parse(req.body);
  const data = await closeWeightDispute(req.auth!.merchantId, req.params.caseId, body);
  return res.json(successEnvelope("Weight dispute closed successfully.", data));
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
  const body = fetchShipmentRatesSchema.parse(req.body);
  const data = await fetchShipmentRates(
    req.auth!.merchantId,
    req.params.shipmentId,
    body.refresh === undefined ? {} : { refresh: body.refresh }
  );
  return res.json(successEnvelope("Rates fetched successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/ship-now", async (req, res) => {
  const body = shipNowSchema.parse(req.body);
  const data = await shipNowShipment(req.auth!.merchantId, req.params.shipmentId, body.tier);
  return res.json(successEnvelope("Shipment created successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/autopilot/recommend", async (req, res) => {
  autopilotRecommendSchema.parse(req.body ?? {});
  const data = await recommendAutopilotForShipment(req.auth!.merchantId, req.params.shipmentId);
  return res.json(successEnvelope("Autopilot recommendation fetched successfully.", data));
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
