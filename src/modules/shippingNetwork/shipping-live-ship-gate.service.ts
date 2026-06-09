import { Prisma, ShipmentStatus } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";
import { getSellerShipment } from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type LiveAwbLabelMode = "DRY_RUN" | "LIVE";

export type LiveAwbLabelRuntime = {
  enabled: boolean;
  mode: LiveAwbLabelMode;
  pilotOnly: boolean;
};

export type LiveAwbLabelReadiness = {
  status: "DISABLED" | "READY" | "BLOCKED" | "DRY_RUN";
  ready: boolean;
  runtime: LiveAwbLabelRuntime;
  pilot: {
    merchantId: string;
    allowlisted: boolean;
    liveRatesCapabilityEnabled: boolean;
    awbLabelCapabilityEnabled: boolean;
  };
  shipment?: {
    shipmentId: string;
    status: string;
    hasAwb: boolean;
    readyForShipNow: boolean;
  };
  blockers: string[];
  warnings: string[];
  message: string;
};

type Source = Record<string, unknown>;

function boolValue(source: Source, key: string, fallback = false) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled", "live"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: Source, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

export function getLiveAwbLabelRuntime(source: Source = env): LiveAwbLabelRuntime {
  const mode = stringValue(source, "SHIPMASTR_LIVE_AWB_LABEL_MODE", "DRY_RUN").toUpperCase() === "LIVE"
    ? "LIVE"
    : "DRY_RUN";
  return {
    enabled: boolValue(source, "SHIPMASTR_LIVE_AWB_LABEL_ENABLED", false),
    mode,
    pilotOnly: boolValue(source, "SHIPMASTR_LIVE_AWB_LABEL_PILOT_ONLY", true)
  };
}

export async function getLiveAwbLabelReadiness(
  merchantId: string,
  options: {
    client?: Db;
    source?: Source;
    shipmentId?: string;
  } = {}
): Promise<LiveAwbLabelReadiness> {
  const client = options.client ?? prisma;
  const runtime = getLiveAwbLabelRuntime(options.source ?? env);
  const pilot = await getLivePilotReadinessSnapshot(merchantId, client);
  const liveRatesCapabilityEnabled = pilot.enabledCapabilities.includes("LIVE_COURIER_RATES");
  const awbLabelCapabilityEnabled = pilot.enabledCapabilities.includes("LIVE_AWB_LABEL");
  const blockers: string[] = [];
  const warnings: string[] = [];
  let shipment: LiveAwbLabelReadiness["shipment"];

  if (options.shipmentId) {
    const record = await getSellerShipment(merchantId, options.shipmentId, client);
    const terminalStatuses = new Set<string>([
      ShipmentStatus.delivered,
      ShipmentStatus.cancelled,
      ShipmentStatus.rto_delivered,
      ShipmentStatus.lost,
      ShipmentStatus.damaged
    ]);
    shipment = {
      shipmentId: record.id,
      status: String(record.status),
      hasAwb: Boolean(record.awbNumber),
      readyForShipNow: !terminalStatuses.has(String(record.status))
    };
    if (!shipment.readyForShipNow) blockers.push("SHIPMENT_STATUS_TERMINAL");
  }

  if (!runtime.enabled) {
    warnings.push("Pilot live AWB and label creation is disabled. Existing explicit Ship Now remains in safe mock or dry-run mode.");
  } else {
    if (!runtime.pilotOnly) blockers.push("LIVE_AWB_LABEL_NOT_PILOT_ONLY");
    if (runtime.mode === "LIVE" && !pilot.allowlisted) blockers.push("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
    if (runtime.mode === "LIVE" && !liveRatesCapabilityEnabled) blockers.push("LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
    if (runtime.mode === "LIVE" && !awbLabelCapabilityEnabled) blockers.push("LIVE_AWB_LABEL_CAPABILITY_REQUIRED");
    if (runtime.mode === "DRY_RUN") warnings.push("Pilot live AWB and label creation is in dry-run mode; no live document call is allowed.");
  }

  const ready = runtime.enabled
    && runtime.pilotOnly
    && runtime.mode === "LIVE"
    && pilot.allowlisted
    && liveRatesCapabilityEnabled
    && awbLabelCapabilityEnabled
    && (!shipment || shipment.readyForShipNow);
  const status = !runtime.enabled
    ? "DISABLED"
    : blockers.length
      ? "BLOCKED"
      : runtime.mode === "DRY_RUN"
        ? "DRY_RUN"
        : "READY";

  return {
    status,
    ready,
    runtime,
    pilot: {
      merchantId,
      allowlisted: pilot.allowlisted,
      liveRatesCapabilityEnabled,
      awbLabelCapabilityEnabled
    },
    ...(shipment ? { shipment } : {}),
    blockers,
    warnings,
    message: ready
      ? "Pilot live Ship Now is available for this merchant and shipment. Public responses remain Shipmastr-branded."
      : "Pilot live Ship Now is not available. Existing safe mock or dry-run behavior remains active."
  };
}

export async function assertLiveAwbLabelAllowed(
  merchantId: string,
  options: {
    client?: Db;
    source?: Source;
    shipmentId?: string;
  } = {}
) {
  const readiness = await getLiveAwbLabelReadiness(merchantId, options);
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE") {
    return readiness;
  }
  if (!readiness.runtime.pilotOnly) throw new HttpError(409, "LIVE_AWB_LABEL_NOT_PILOT_ONLY");
  if (!readiness.pilot.allowlisted) throw new HttpError(409, "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
  if (!readiness.pilot.liveRatesCapabilityEnabled) throw new HttpError(409, "LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
  if (!readiness.pilot.awbLabelCapabilityEnabled) throw new HttpError(409, "LIVE_AWB_LABEL_CAPABILITY_REQUIRED");
  if (readiness.shipment && !readiness.shipment.readyForShipNow) throw new HttpError(409, "SHIPMENT_STATUS_TERMINAL");
  return readiness;
}

export function serializeLiveAwbLabelReadiness(readiness: LiveAwbLabelReadiness) {
  return {
    status: readiness.status,
    ready: readiness.ready,
    runtime: {
      enabled: readiness.runtime.enabled,
      mode: readiness.runtime.mode,
      pilot_only: readiness.runtime.pilotOnly
    },
    pilot: {
      merchant_id: readiness.pilot.merchantId,
      allowlisted: readiness.pilot.allowlisted,
      live_rates_capability_enabled: readiness.pilot.liveRatesCapabilityEnabled,
      awb_label_capability_enabled: readiness.pilot.awbLabelCapabilityEnabled
    },
    ...(readiness.shipment ? {
      shipment: {
        shipment_id: readiness.shipment.shipmentId,
        status: readiness.shipment.status,
        has_awb: readiness.shipment.hasAwb,
        ready_for_ship_now: readiness.shipment.readyForShipNow
      }
    } : {}),
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    message: readiness.message
  };
}
