import { Prisma, ShipmentStatus } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  canResolveShiprocketLiveCredentials,
  type ShiprocketLiveCredentials
} from "../courierPartners/providers/shiprocket/shiprocket-live-credentials.js";
import {
  getCourierCertificationDecision,
  sellerSafeCourierCertificationDecision,
  type CourierCertificationDecision
} from "../courierPartners/certification/courier-certification-decision.service.js";
import type { CourierCertificationSnapshot } from "../courierPartners/certification/courier-certification.types.js";
import { getCourierLiveReadinessSnapshot } from "../courierPartners/liveReadiness/courier-live-readiness.service.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";
import { getSellerShipment } from "./shipping-shipments.service.js";
import {
  getShiprocketPickupDiagnostics,
  serializeShiprocketPickupDiagnostics
} from "./shipping-shiprocket-pickup-alignment.service.js";

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
  providerReadiness: {
    hasActiveProvider: boolean;
    activeProviderCount: number;
  };
  shiprocket: {
    oneShotEnabled: boolean;
    oneShotApprovalPresent: boolean;
    allowedMerchantMatched: boolean;
    allowedShipmentMatched: boolean;
    credentialId: string | null;
    credentialRef?: string | null;
    credentialRefConfigured: boolean;
    credentialResolved: boolean;
  };
  shipment?: {
    shipmentId: string;
    status: string;
    hasAwb: boolean;
    readyForShipNow: boolean;
  };
  selectedRate?: {
    tier: "smart";
    found: boolean;
    liveMode: boolean;
    liveReady: boolean;
    pickupAvailable: boolean | null;
    providerCourierIdPresent: boolean;
  };
  pickupAlignment?: Awaited<ReturnType<typeof getShiprocketPickupDiagnostics>>;
  certificationDecision?: CourierCertificationDecision;
  blockers: string[];
  warnings: string[];
  message: string;
};

type Source = Record<string, unknown>;
type ShiprocketPickupClient = {
  login(credentials: ShiprocketLiveCredentials): Promise<{ token?: string; expires_in?: number; expiresIn?: number }>;
  listPickupLocations(token: string): Promise<Record<string, unknown>>;
};

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

function sourceWithEnv(source?: Source) {
  return {
    ...env,
    ...(source ?? {})
  };
}

function oneShotHeader(source: Source) {
  return stringValue(source, "SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER")
    || stringValue(source, "x-shipmastr-live-awb-approval");
}

function shipmentAllowedForLive(status: string) {
  return status === ShipmentStatus.draft || status === ShipmentStatus.rates_fetched;
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function strictBoolMetadata(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function firstStringMetadata(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function liveShiprocketCourierId(rateBreakup: unknown) {
  const metadata = metadataObject(rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const result = metadataObject(metadata.result);
  const value = firstStringMetadata(
    metadata.shiprocketCourierId,
    metadata.providerCourierId,
    metadata.courier_id,
    metadata.courierId,
    metadata.internalCourierId,
    phase6.shiprocketCourierId,
    phase6.providerCourierId,
    phase6.courier_id,
    phase6.courierId,
    result.courier_id,
    result.courierId,
    result.providerCourierId
  );
  return value && /^[0-9]+$/.test(value) ? value : null;
}

function liveRateMetadata(rateBreakup: unknown) {
  const metadata = metadataObject(rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const liveMode = firstStringMetadata(phase6.livePilotRatesMode, metadata.livePilotRatesMode);
  const liveReady = phase6.livePilotRatesReady === true || metadata.livePilotRatesReady === true;
  return {
    liveMode: liveMode === "LIVE",
    liveReady,
    pickupAvailable: strictBoolMetadata(phase6.pickupAvailable),
    providerCourierIdPresent: Boolean(liveShiprocketCourierId(rateBreakup))
  };
}

function isSmartRate(rate: { publicServiceCode?: string | null; publicServiceName?: string | null }) {
  return rate.publicServiceCode === "shipmastr_smart" || rate.publicServiceName === "Shipmastr Smart";
}

function liveAwbDecisionSnapshot(input: {
  status: "READY_FOR_PILOT" | "BLOCKED";
  shiprocket: LiveAwbLabelReadiness["shiprocket"];
  selectedRate?: LiveAwbLabelReadiness["selectedRate"];
  pickupAlignment?: LiveAwbLabelReadiness["pickupAlignment"];
  blockers: string[];
  warnings: string[];
  checkedAt: string;
}): CourierCertificationSnapshot {
  const pickupPass = input.pickupAlignment
    ? !input.pickupAlignment.blockers.length
    : input.selectedRate?.pickupAvailable !== false;
  const ratesPass = Boolean(input.selectedRate?.found && input.selectedRate.liveMode && input.selectedRate.liveReady);
  const courierIdPass = Boolean(input.selectedRate?.providerCourierIdPresent);
  const credentialsPass = Boolean(
    input.shiprocket.credentialRefConfigured
      && input.shiprocket.credentialResolved
      && input.shiprocket.credentialId
  );
  const awbOneShotPass = input.shiprocket.oneShotEnabled
    && input.shiprocket.oneShotApprovalPresent
    && input.shiprocket.allowedMerchantMatched
    && input.shiprocket.allowedShipmentMatched;

  return {
    provider_key: "SHIPROCKET",
    provider_label_internal: "Shiprocket",
    public_network_name: "Shipmastr Courier Network",
    status: input.status,
    live_ready: false,
    can_use_for_rates: ratesPass && courierIdPass && pickupPass,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [{
      key: "CREDENTIALS",
      status: credentialsPass ? "PASS" : "FAIL",
      blockers: credentialsPass ? [] : ["PROVIDER_CREDENTIALS_MISSING"],
      warnings: [],
      safe_summary: { configured: credentialsPass }
    }, {
      key: "PICKUPS",
      status: pickupPass ? "PASS" : "FAIL",
      blockers: pickupPass ? [] : ["PROVIDER_PICKUP_UNAVAILABLE"],
      warnings: [],
      safe_summary: { selected_context: input.pickupAlignment?.selectedContext ?? null }
    }, {
      key: "RATES",
      status: ratesPass ? "PASS" : "FAIL",
      blockers: ratesPass ? [] : ["PROVIDER_RATES_NOT_LIVE"],
      warnings: [],
      safe_summary: { live_rate_seen: ratesPass }
    }, {
      key: "COURIER_ID_MAPPING",
      status: courierIdPass ? "PASS" : "FAIL",
      blockers: courierIdPass ? [] : ["PROVIDER_COURIER_ID_MISSING"],
      warnings: [],
      safe_summary: { mapping_present: courierIdPass }
    }, {
      key: "AWB",
      status: awbOneShotPass ? "PASS" : "WARN",
      blockers: awbOneShotPass ? [] : ["PROVIDER_LIVE_ONE_SHOT_REQUIRED"],
      warnings: awbOneShotPass ? [] : ["Explicit one-shot AWB approval is required."],
      safe_summary: { one_shot_approved: awbOneShotPass }
    }, {
      key: "LABEL",
      status: "NOT_RUN",
      blockers: ["PROVIDER_LABEL_NOT_CERTIFIED"],
      warnings: [],
      safe_summary: {}
    }, {
      key: "TRACKING",
      status: "NOT_RUN",
      blockers: ["PROVIDER_TRACKING_NOT_CERTIFIED"],
      warnings: [],
      safe_summary: {}
    }, {
      key: "WEBHOOKS",
      status: "NOT_SUPPORTED",
      blockers: [],
      warnings: [],
      safe_summary: {}
    }, {
      key: "PUBLIC_SAFETY",
      status: "PASS",
      blockers: [],
      warnings: [],
      safe_summary: { provider_details_public: false }
    }],
    blockers: input.blockers,
    warnings: input.warnings,
    next_actions: ["Review live Ship Now readiness blockers before attempting a pilot shipment."],
    checked_at: input.checkedAt
  };
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
    includePickupAlignment?: boolean;
    shiprocketPickupClient?: ShiprocketPickupClient;
  } = {}
): Promise<LiveAwbLabelReadiness> {
  const client = options.client ?? prisma;
  const source = sourceWithEnv(options.source);
  const runtime = getLiveAwbLabelRuntime(source);
  const pilot = await getLivePilotReadinessSnapshot(merchantId, client);
  const providerReadiness = await getCourierLiveReadinessSnapshot(merchantId, client);
  const shiprocketRecord = await client.courierProviderCredential.findMany({
    where: {
      merchantId,
      providerKey: "SHIPROCKET",
      mode: "LIVE",
      status: "ACTIVE",
      credentialRef: { not: null },
      lastTestStatus: "PASS",
      lastTestedAt: { not: null }
    },
    orderBy: { lastTestedAt: "desc" },
    take: 1
  }).then((rows) => rows[0] ?? null);
  const liveRatesCapabilityEnabled = pilot.enabledCapabilities.includes("LIVE_COURIER_RATES");
  const awbLabelCapabilityEnabled = pilot.enabledCapabilities.includes("LIVE_AWB_LABEL");
  const blockers: string[] = [];
  const warnings: string[] = [];
  let shipment: LiveAwbLabelReadiness["shipment"];
  let selectedRate: LiveAwbLabelReadiness["selectedRate"];
  let pickupAlignment: LiveAwbLabelReadiness["pickupAlignment"];

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
    if (shipment.hasAwb) blockers.push("SHIPMENT_ALREADY_HAS_AWB");
    if (!shipmentAllowedForLive(shipment.status)) blockers.push("SHIPMENT_NOT_READY_TO_SHIP");

    const rates = await client.shipmentRate.findMany({
      where: {
        shipmentId: record.id,
        sellerId: merchantId
      },
      orderBy: { createdAt: "desc" }
    });
    const smartRate = rates.find(isSmartRate) ?? null;
    if (smartRate) {
      const rateMetadata = liveRateMetadata(smartRate.rateBreakup);
      selectedRate = {
        tier: "smart",
        found: true,
        liveMode: rateMetadata.liveMode,
        liveReady: rateMetadata.liveReady,
        pickupAvailable: rateMetadata.pickupAvailable,
        providerCourierIdPresent: rateMetadata.providerCourierIdPresent
      };
      if (
        runtime.enabled
        && runtime.mode === "LIVE"
        && rateMetadata.liveMode
        && rateMetadata.liveReady
        && rateMetadata.pickupAvailable !== true
      ) {
        blockers.push("SHIPROCKET_LIVE_PICKUP_UNAVAILABLE");
      }
    } else {
      selectedRate = {
        tier: "smart",
        found: false,
        liveMode: false,
        liveReady: false,
        pickupAvailable: null,
        providerCourierIdPresent: false
      };
    }
  }

  const oneShotToken = stringValue(source, "SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_TOKEN");
  const approvalHeader = oneShotHeader(source);
  const allowedMerchant = stringValue(source, "SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_MERCHANT_ID");
  const allowedShipment = stringValue(source, "SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_SHIPMENT_ID");
  const oneShotEnabled = boolValue(source, "SHIPMASTR_ENABLE_LIVE_SHIPROCKET_AWB", false);
  const credentialResolution = canResolveShiprocketLiveCredentials(shiprocketRecord?.credentialRef, source);
  const shiprocket = {
    oneShotEnabled,
    oneShotApprovalPresent: Boolean(oneShotToken && approvalHeader && oneShotToken === approvalHeader),
    allowedMerchantMatched: Boolean(allowedMerchant && allowedMerchant === merchantId),
    allowedShipmentMatched: Boolean(!options.shipmentId || (allowedShipment && allowedShipment === options.shipmentId)),
    credentialId: shiprocketRecord?.id ?? null,
    credentialRef: shiprocketRecord?.credentialRef ?? null,
    credentialRefConfigured: Boolean(shiprocketRecord?.credentialRef),
    credentialResolved: credentialResolution.ok
  };

  if (!runtime.enabled) {
    warnings.push("Pilot live AWB and label creation is disabled. Existing explicit Ship Now remains in safe mock or dry-run mode.");
  } else {
    if (!runtime.pilotOnly) blockers.push("LIVE_AWB_LABEL_NOT_PILOT_ONLY");
    if (runtime.mode === "LIVE" && !pilot.allowlisted) blockers.push("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
    if (runtime.mode === "LIVE" && !liveRatesCapabilityEnabled) blockers.push("LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
    if (runtime.mode === "LIVE" && !awbLabelCapabilityEnabled) blockers.push("LIVE_AWB_LABEL_CAPABILITY_REQUIRED");
    if (runtime.mode === "LIVE" && !providerReadiness.has_active_provider) blockers.push("LIVE_PROVIDER_CREDENTIALS_MISSING");
    if (runtime.mode === "LIVE" && !shiprocketRecord) blockers.push("LIVE_SHIPPING_PROVIDER_NOT_READY");
    if (runtime.mode === "LIVE" && shiprocketRecord && !shiprocket.credentialRefConfigured) blockers.push("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
    if (runtime.mode === "LIVE" && shiprocketRecord && !credentialResolution.ok) blockers.push(credentialResolution.code);
    if (runtime.mode === "LIVE" && !shiprocket.oneShotEnabled) blockers.push("LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED");
    if (runtime.mode === "LIVE" && !shiprocket.oneShotApprovalPresent) blockers.push("LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED");
    if (runtime.mode === "LIVE" && !shiprocket.allowedMerchantMatched) blockers.push("LIVE_SHIPROCKET_ALLOWED_MERCHANT_MISMATCH");
    if (runtime.mode === "LIVE" && !shiprocket.allowedShipmentMatched) blockers.push("LIVE_SHIPROCKET_ALLOWED_SHIPMENT_MISMATCH");
    if (runtime.mode === "DRY_RUN") warnings.push("Pilot live AWB and label creation is in dry-run mode; no live document call is allowed.");
  }

  const pickupAlignmentAllowed = !blockers.length || !blockers.some((blocker) => blocker !== "SHIPROCKET_LIVE_PICKUP_UNAVAILABLE");
  if (runtime.enabled && runtime.mode === "LIVE" && options.shipmentId && options.includePickupAlignment && pickupAlignmentAllowed) {
    pickupAlignment = await getShiprocketPickupDiagnostics(merchantId, {
      client,
      source,
      shipmentId: options.shipmentId,
      ...(options.shiprocketPickupClient ? { shiprocketClient: options.shiprocketPickupClient } : {})
    });
    blockers.push(...(pickupAlignment.blockers as string[]));
    warnings.push(...pickupAlignment.warnings);
  }

  const ready = runtime.enabled
    && runtime.pilotOnly
    && runtime.mode === "LIVE"
    && pilot.allowlisted
    && liveRatesCapabilityEnabled
    && awbLabelCapabilityEnabled
    && providerReadiness.has_active_provider
    && Boolean(shiprocketRecord)
    && shiprocket.credentialRefConfigured
    && shiprocket.credentialResolved
    && shiprocket.oneShotEnabled
    && shiprocket.oneShotApprovalPresent
    && shiprocket.allowedMerchantMatched
    && shiprocket.allowedShipmentMatched
    && (!shipment || (shipment.readyForShipNow && !shipment.hasAwb && shipmentAllowedForLive(shipment.status)))
    && !blockers.includes("SHIPROCKET_LIVE_PICKUP_UNAVAILABLE")
    && !pickupAlignment?.blockers.length;
  const status = !runtime.enabled
    ? "DISABLED"
    : blockers.length
      ? "BLOCKED"
      : runtime.mode === "DRY_RUN"
        ? "DRY_RUN"
        : "READY";
  const certificationDecision = await getCourierCertificationDecision({
    merchantId,
    providerKey: "SHIPROCKET",
    requestedCapability: "AWB",
    ...(options.shipmentId ? { shipmentId: options.shipmentId } : {})
  }, {
    client,
    certification: liveAwbDecisionSnapshot({
      status: ready ? "READY_FOR_PILOT" : "BLOCKED",
      shiprocket,
      ...(selectedRate ? { selectedRate } : {}),
      ...(pickupAlignment ? { pickupAlignment } : {}),
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
      checkedAt: new Date().toISOString()
    }),
    existingAwb: shipment?.hasAwb ?? false,
    oneShotPilotGatePassed: shiprocket.oneShotEnabled
      && shiprocket.oneShotApprovalPresent
      && shiprocket.allowedMerchantMatched
      && shiprocket.allowedShipmentMatched
  });

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
    providerReadiness: {
      hasActiveProvider: providerReadiness.has_active_provider,
      activeProviderCount: providerReadiness.active_provider_count
    },
    shiprocket,
    ...(shipment ? { shipment } : {}),
    ...(selectedRate ? { selectedRate } : {}),
    ...(pickupAlignment ? { pickupAlignment } : {}),
    certificationDecision,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
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
    includePickupAlignment?: boolean;
    shiprocketPickupClient?: ShiprocketPickupClient;
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
  if (!readiness.providerReadiness.hasActiveProvider) throw new HttpError(409, "LIVE_PROVIDER_CREDENTIALS_MISSING");
  if (!readiness.shiprocket.credentialId) throw new HttpError(409, "LIVE_SHIPPING_PROVIDER_NOT_READY");
  if (!readiness.shiprocket.credentialRefConfigured || !readiness.shiprocket.credentialResolved) {
    throw new HttpError(409, "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  }
  if (!readiness.shiprocket.oneShotEnabled || !readiness.shiprocket.oneShotApprovalPresent) {
    throw new HttpError(409, "LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED");
  }
  if (!readiness.shiprocket.allowedMerchantMatched) throw new HttpError(409, "LIVE_SHIPROCKET_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) throw new HttpError(409, "LIVE_SHIPROCKET_ALLOWED_SHIPMENT_MISMATCH");
  if (readiness.blockers.includes("SHIPROCKET_PICKUP_NOT_FOUND")) throw new HttpError(409, "SHIPROCKET_PICKUP_NOT_FOUND");
  if (readiness.blockers.includes("SHIPROCKET_PICKUP_PINCODE_MISMATCH")) throw new HttpError(409, "SHIPROCKET_PICKUP_PINCODE_MISMATCH");
  if (readiness.blockers.includes("SHIPROCKET_PICKUP_NOT_ACTIVE")) throw new HttpError(409, "SHIPROCKET_PICKUP_NOT_ACTIVE");
  if (readiness.blockers.includes("SHIPROCKET_LIVE_PICKUP_UNAVAILABLE")) {
    throw new HttpError(409, "SHIPROCKET_LIVE_PICKUP_UNAVAILABLE");
  }
  if (readiness.shipment?.hasAwb) throw new HttpError(409, "SHIPMENT_ALREADY_HAS_AWB");
  if (readiness.shipment && !shipmentAllowedForLive(readiness.shipment.status)) throw new HttpError(409, "SHIPMENT_NOT_READY_TO_SHIP");
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
    shipping_network_readiness: {
      has_active_live_credential: readiness.providerReadiness.hasActiveProvider,
      active_live_credential_count: readiness.providerReadiness.activeProviderCount
    },
    live_awb_one_shot: {
      enabled: readiness.shiprocket.oneShotEnabled,
      approval_present: readiness.shiprocket.oneShotApprovalPresent,
      allowed_merchant_matched: readiness.shiprocket.allowedMerchantMatched,
      allowed_shipment_matched: readiness.shiprocket.allowedShipmentMatched,
      credential_configured: readiness.shiprocket.credentialRefConfigured,
      credential_resolved: readiness.shiprocket.credentialResolved
    },
    ...(readiness.shipment ? {
      shipment: {
        shipment_id: readiness.shipment.shipmentId,
        status: readiness.shipment.status,
        has_awb: readiness.shipment.hasAwb,
        ready_for_ship_now: readiness.shipment.readyForShipNow
      }
    } : {}),
    ...(readiness.selectedRate ? {
      selected_rate: {
        tier: readiness.selectedRate.tier,
        found: readiness.selectedRate.found,
        live_mode: readiness.selectedRate.liveMode,
        live_ready: readiness.selectedRate.liveReady,
        pickup_available: readiness.selectedRate.pickupAvailable
      }
    } : {}),
    ...(readiness.pickupAlignment ? {
      pickup_alignment: serializeShiprocketPickupDiagnostics(readiness.pickupAlignment)
    } : {}),
    ...(readiness.certificationDecision ? {
      certification_decision: sellerSafeCourierCertificationDecision(readiness.certificationDecision)
    } : {}),
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    message: readiness.message
  };
}
