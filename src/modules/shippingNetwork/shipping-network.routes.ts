import { Router, type Request, type Response } from "express";
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
  createSellerApiKeySchema,
  createShippingOrderSchema,
  createShipmentFromOrderSchema,
  createShipmentSchema,
  createWebhookSubscriptionSchema,
  detectWeightDiscrepancySchema,
  fetchShipmentRatesSchema,
  listCodLedgerQuerySchema,
  listOperationalCasesQuerySchema,
  listWebhookEventsQuerySchema,
  listShippingOrdersQuerySchema,
  listShipmentsQuerySchema,
  manifestShipmentSchema,
  recordNdrActionSchema,
  resolveNdrCaseSchema,
  slaStatsQuerySchema,
  shipNowSchema,
  updateRtoStatusSchema,
  updateWebhookSubscriptionSchema,
  updateWeightEvidenceSchema,
  weightDisputeStatusSchema,
  updatePickupLocationSchema
} from "./shipping-validation.js";
import { successEnvelope } from "./shipping-public-serializers.js";
import { redactSellerApiPayload } from "./shipping-api-serializers.js";
import { createShippingPickupLocation, listShippingPickupLocations } from "./shipping-pickup-location.service.js";
import { deleteShippingPickupLocation, updateShippingPickupLocation } from "./shipping-pickup-crud.service.js";
import { createShipmentDraft, getShipmentDetails } from "./shipping-shipments.service.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { getLiveCourierRatesReadiness, serializeLiveCourierRatesReadiness } from "./shipping-live-rates-gate.service.js";
import { getLiveAwbLabelReadiness, serializeLiveAwbLabelReadiness } from "./shipping-live-ship-gate.service.js";
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
  finalizeWeightProofCapture,
  getWeightProofByAwb,
  initWeightProofCapture,
  type WeightProofServiceContext
} from "./shipping-weight-proof.service.js";
import {
  assertWeightProofStorageEnabled,
  createWeightProofStorageRuntime,
  type WeightProofStorageRuntime
} from "./shipping-weight-proof-storage.js";
import {
  finalizeWeightProofCaptureRouteSchema,
  initWeightProofCaptureRouteSchema,
  weightProofAwbRouteParamSchema
} from "./shipping-weight-proof.validation.js";
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
import {
  createSellerApiKey,
  listSellerApiKeys,
  requireSellerApiKey,
  revokeSellerApiKey
} from "./shipping-api-keys.service.js";
import {
  createWebhookSubscription,
  disableWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription
} from "./shipping-webhooks.service.js";
import {
  enqueueWebhookEvent,
  listWebhookEvents,
  simulateWebhookDelivered,
  simulateWebhookFailed
} from "./shipping-webhook-events.service.js";
import { getMerchantOperationsSummary } from "./shipping-merchant-operations.service.js";
import { emailDeliveryRouter } from "../emailDelivery/email-delivery.routes.js";
import { courierArbitrationRouter } from "../courierPartners/arbitration/courier-arbitration.routes.js";
import { courierAwbCertificationRouter } from "../courierPartners/awbCertification/courier-awb-certification.routes.js";
import { certifiedProviderRoutingRouter } from "../courierPartners/certifiedRouting/certified-provider-routing.routes.js";
import { courierCertificationRouter } from "../courierPartners/certification/courier-certification.routes.js";
import { courierLabelCertificationRouter } from "../courierPartners/labelCertification/courier-label-certification.routes.js";
import { courierLiveReadinessRouter } from "../courierPartners/liveReadiness/courier-live-readiness.routes.js";
import { courierOnboardingRouter } from "../courierPartners/onboarding/courier-onboarding.routes.js";
import { courierPickupLearningRouter } from "../courierPartners/pickupLearning/courier-pickup-learning.routes.js";
import { courierPickupServiceabilityRouter } from "../courierPartners/pickupServiceability/courier-pickup-serviceability.routes.js";
import { courierPickupTrialRouter } from "../courierPartners/pickupTrial/courier-pickup-trial.routes.js";
import { courierReadinessAutopilotRouter } from "../courierPartners/readinessAutopilot/courier-readiness-autopilot.routes.js";
import { courierTrackingCertificationRouter } from "../courierPartners/trackingCertification/courier-tracking-certification.routes.js";
import { merchantStoreOnboardingRouter } from "../merchantOnboarding/merchant-onboarding.routes.js";
import { merchantNotificationsRouter } from "../merchantNotifications/merchant-notification.routes.js";
import { livePilotRouter } from "../livePilot/live-pilot.routes.js";
import { pilotLaunchRouter } from "../pilotLaunch/pilot-launch.routes.js";
import { platformIntegrationsRouter } from "../platformIntegrations/platform-integrations.routes.js";
import { productionReadinessRouter } from "../productionReadiness/production-readiness.routes.js";
import { workersRouter } from "../workers/workers.routes.js";
import {
  getPlatformTrackingSyncReadiness,
  listShipmentPlatformTrackingSyncAttempts,
  runShipmentPlatformTrackingSync,
  runShipmentPlatformTrackingSyncDryRun,
  serializePlatformTrackingSyncReadiness
} from "../platformIntegrations/trackingSync/pilot-platform-tracking-sync.service.js";

export const shippingNetworkRouter = Router();
export const shippingSellerApiRouter = Router();
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

function sellerApiEnvelope(message: string, data: unknown) {
  return successEnvelope(message, redactSellerApiPayload(data));
}

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function getWeightProofStorageRuntimeForRequest(req: Request): WeightProofStorageRuntime {
  return req.app.locals.weightProofStorageRuntime as WeightProofStorageRuntime | undefined
    ?? createWeightProofStorageRuntime();
}

export function createWeightProofRouteContext(req: Request, options: { requireStorage?: boolean } = {}): WeightProofServiceContext {
  const runtime = getWeightProofStorageRuntimeForRequest(req);
  const activeRuntime = options.requireStorage === false ? runtime : assertWeightProofStorageEnabled(runtime);
  const context: WeightProofServiceContext = {
    merchantId: req.auth!.merchantId,
    storage: activeRuntime.storage,
    uploadTtlMs: activeRuntime.uploadTtlMs
  };
  const client = req.app.locals.weightProofClient;
  if (client) context.client = client;
  const now = req.app.locals.weightProofNow;
  if (now) context.now = now;
  const idFactory = req.app.locals.weightProofIdFactory;
  if (idFactory) context.idFactory = idFactory;
  return context;
}

function assertWeightProofImageSize(expectedByteSize: number | undefined, runtime: WeightProofStorageRuntime) {
  if (expectedByteSize !== undefined && expectedByteSize > runtime.maxImageBytes) {
    throw new ShippingValidationError("Weight proof image is larger than the configured limit.", [{
      field: "expected_byte_size",
      message: "Expected image byte size exceeds the configured Weight Guard limit."
    }]);
  }
}

export function serializeInitWeightProofRouteResult(result: Awaited<ReturnType<typeof initWeightProofCapture>>) {
  if (result.proof) {
    return {
      status: "PROOF_ALREADY_LOGGED",
      captureSessionId: result.proof.capture_session_id,
      awbNumber: result.proof.awb_number,
      declaredWeightGrams: result.proof.declared_weight_grams,
      volumetricWeightGrams: result.proof.volumetric_weight_grams,
      chargeableWeightGrams: result.proof.chargeable_weight_grams,
      proofStatus: "READY_FOR_DISPUTE"
    };
  }

  return {
    status: result.created ? "CAPTURE_SESSION_CREATED" : "CAPTURE_SESSION_REUSED",
    captureSessionId: result.capture?.capture_session_id ?? null,
    awbNumber: result.capture?.awb_number ?? null,
    objectKey: result.objectKey ?? null,
    uploadUrl: result.upload?.uploadUrl ?? null,
    expiresAt: result.upload?.expiresAt ?? null,
    requiredHeaders: {
      "Content-Type": result.upload?.headers["content-type"] ?? "image/jpeg"
    }
  };
}

export function serializeFinalizeWeightProofRouteResult(result: Awaited<ReturnType<typeof finalizeWeightProofCapture>>) {
  return {
    status: result.finalized ? "PROOF_LOGGED" : "PROOF_ALREADY_LOGGED",
    awbNumber: result.proof.awb_number,
    declaredWeightGrams: result.proof.declared_weight_grams,
    volumetricWeightGrams: result.proof.volumetric_weight_grams,
    chargeableWeightGrams: result.proof.chargeable_weight_grams,
    proofStatus: "READY_FOR_DISPUTE"
  };
}

shippingNetworkRouter.use("/", platformIntegrationsRouter);
shippingNetworkRouter.use("/", courierLiveReadinessRouter);
shippingNetworkRouter.use("/", courierArbitrationRouter);
shippingNetworkRouter.use("/", certifiedProviderRoutingRouter);
shippingNetworkRouter.use("/", courierAwbCertificationRouter);
shippingNetworkRouter.use("/", courierLabelCertificationRouter);
shippingNetworkRouter.use("/", courierCertificationRouter);
shippingNetworkRouter.use("/", courierTrackingCertificationRouter);
shippingNetworkRouter.use("/", courierPickupLearningRouter);
shippingNetworkRouter.use("/", courierPickupServiceabilityRouter);
shippingNetworkRouter.use("/", courierPickupTrialRouter);
shippingNetworkRouter.use("/", courierReadinessAutopilotRouter);
shippingNetworkRouter.use("/", courierOnboardingRouter);
shippingNetworkRouter.use("/", merchantNotificationsRouter);
shippingNetworkRouter.use("/", emailDeliveryRouter);
shippingNetworkRouter.use("/", merchantStoreOnboardingRouter);
shippingNetworkRouter.use("/", workersRouter);
shippingNetworkRouter.use("/", productionReadinessRouter);
shippingNetworkRouter.use("/", livePilotRouter);
shippingNetworkRouter.use("/", pilotLaunchRouter);

shippingNetworkRouter.post("/api-keys", async (req, res) => {
  const body = createSellerApiKeySchema.parse(req.body);
  const data = await createSellerApiKey(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Seller API key created successfully. Copy this key now; it will not be shown again.", data));
});

shippingNetworkRouter.get("/api-keys", async (req, res) => {
  const data = await listSellerApiKeys(req.auth!.merchantId);
  return res.json(successEnvelope("Seller API keys fetched successfully.", data));
});

shippingNetworkRouter.delete("/api-keys/:keyId", async (req, res) => {
  const data = await revokeSellerApiKey(req.auth!.merchantId, req.params.keyId);
  return res.json(successEnvelope("Seller API key revoked successfully.", data));
});

shippingNetworkRouter.post("/webhooks", async (req, res) => {
  const body = createWebhookSubscriptionSchema.parse(req.body);
  const data = await createWebhookSubscription(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Webhook subscription created successfully. Copy this secret now; it will not be shown again.", data));
});

shippingNetworkRouter.get("/webhooks", async (req, res) => {
  const data = await listWebhookSubscriptions(req.auth!.merchantId);
  return res.json(successEnvelope("Webhook subscriptions fetched successfully.", data));
});

shippingNetworkRouter.put("/webhooks/:subscriptionId", async (req, res) => {
  const body = updateWebhookSubscriptionSchema.parse(req.body);
  const data = await updateWebhookSubscription(req.auth!.merchantId, req.params.subscriptionId, body);
  return res.json(successEnvelope("Webhook subscription updated successfully.", data));
});

shippingNetworkRouter.delete("/webhooks/:subscriptionId", async (req, res) => {
  const data = await disableWebhookSubscription(req.auth!.merchantId, req.params.subscriptionId);
  return res.json(successEnvelope("Webhook subscription disabled successfully.", data));
});

shippingNetworkRouter.get("/webhook-events", async (req, res) => {
  const query = listWebhookEventsQuerySchema.parse(req.query);
  const data = await listWebhookEvents(req.auth!.merchantId, {
    ...(query.status ? { status: query.status } : {}),
    ...(query.eventType ? { eventType: query.eventType } : {}),
    page: query.page,
    perPage: query.per_page
  });
  return res.json(successEnvelope("Webhook events fetched successfully.", data));
});

shippingNetworkRouter.post("/webhook-events/:eventId/simulate-delivered", async (req, res) => {
  const data = await simulateWebhookDelivered(req.auth!.merchantId, req.params.eventId);
  return res.json(successEnvelope("Webhook event marked delivered successfully.", data));
});

shippingNetworkRouter.post("/webhook-events/:eventId/simulate-failed", async (req, res) => {
  const data = await simulateWebhookFailed(req.auth!.merchantId, req.params.eventId);
  return res.json(successEnvelope("Webhook event marked failed successfully.", data));
});

shippingNetworkRouter.get("/merchant-operations/summary", async (req, res) => {
  const data = await getMerchantOperationsSummary(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant operations summary fetched successfully.", data));
});

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

shippingNetworkRouter.get("/live-rates/readiness", async (req, res) => {
  const readiness = await getLiveCourierRatesReadiness(req.auth!.merchantId);
  return res.json(successEnvelope(
    "Pilot live shipping rate readiness fetched successfully.",
    serializeLiveCourierRatesReadiness(readiness)
  ));
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
  await enqueueWebhookEvent(req.auth!.merchantId, "ndr.created", data);
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
  await enqueueWebhookEvent(req.auth!.merchantId, "ndr.resolved", data);
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
  await enqueueWebhookEvent(req.auth!.merchantId, "shipment.rto.created", data);
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
  await enqueueWebhookEvent(req.auth!.merchantId, "cod.expected", data);
  return res.status(201).json(successEnvelope("Expected COD collection recorded successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/collected", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await recordCodCollected(req.auth!.merchantId, req.params.shipmentId, body);
  await enqueueWebhookEvent(req.auth!.merchantId, "cod.collected", data);
  return res.status(201).json(successEnvelope("COD collection recorded successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/remittance-due", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await recordCodRemittanceDue(req.auth!.merchantId, req.params.shipmentId, body);
  await enqueueWebhookEvent(req.auth!.merchantId, "cod.remittance_due", data);
  return res.status(201).json(successEnvelope("COD remittance due recorded successfully.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cod/remitted", async (req, res) => {
  const body = codLedgerEntrySchema.parse(req.body);
  const data = await recordCodRemitted(req.auth!.merchantId, req.params.shipmentId, body);
  await enqueueWebhookEvent(req.auth!.merchantId, "cod.remitted", data);
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
  if (data.created) {
    await enqueueWebhookEvent(req.auth!.merchantId, "weight.discrepancy.created", data);
  }
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
  await enqueueWebhookEvent(req.auth!.merchantId, "weight.dispute.closed", data);
  return res.json(successEnvelope("Weight dispute closed successfully.", data));
});

shippingNetworkRouter.post("/weight-proofs/init", async (req, res) => {
  const body = initWeightProofCaptureRouteSchema.parse(req.body);
  const runtime = getWeightProofStorageRuntimeForRequest(req);
  assertWeightProofImageSize(body.expected_byte_size, runtime);
  const context = createWeightProofRouteContext(req);
  const result = await initWeightProofCapture({
    awbNumber: body.awb_number,
    ...(body.shipment_id ? { shipmentId: body.shipment_id } : {}),
    contentType: body.content_type,
    ...(body.expected_byte_size === undefined ? {} : { expectedByteSize: body.expected_byte_size }),
    ...(body.device_id ? { deviceId: body.device_id } : {})
  }, context);
  return res.status(result.created ? 201 : 200).json(successEnvelope(
    result.created ? "Weight proof capture session created successfully." : "Weight proof capture session fetched successfully.",
    serializeInitWeightProofRouteResult(result)
  ));
});

shippingNetworkRouter.post("/weight-proofs/finalize", async (req, res) => {
  const body = finalizeWeightProofCaptureRouteSchema.parse(req.body);
  const context = createWeightProofRouteContext(req);
  const result = await finalizeWeightProofCapture({
    captureSessionId: body.capture_session_id,
    declaredWeightGrams: body.declared_weight_grams,
    dimensions: {
      lengthCm: body.length_cm,
      widthCm: body.width_cm,
      heightCm: body.height_cm
    },
    ...(body.device_id ? { deviceId: body.device_id } : {}),
    ...(body.captured_at ? { capturedAt: body.captured_at } : {})
  }, context);
  return res.status(result.finalized ? 201 : 200).json(successEnvelope(
    result.finalized ? "Weight proof logged successfully." : "Weight proof already logged.",
    serializeFinalizeWeightProofRouteResult(result)
  ));
});

shippingNetworkRouter.get("/weight-proofs/:awbNumber", async (req, res) => {
  const params = weightProofAwbRouteParamSchema.parse({ awbNumber: routeParam(req.params.awbNumber) });
  const context = createWeightProofRouteContext(req, { requireStorage: false });
  const data = await getWeightProofByAwb({ awbNumber: params.awbNumber }, context);
  return res.json(successEnvelope("Weight proof fetched successfully.", data));
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

shippingNetworkRouter.get("/shipments/:shipmentId/live-ship-readiness", async (req, res) => {
  const readiness = await getLiveAwbLabelReadiness(req.auth!.merchantId, {
    shipmentId: req.params.shipmentId,
    includePickupAlignment: true,
    source: {
      SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER: req.get("x-shipmastr-live-awb-approval") ?? ""
    }
  });
  return res.json(successEnvelope(
    "Pilot live Ship Now readiness fetched successfully.",
    serializeLiveAwbLabelReadiness(readiness)
  ));
});

shippingNetworkRouter.post("/shipments/:shipmentId/ship-now", async (req, res) => {
  const body = shipNowSchema.parse(req.body);
  const data = await shipNowShipment(req.auth!.merchantId, req.params.shipmentId, body.tier, {
    liveAwbLabelSource: {
      SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER: req.get("x-shipmastr-live-awb-approval") ?? ""
    }
  });
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

shippingNetworkRouter.get("/shipments/:shipmentId/platform-tracking-sync", async (req, res) => {
  const data = await listShipmentPlatformTrackingSyncAttempts(req.auth!.merchantId, req.params.shipmentId);
  return res.json(successEnvelope("Platform tracking sync attempts fetched safely.", data));
});

shippingNetworkRouter.get("/shipments/:shipmentId/platform-tracking-sync/readiness", async (req, res) => {
  const readiness = await getPlatformTrackingSyncReadiness(req.auth!.merchantId, req.params.shipmentId);
  return res.json(successEnvelope(
    "Platform tracking sync readiness fetched safely.",
    serializePlatformTrackingSyncReadiness(readiness)
  ));
});

shippingNetworkRouter.post("/shipments/:shipmentId/platform-tracking-sync/dry-run", async (req, res) => {
  const data = await runShipmentPlatformTrackingSyncDryRun(req.auth!.merchantId, req.params.shipmentId);
  return res.status(201).json(successEnvelope("Platform tracking sync dry-run recorded safely.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/platform-tracking-sync", async (req, res) => {
  const data = await runShipmentPlatformTrackingSync(req.auth!.merchantId, req.params.shipmentId);
  return res.status(201).json(successEnvelope("Pilot platform tracking sync attempt recorded safely.", data));
});

shippingNetworkRouter.post("/shipments/:shipmentId/cancel", async (req, res) => {
  const body = cancelShipmentSchema.parse(req.body);
  const data = await cancelShipment(req.auth!.merchantId, req.params.shipmentId, body.reason);
  return res.json(successEnvelope("Shipment cancelled successfully.", data));
});

shippingSellerApiRouter.post("/orders", requireSellerApiKey(["orders:write"]), async (req, res) => {
  const body = createShippingOrderSchema.parse(req.body);
  try {
    const order = await createShippingOrder(req.auth!.merchantId, body);
    await enqueueWebhookEvent(req.auth!.merchantId, "order.created", order);
    return res.status(201).json(sellerApiEnvelope("Order created successfully.", { order }));
  } catch (error) {
    if (error instanceof ShippingValidationError) return sendValidationError(res, error);
    throw error;
  }
});

shippingSellerApiRouter.get("/orders", requireSellerApiKey(["orders:read"]), async (req, res) => {
  const query = listShippingOrdersQuerySchema.parse(req.query);
  const data = await listShippingOrders(req.auth!.merchantId, query);
  return res.json(sellerApiEnvelope("Orders fetched successfully.", data));
});

shippingSellerApiRouter.get("/orders/:orderId", requireSellerApiKey(["orders:read"]), async (req, res) => {
  const data = await getShippingOrder(req.auth!.merchantId, routeParam(req.params.orderId));
  return res.json(sellerApiEnvelope("Order fetched successfully.", { order: data }));
});

shippingSellerApiRouter.post("/orders/:orderId/create-shipment", requireSellerApiKey(["shipments:write"]), async (req, res) => {
  const body = createShipmentFromOrderSchema.parse(req.body);
  const result = await createShipmentFromOrder(req.auth!.merchantId, routeParam(req.params.orderId), body);
  await enqueueWebhookEvent(req.auth!.merchantId, "shipment.created", result.shipment);
  return res.status(result.existed ? 200 : 201).json(sellerApiEnvelope(
    result.existed ? "Shipment draft already exists for this order." : "Shipment draft created from order successfully.",
    result.shipment
  ));
});

shippingSellerApiRouter.get("/shipments", requireSellerApiKey(["shipments:read"]), async (req, res) => {
  const query = listShipmentsQuerySchema.parse(req.query);
  const data = await listShippingShipments(req.auth!.merchantId, query);
  return res.json(sellerApiEnvelope("Shipments fetched successfully.", data));
});

shippingSellerApiRouter.get("/shipments/:shipmentId", requireSellerApiKey(["shipments:read"]), async (req, res) => {
  const data = await getShipmentDetails(req.auth!.merchantId, routeParam(req.params.shipmentId));
  return res.json(sellerApiEnvelope("Shipment fetched successfully.", data));
});

shippingSellerApiRouter.post("/shipments/:shipmentId/rates", requireSellerApiKey(["shipments:write"]), async (req, res) => {
  const body = fetchShipmentRatesSchema.parse(req.body);
  const data = await fetchShipmentRates(
    req.auth!.merchantId,
    routeParam(req.params.shipmentId),
    body.refresh === undefined ? {} : { refresh: body.refresh }
  );
  await enqueueWebhookEvent(req.auth!.merchantId, "shipment.rates.ready", data);
  return res.json(sellerApiEnvelope("Rates fetched successfully.", data));
});

shippingSellerApiRouter.post("/shipments/:shipmentId/ship-now", requireSellerApiKey(["shipments:write"]), async (req, res) => {
  const body = shipNowSchema.parse(req.body);
  const data = await shipNowShipment(req.auth!.merchantId, routeParam(req.params.shipmentId), body.tier, {
    liveAwbLabelSource: {
      SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER: req.get("x-shipmastr-live-awb-approval") ?? ""
    }
  });
  await enqueueWebhookEvent(req.auth!.merchantId, "shipment.shipped", data);
  return res.json(sellerApiEnvelope("Shipment created successfully.", data));
});

shippingSellerApiRouter.get("/shipments/:shipmentId/tracking", requireSellerApiKey(["tracking:read"]), async (req, res) => {
  const data = await fetchShipmentTracking(req.auth!.merchantId, routeParam(req.params.shipmentId));
  await enqueueWebhookEvent(req.auth!.merchantId, "shipment.tracking.updated", data);
  return res.json(sellerApiEnvelope("Tracking fetched successfully.", data));
});

shippingSellerApiRouter.get("/operations/summary", requireSellerApiKey(["operations:read"]), async (req, res) => {
  const data = await getMerchantOperationsSummary(req.auth!.merchantId);
  return res.json(sellerApiEnvelope("Merchant operations summary fetched successfully.", data));
});
