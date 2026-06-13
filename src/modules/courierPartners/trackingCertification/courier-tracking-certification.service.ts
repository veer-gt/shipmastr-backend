import { Prisma, ShipmentStatus } from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { toPrismaJson } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getLiveAwbLabelReadiness,
  type LiveAwbLabelReadiness
} from "../../shippingNetwork/shipping-live-ship-gate.service.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import { getCourierCertificationProvider } from "../certification/courier-certification.service.js";
import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import type {
  InternalCourierProviderAdapter,
  ProviderTrackingEvent,
  ProviderTrackingResult
} from "../providers/provider-adapter.types.js";
import { createShiprocketLiveAdapter } from "../providers/shiprocket/shiprocket-live.adapter.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierTrackingCertificationBlocker,
  CourierTrackingCertificationDryRunResult,
  CourierTrackingCertificationLiveReadResult,
  CourierTrackingCertificationProviderStatus,
  CourierTrackingCertificationStatus,
  CourierTrackingPublicStatus
} from "./courier-tracking-certification.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type ShipmentRecord = Awaited<ReturnType<typeof getSellerShipment>>;

type ProviderRefRecord = {
  id: string;
  courierPartnerId?: string | null;
  providerAwb?: string | null;
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
  metadata?: unknown;
};
type Source = Record<string, unknown>;

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

export const providerTrackingStatusMap: Record<string, CourierTrackingPublicStatus> = {
  created: "created",
  manifested: "manifested",
  awb_assigned: "manifested",
  label_generated: "manifested",
  pickup_pending: "pickup_pending",
  pickup_scheduled: "pickup_pending",
  picked_up: "picked_up",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  delivery_failed: "delivery_failed",
  exception: "delivery_failed",
  rto_initiated: "rto_initiated",
  rto_in_transit: "rto_initiated",
  rto_delivered: "rto_delivered",
  cancelled: "cancelled",
  canceled: "cancelled",
  unknown: "unknown"
};

function unique<T extends string>(values: Array<T | null | undefined>) {
  return [...new Set(values.filter((value): value is T => Boolean(value)))];
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boolValue(source: Source | undefined, key: string, fallback = false) {
  const value = source?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled", "live"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function sourceString(source: Source | undefined, key: string) {
  const value = source?.[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function sourceWithEnv(source?: Source) {
  return {
    ...env,
    ...(source ?? {})
  };
}

function phase6Metadata(shipment: ShipmentRecord) {
  return metadataObject(metadataObject(shipment.metadata).phase6);
}

function phase42rMetadata(shipment: ShipmentRecord) {
  return metadataObject(metadataObject(shipment.metadata).phase42r);
}

function rawProviderTrackingSafe(shipment: ShipmentRecord) {
  const trackingUrl = stringValue(shipment.trackingUrl) ?? stringValue(phase6Metadata(shipment).trackingUrl);
  if (!trackingUrl) return true;
  return !/shiprocket|shipmozo|bigship|provider|raw|token|secret|authorization|bearer/i.test(trackingUrl);
}

function publicStatusMappingReady() {
  return ["created", "manifested", "pickup_pending", "picked_up", "in_transit", "out_for_delivery", "delivered", "delivery_failed", "rto_initiated", "rto_delivered", "cancelled", "unknown"]
    .every((status) => Object.values(providerTrackingStatusMap).includes(status as CourierTrackingPublicStatus));
}

function publicSafetyReady(snapshot: CourierCertificationSnapshot, shipment: ShipmentRecord) {
  const dimension = snapshot.dimensions.find((item) => item.key === "PUBLIC_SAFETY");
  return dimension?.status === "PASS" && rawProviderTrackingSafe(shipment);
}

function providerRefReady(providerRef: ProviderRefRecord | null, shipment: ShipmentRecord) {
  return Boolean(
    shipment.awbNumber
      && providerRef
      && (providerRef.providerAwb || providerRef.providerOrderId || providerRef.providerShipmentId)
  );
}

function unsafeTrackingText(value: unknown) {
  return typeof value === "string"
    && /shiprocket|shipmozo|bigship|provider|raw|token|secret|authorization|bearer|credential|api[_-]?key|https?:\/\//i.test(value);
}

function publicStatus(value: unknown): CourierTrackingPublicStatus {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return providerTrackingStatusMap[normalized] ?? "unknown";
}

function latestPublicStatus(events: NormalizedTrackingEvent[]) {
  return events.at(-1)?.publicStatus ?? null;
}

function safeTrackingMessage(event: ProviderTrackingEvent) {
  if (unsafeTrackingText(event.message)) return "Tracking checkpoint updated.";
  return stringValue(event.message) ?? "Tracking checkpoint updated.";
}

function safeTrackingLocation(event: ProviderTrackingEvent) {
  return unsafeTrackingText(event.location) ? null : stringValue(event.location);
}

type NormalizedTrackingEvent = {
  status: ShipmentStatus;
  publicStatus: CourierTrackingPublicStatus;
  eventLabel: string;
  publicMessage: string;
  location: string | null;
  occurredAt: Date;
};

function shipmentStatus(value: unknown): ShipmentStatus {
  const raw = typeof value === "string" ? value.trim() : "";
  return (Object.values(ShipmentStatus) as string[]).includes(raw) ? raw as ShipmentStatus : ShipmentStatus.exception;
}

function normalizeTrackingEvents(result: ProviderTrackingResult): NormalizedTrackingEvent[] | null {
  if (!Array.isArray(result.events) || !result.events.length) return null;
  const events: NormalizedTrackingEvent[] = [];
  for (const event of result.events) {
    const publicStatusValue = publicStatus(event.publicStatus || event.status);
    const status = providerTrackingStatusMap[String(event.status)] === "unknown" ? "exception" : event.status;
    if (unsafeTrackingText(event.publicStatus) || unsafeTrackingText(result.latestEvent)) return null;
    events.push({
      status: shipmentStatus(status),
      publicStatus: publicStatusValue,
      eventLabel: publicStatusValue,
      publicMessage: safeTrackingMessage(event),
      location: safeTrackingLocation(event),
      occurredAt: event.checkpointTime instanceof Date ? event.checkpointTime : new Date(event.checkpointTime)
    });
  }
  return events;
}

function trackingApprovalPresent(source?: Source) {
  const token = sourceString(source, "SHIPMASTR_LIVE_SHIPROCKET_TRACKING_ONE_SHOT_TOKEN");
  const header = sourceString(source, "SHIPMASTR_LIVE_SHIPROCKET_TRACKING_ONE_SHOT_HEADER")
    || sourceString(source, "x-shipmastr-live-tracking-approval");
  return Boolean(token && header && token === header);
}

function trackingLiveGateBlockers(input: {
  readiness: LiveAwbLabelReadiness;
  source?: Source;
  merchantId: string;
  shipmentId: string;
}): CourierTrackingCertificationBlocker[] {
  const { readiness, source, merchantId, shipmentId } = input;
  const blockers: CourierTrackingCertificationBlocker[] = [];
  const liveEnabled = boolValue(source, "SHIPMASTR_LIVE_TRACKING_ENABLED", false);
  const liveMode = sourceString(source, "SHIPMASTR_LIVE_TRACKING_MODE").toUpperCase() === "LIVE";
  const pilotOnly = boolValue(source, "SHIPMASTR_LIVE_TRACKING_PILOT_ONLY", true);
  const providerEnabled = boolValue(source, "SHIPMASTR_ENABLE_LIVE_SHIPROCKET_TRACKING", false);
  const allowedMerchant = sourceString(source, "SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_MERCHANT_ID");
  const allowedShipment = sourceString(source, "SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_SHIPMENT_ID");
  if (!liveEnabled || !liveMode || !pilotOnly || !providerEnabled) blockers.push("TRACKING_CERTIFICATION_LIVE_MODE_DISABLED");
  if (!trackingApprovalPresent(source)) blockers.push("TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  if (!allowedMerchant || allowedMerchant !== merchantId) blockers.push("TRACKING_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!allowedShipment || allowedShipment !== shipmentId) {
    blockers.push("TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  }
  if (!readiness.shiprocket.credentialId || !readiness.shiprocket.credentialRefConfigured || !readiness.shiprocket.credentialResolved) {
    blockers.push("TRACKING_CERTIFICATION_CREDENTIALS_NOT_READY");
  }
  return blockers;
}

function existingTrackingCertified(shipment: ShipmentRecord) {
  return Boolean(phase42rMetadata(shipment).trackingCertified === true && phase42rMetadata(shipment).publicTrackingReady === true);
}

function liveReadAdapter(input: {
  readiness: LiveAwbLabelReadiness;
  source?: Source;
  adapter?: InternalCourierProviderAdapter;
}) {
  if (input.adapter) return input.adapter;
  if (!input.readiness.shiprocket.credentialRef) throw new HttpError(409, "TRACKING_CERTIFICATION_CREDENTIALS_NOT_READY");
  return createShiprocketLiveAdapter({
    credentialRef: input.readiness.shiprocket.credentialRef,
    source: input.source ?? {}
  });
}

async function latestProviderRef(client: Db, shipmentId: string): Promise<ProviderRefRecord | null> {
  const model = (client as Db & { shipmentProviderRef?: { findFirst?: Function } }).shipmentProviderRef;
  if (!model?.findFirst) return null;
  return model.findFirst({
    where: { shipmentId },
    orderBy: { createdAt: "desc" }
  }) as Promise<ProviderRefRecord | null>;
}

function trackingAdapterReady(providerKey: CourierLiveProviderKey, override?: boolean) {
  if (typeof override === "boolean") return override;
  // Shiprocket live tracking is intentionally not enabled yet; this foundation only validates readiness.
  return providerKey !== "SHIPROCKET";
}

function sellerMessage(input: { awbReady: boolean; dryRunReady: boolean; liveReadReady: boolean }) {
  if (!input.awbReady) return "Tracking is not ready yet.";
  if (input.liveReadReady) return "Tracking is ready for a controlled live-read check.";
  if (input.dryRunReady) return "Shipping setup is still being verified.";
  return "Shipmastr will update tracking after shipment is created.";
}

function statusFor(input: {
  awbReady: boolean;
  trackingRefReady: boolean;
  adapterReady: boolean;
  dryRunReady: boolean;
  liveReadReady: boolean;
}): CourierTrackingCertificationStatus {
  if (!input.awbReady) return "MISSING_AWB";
  if (!input.trackingRefReady) return "MISSING_TRACKING_REF";
  if (!input.adapterReady) return "ADAPTER_MISSING";
  if (input.liveReadReady) return "READY_FOR_LIVE_READ";
  if (input.dryRunReady) return "DRY_RUN_ONLY";
  return "BLOCKED";
}

function liveGateBlockers(readiness: LiveAwbLabelReadiness): CourierTrackingCertificationBlocker[] {
  const blockers: CourierTrackingCertificationBlocker[] = [];
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE") blockers.push("TRACKING_CERTIFICATION_LIVE_MODE_DISABLED");
  if (!readiness.shiprocket.oneShotEnabled || !readiness.shiprocket.oneShotApprovalPresent) blockers.push("TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  if (!readiness.shiprocket.allowedMerchantMatched) blockers.push("TRACKING_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) blockers.push("TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  return blockers;
}

function adminNextActions(blockers: CourierTrackingCertificationBlocker[]) {
  const actions: string[] = [];
  if (blockers.includes("TRACKING_CERTIFICATION_AWB_MISSING")) actions.push("Complete AWB certification before attempting tracking certification.");
  if (blockers.includes("TRACKING_CERTIFICATION_REF_MISSING")) actions.push("Confirm the shipment has safe tracking/provider references.");
  if (blockers.includes("TRACKING_CERTIFICATION_CREDENTIALS_NOT_READY")) actions.push("Resolve live credential readiness before attempting tracking certification.");
  if (blockers.includes("TRACKING_CERTIFICATION_ADAPTER_MISSING")) actions.push("Keep tracking certification blocked until the provider tracking adapter is ready.");
  if (blockers.includes("TRACKING_CERTIFICATION_APPROVAL_REQUIRED") || blockers.includes("TRACKING_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED")) {
    actions.push("Provide explicit live-read approval only after tracking dry-run readiness passes.");
  }
  if (blockers.includes("TRACKING_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH")) actions.push("Align the pilot merchant allowlist before tracking certification.");
  if (blockers.includes("TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH")) actions.push("Align the pilot shipment allowlist before tracking certification.");
  if (blockers.includes("TRACKING_CERTIFICATION_LIVE_MODE_DISABLED")) actions.push("Keep tracking certification in dry-run review until live tracking mode is explicitly enabled.");
  if (blockers.includes("TRACKING_CERTIFICATION_PROVIDER_CALL_FAILED")) actions.push("Review the safe failure summary, fix the cause, then rerun tracking live-read only with explicit approval.");
  if (blockers.includes("TRACKING_CERTIFICATION_PROVIDER_RESPONSE_INVALID")) actions.push("Keep tracking certification blocked until the provider tracking response mapper is fixed.");
  if (!actions.length) actions.push("Proceed only through a future explicit live-read tracking gate; this foundation does not call tracking.");
  return unique(actions);
}

export async function getCourierTrackingCertificationProviderStatus(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: { client?: Db } = {}
): Promise<CourierTrackingCertificationProviderStatus> {
  const client = options.client ?? prisma;
  const { provider } = await getCourierCertificationProvider(merchantId, providerKey, {
    client,
    includePickupProbe: false
  });
  const trackingDimension = provider.dimensions.find((dimension) => dimension.key === "TRACKING");
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    sandbox_available: providerKey === "SHIPROCKET",
    status: providerKey === "SHIPROCKET" ? "READY_FOR_DRY_RUN" : "UNSUPPORTED",
    tracking_dimension_status: trackingDimension?.status ?? "NOT_RUN",
    can_use_for_tracking: provider.can_use_for_tracking,
    public_status_mapping: providerTrackingStatusMap,
    blockers: providerKey === "SHIPROCKET" ? provider.blockers : ["TRACKING_CERTIFICATION_ADAPTER_MISSING"],
    warnings: provider.warnings,
    next_actions: providerKey === "SHIPROCKET"
      ? ["Run the tracking certification foundation after AWB and label readiness are complete."]
      : ["Keep this provider in safe review until tracking certification support is added."]
  };
}

export async function runCourierTrackingCertificationDryRun(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: {
    shipmentId: string;
    pickupLocationId?: string;
  },
  options: {
    client?: Db;
    liveReadinessProvider?: () => Promise<LiveAwbLabelReadiness>;
    certificationProvider?: () => Promise<CourierCertificationSnapshot>;
    trackingAdapterReady?: boolean;
    trackingMapperReady?: boolean;
  } = {}
): Promise<CourierTrackingCertificationDryRunResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "TRACKING_CERTIFICATION_PROVIDER_UNSUPPORTED");
  const client = options.client ?? prisma;
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const pickupLocationId = input.pickupLocationId ?? shipment.pickupLocationId ?? null;
  const [providerRef, readiness, snapshot] = await Promise.all([
    latestProviderRef(client, shipment.id),
    options.liveReadinessProvider
      ? options.liveReadinessProvider()
      : getLiveAwbLabelReadiness(merchantId, {
        client,
        shipmentId: shipment.id,
        includePickupAlignment: false
      }),
    options.certificationProvider
      ? options.certificationProvider()
      : getCourierCertificationProvider(merchantId, providerKey, {
        client,
        includePickupProbe: false,
        shipmentId: shipment.id,
        ...(pickupLocationId ? { pickupLocationId } : {})
      }).then((result) => result.provider)
  ]);

  const mapperReady = options.trackingMapperReady ?? true;
  const payloadReadiness = {
    awb_ready: Boolean(shipment.awbNumber),
    tracking_ref_ready: providerRefReady(providerRef, shipment),
    tracking_adapter_ready: trackingAdapterReady(providerKey, options.trackingAdapterReady),
    tracking_mapper_ready: mapperReady,
    public_status_mapping_ready: publicStatusMappingReady(),
    no_raw_provider_tracking_leak: rawProviderTrackingSafe(shipment)
  };
  const blockers: CourierTrackingCertificationBlocker[] = [];
  if (!payloadReadiness.awb_ready) blockers.push("TRACKING_CERTIFICATION_AWB_MISSING");
  if (!payloadReadiness.tracking_ref_ready) blockers.push("TRACKING_CERTIFICATION_REF_MISSING");
  if (!payloadReadiness.tracking_adapter_ready) blockers.push("TRACKING_CERTIFICATION_ADAPTER_MISSING");
  if (!payloadReadiness.tracking_mapper_ready) blockers.push("TRACKING_CERTIFICATION_MAPPER_MISSING");
  if (!payloadReadiness.public_status_mapping_ready) blockers.push("TRACKING_CERTIFICATION_PUBLIC_MAPPING_NOT_READY");
  if (!publicSafetyReady(snapshot, shipment)) blockers.push("TRACKING_CERTIFICATION_PUBLIC_MAPPING_NOT_READY");
  if (!payloadReadiness.no_raw_provider_tracking_leak) blockers.push("TRACKING_CERTIFICATION_RAW_PROVIDER_PAYLOAD_BLOCKED");
  const payloadBlockerCount = blockers.length;
  blockers.push(...liveGateBlockers(readiness));

  const dryRunReady = payloadBlockerCount === 0;
  const liveReadReady = dryRunReady && readiness.ready;
  const finalBlockers = unique(blockers);
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: shipment.id,
    pickup_location_id: pickupLocationId,
    dry_run_ready: dryRunReady,
    live_read_ready: liveReadReady,
    status: statusFor({
      awbReady: payloadReadiness.awb_ready,
      trackingRefReady: payloadReadiness.tracking_ref_ready,
      adapterReady: payloadReadiness.tracking_adapter_ready,
      dryRunReady,
      liveReadReady
    }),
    payload_readiness: payloadReadiness,
    live_gate_readiness: {
      tracking_live_enabled: readiness.runtime.enabled,
      live_mode: readiness.runtime.mode === "LIVE",
      pilot_only: readiness.runtime.pilotOnly,
      allowed_merchant_matched: readiness.shiprocket.allowedMerchantMatched,
      allowed_shipment_matched: readiness.shiprocket.allowedShipmentMatched,
      approval_present: readiness.shiprocket.oneShotApprovalPresent,
      live_read_ready: liveReadReady
    },
    blockers: finalBlockers,
    warnings: unique([
      ...readiness.warnings,
      "Tracking certification foundation is read-only and does not call live tracking."
    ]),
    seller_safe_message: sellerMessage({
      awbReady: payloadReadiness.awb_ready,
      dryRunReady,
      liveReadReady
    }),
    admin_next_actions: adminNextActions(finalBlockers)
  };
}

function blockedResult(input: {
  providerKey: CourierLiveProviderKey;
  shipmentId: string;
  blockers: CourierTrackingCertificationBlocker[];
  warnings?: string[];
  alreadyCertified?: boolean;
  normalizedEventsCount?: number;
  latestPublicStatus?: CourierTrackingPublicStatus | null;
}): CourierTrackingCertificationLiveReadResult {
  return {
    success: false,
    provider_key: input.providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: input.shipmentId,
    tracking_status: input.alreadyCertified ? "ALREADY_CERTIFIED" : "BLOCKED",
    public_tracking_status: input.alreadyCertified ? "READY" : "NOT_READY",
    normalized_events_count: input.normalizedEventsCount ?? 0,
    latest_public_status: input.latestPublicStatus ?? null,
    certification_status: input.alreadyCertified ? "ALREADY_CERTIFIED" : "BLOCKED",
    blockers: unique(input.blockers),
    warnings: unique(input.warnings ?? []),
    seller_safe_message: input.alreadyCertified
      ? "Shipping tracking will be available after shipment certification."
      : "Tracking is not ready yet.",
    admin_next_actions: adminNextActions(input.blockers)
  };
}

export async function runCourierTrackingCertificationLiveReadOneShot(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: {
    shipmentId: string;
    operatorNote?: string | null;
  },
  options: {
    client?: Db;
    source?: Source;
    adapter?: InternalCourierProviderAdapter;
    liveReadinessProvider?: () => Promise<LiveAwbLabelReadiness>;
    certificationProvider?: () => Promise<CourierCertificationSnapshot>;
    trackingAdapterReady?: boolean;
    trackingMapperReady?: boolean;
  } = {}
): Promise<CourierTrackingCertificationLiveReadResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "TRACKING_CERTIFICATION_PROVIDER_UNSUPPORTED");
  const client = options.client ?? prisma;
  const source = sourceWithEnv(options.source);
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const phase42r = phase42rMetadata(shipment);
  if (existingTrackingCertified(shipment)) {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: [],
      warnings: ["Existing tracking certification was found; no provider call was made."],
      alreadyCertified: true,
      normalizedEventsCount: Number(phase42r.normalizedEventsCount ?? 0),
      latestPublicStatus: publicStatus(phase42r.latestPublicStatus)
    });
  }

  const readinessProvider = options.liveReadinessProvider
    ? options.liveReadinessProvider
    : () => getLiveAwbLabelReadiness(merchantId, {
      client,
      shipmentId: shipment.id,
      includePickupAlignment: false,
      source
    });
  const dryRun = await runCourierTrackingCertificationDryRun(merchantId, providerKey, {
    shipmentId: shipment.id
  }, {
    client,
    liveReadinessProvider: readinessProvider,
    ...(options.certificationProvider ? { certificationProvider: options.certificationProvider } : {}),
    ...(options.trackingAdapterReady === undefined ? {} : { trackingAdapterReady: options.trackingAdapterReady }),
    ...(options.trackingMapperReady === undefined ? {} : { trackingMapperReady: options.trackingMapperReady })
  });
  const readiness = await readinessProvider();
  const payloadBlockers: CourierTrackingCertificationBlocker[] = [];
  if (!dryRun.payload_readiness.awb_ready) payloadBlockers.push("TRACKING_CERTIFICATION_AWB_MISSING");
  if (!dryRun.payload_readiness.tracking_ref_ready) payloadBlockers.push("TRACKING_CERTIFICATION_REF_MISSING");
  if (!dryRun.payload_readiness.tracking_adapter_ready) payloadBlockers.push("TRACKING_CERTIFICATION_ADAPTER_MISSING");
  if (!dryRun.payload_readiness.tracking_mapper_ready) payloadBlockers.push("TRACKING_CERTIFICATION_MAPPER_MISSING");
  if (!dryRun.payload_readiness.public_status_mapping_ready) payloadBlockers.push("TRACKING_CERTIFICATION_PUBLIC_MAPPING_NOT_READY");
  if (!dryRun.payload_readiness.no_raw_provider_tracking_leak) payloadBlockers.push("TRACKING_CERTIFICATION_RAW_PROVIDER_PAYLOAD_BLOCKED");
  const blockers = unique([
    ...payloadBlockers,
    ...trackingLiveGateBlockers({
      readiness,
      source,
      merchantId,
      shipmentId: shipment.id
    })
  ]);
  if (blockers.length) {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers,
      warnings: dryRun.warnings
    });
  }

  const providerRef = await latestProviderRef(client, shipment.id);
  if (!providerRefReady(providerRef, shipment)) {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["TRACKING_CERTIFICATION_REF_MISSING"],
      warnings: ["Internal tracking/provider references are missing; no provider tracking call was made."]
    });
  }

  const adapter = liveReadAdapter({
    readiness,
    source,
    ...(options.adapter ? { adapter: options.adapter } : {})
  });

  try {
    const tracking = await adapter.trackOrder({
      awb: providerRef?.providerAwb ?? shipment.awbNumber,
      trackingNumber: shipment.awbNumber,
      providerOrderId: providerRef?.providerOrderId ?? providerRef?.providerShipmentId ?? null
    });
    const events = normalizeTrackingEvents(tracking);
    if (!events) {
      return blockedResult({
        providerKey,
        shipmentId: shipment.id,
        blockers: ["TRACKING_CERTIFICATION_PROVIDER_RESPONSE_INVALID"],
        warnings: ["Provider tracking response was not safe to certify."]
      });
    }
    const latest = latestPublicStatus(events);
    const eventModel = (client as Db & { shipmentTrackingEvent?: { create?: Function } }).shipmentTrackingEvent;
    if (eventModel?.create) {
      for (const event of events) {
        await eventModel.create({
          data: {
            shipmentId: shipment.id,
            courierPartnerId: providerRef?.courierPartnerId ?? null,
            status: event.status,
            eventCode: event.publicStatus,
            eventLabel: event.eventLabel,
            publicMessage: event.publicMessage,
            location: event.location,
            occurredAt: event.occurredAt,
            metadata: toPrismaJson({
              source: "tracking_certification",
              rawProviderPayloadStored: false,
              rawProviderHeadersStored: false
            })
          }
        });
      }
    }

    const metadata = metadataObject(shipment.metadata);
    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        status: events.at(-1)?.status ?? shipment.status,
        metadata: toPrismaJson({
          ...metadata,
          phase42r: {
            ...phase42rMetadata(shipment),
            trackingCertified: true,
            trackingCertifiedAt: new Date().toISOString(),
            publicTrackingReady: true,
            latestPublicStatus: latest,
            normalizedEventsCount: events.length,
            operatorNote: input.operatorNote ?? null,
            rawProviderPayloadStored: false,
            rawProviderHeadersStored: false
          }
        })
      }
    });

    return {
      success: true,
      provider_key: providerKey,
      public_network_name: PUBLIC_NETWORK_NAME,
      shipment_id: shipment.id,
      tracking_status: "CERTIFIED",
      public_tracking_status: "READY",
      normalized_events_count: events.length,
      latest_public_status: latest,
      certification_status: "TRACKING_CERTIFIED",
      blockers: [],
      warnings: ["Tracking certification succeeded with safe normalized events only."],
      seller_safe_message: "Shipping tracking will be available after shipment certification.",
      admin_next_actions: ["Tracking certification is complete; continue pilot review without exposing provider details."]
    };
  } catch {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["TRACKING_CERTIFICATION_PROVIDER_CALL_FAILED"],
      warnings: ["Provider tracking call failed safely. No tracking ready state was stored."]
    });
  }
}
