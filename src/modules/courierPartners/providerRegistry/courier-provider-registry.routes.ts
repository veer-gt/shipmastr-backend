import { Router } from "express";
import { HttpError } from "../../../lib/httpError.js";
import { successEnvelope } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  checkCourierProviderCapability,
  checkCourierProviderLiveWorkflowAllowed,
  getCourierProviderLane,
  listCourierProviderLanes,
  mapCourierProviderRawStatus
} from "./courier-provider-registry.service.js";
import {
  serializeAdminCourierProviderLane,
  serializeAdminCourierProviderLaneList,
  serializeCourierProviderWorkflowGuard
} from "./courier-provider-registry.serializer.js";
import {
  courierProviderLaneListQuerySchema,
  courierProviderWorkflowGuardSchema,
  parseCourierProviderCapability,
  parseCourierProviderLaneCode
} from "./courier-provider-registry.validation.js";

export const adminCourierProviderRegistryRouter = Router();

function routeLane(value: string | string[] | undefined) {
  const laneCode = parseCourierProviderLaneCode(value);
  if (!laneCode) throw new HttpError(400, "COURIER_PROVIDER_LANE_UNSUPPORTED");
  return laneCode;
}

function routeCapability(value: string | string[] | undefined) {
  const capability = parseCourierProviderCapability(value);
  if (!capability) throw new HttpError(400, "COURIER_PROVIDER_CAPABILITY_UNSUPPORTED");
  return capability;
}

adminCourierProviderRegistryRouter.get("/", async (req, res) => {
  const query = courierProviderLaneListQuerySchema.parse(req.query ?? {});
  const data = listCourierProviderLanes({
    ...(query.provider_code ? { providerCode: query.provider_code } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.mode ? { mode: query.mode } : {}),
    ...(query.capability ? { capability: query.capability } : {})
  });
  return res.json(successEnvelope(
    "Courier provider lanes fetched safely.",
    serializeAdminCourierProviderLaneList(data.lanes)
  ));
});

adminCourierProviderRegistryRouter.get("/status-map/:rawStatus", async (req, res) => {
  const rawStatus = Array.isArray(req.params.rawStatus) ? req.params.rawStatus[0] : req.params.rawStatus;
  return res.json(successEnvelope("Courier provider raw status normalized safely.", {
    internal_status: mapCourierProviderRawStatus(rawStatus)
  }));
});

adminCourierProviderRegistryRouter.get("/:laneCode", async (req, res) => {
  const data = getCourierProviderLane(routeLane(req.params.laneCode));
  return res.json(successEnvelope(
    "Courier provider lane fetched safely.",
    { lane: serializeAdminCourierProviderLane(data.lane) }
  ));
});

adminCourierProviderRegistryRouter.get("/:laneCode/capabilities/:capability", async (req, res) => {
  const data = checkCourierProviderCapability(
    routeLane(req.params.laneCode),
    routeCapability(req.params.capability)
  );
  return res.json(successEnvelope("Courier provider lane capability checked safely.", data));
});

adminCourierProviderRegistryRouter.post("/:laneCode/live-workflow-check", async (req, res) => {
  const body = courierProviderWorkflowGuardSchema.parse(req.body ?? {});
  const data = await checkCourierProviderLiveWorkflowAllowed({
    laneCode: routeLane(req.params.laneCode),
    merchantId: body.merchant_id ?? null,
    capability: body.capability,
    mode: body.mode
  });
  return res.json(successEnvelope(
    "Courier provider live workflow guard checked safely.",
    serializeCourierProviderWorkflowGuard(data)
  ));
});
