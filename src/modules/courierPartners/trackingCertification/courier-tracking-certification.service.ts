import { Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  getLiveAwbLabelReadiness,
  type LiveAwbLabelReadiness
} from "../../shippingNetwork/shipping-live-ship-gate.service.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import { getCourierCertificationProvider } from "../certification/courier-certification.service.js";
import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierTrackingCertificationBlocker,
  CourierTrackingCertificationDryRunResult,
  CourierTrackingCertificationProviderStatus,
  CourierTrackingCertificationStatus,
  CourierTrackingPublicStatus
} from "./courier-tracking-certification.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type ShipmentRecord = Awaited<ReturnType<typeof getSellerShipment>>;

type ProviderRefRecord = {
  id: string;
  providerAwb?: string | null;
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
};

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

function phase6Metadata(shipment: ShipmentRecord) {
  return metadataObject(metadataObject(shipment.metadata).phase6);
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
  if (!readiness.shiprocket.oneShotEnabled || !readiness.shiprocket.oneShotApprovalPresent) blockers.push("TRACKING_CERTIFICATION_APPROVAL_REQUIRED");
  if (!readiness.shiprocket.allowedMerchantMatched) blockers.push("TRACKING_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) blockers.push("TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  return blockers;
}

function adminNextActions(blockers: CourierTrackingCertificationBlocker[]) {
  const actions: string[] = [];
  if (blockers.includes("TRACKING_CERTIFICATION_AWB_MISSING")) actions.push("Complete AWB certification before attempting tracking certification.");
  if (blockers.includes("TRACKING_CERTIFICATION_REF_MISSING")) actions.push("Confirm the shipment has safe tracking/provider references.");
  if (blockers.includes("TRACKING_CERTIFICATION_ADAPTER_MISSING")) actions.push("Keep tracking certification blocked until the provider tracking adapter is ready.");
  if (blockers.includes("TRACKING_CERTIFICATION_APPROVAL_REQUIRED")) actions.push("Provide explicit live-read approval only after tracking dry-run readiness passes.");
  if (blockers.includes("TRACKING_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH")) actions.push("Align the pilot merchant allowlist before tracking certification.");
  if (blockers.includes("TRACKING_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH")) actions.push("Align the pilot shipment allowlist before tracking certification.");
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
