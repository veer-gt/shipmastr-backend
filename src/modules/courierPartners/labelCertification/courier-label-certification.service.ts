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
import { getCourierLiveProviderDefinition } from "../liveReadiness/courier-live-readiness.providers.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierLabelCertificationBlocker,
  CourierLabelCertificationDryRunResult,
  CourierLabelCertificationProviderStatus,
  CourierLabelCertificationStatus
} from "./courier-label-certification.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type ShipmentRecord = Awaited<ReturnType<typeof getSellerShipment>>;

type ProviderRefRecord = {
  id: string;
  providerAwb?: string | null;
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
  providerPickupId?: string | null;
};

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

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

function rawProviderLabelSafe(shipment: ShipmentRecord) {
  const labelUrl = stringValue(phase6Metadata(shipment).labelUrl);
  if (!labelUrl) return true;
  return !/shiprocket|shipmozo|bigship|provider|raw|token|secret|authorization|bearer/i.test(labelUrl);
}

function publicSafetyReady(snapshot: CourierCertificationSnapshot, shipment: ShipmentRecord) {
  const dimension = snapshot.dimensions.find((item) => item.key === "PUBLIC_SAFETY");
  return dimension?.status === "PASS" && rawProviderLabelSafe(shipment);
}

function providerRefReady(providerRef: ProviderRefRecord | null) {
  return Boolean(providerRef && (providerRef.providerOrderId || providerRef.providerShipmentId));
}

async function latestProviderRef(client: Db, shipmentId: string): Promise<ProviderRefRecord | null> {
  const model = (client as Db & { shipmentProviderRef?: { findFirst?: Function } }).shipmentProviderRef;
  if (!model?.findFirst) return null;
  return model.findFirst({
    where: { shipmentId },
    orderBy: { createdAt: "desc" }
  }) as Promise<ProviderRefRecord | null>;
}

function sellerMessage(input: { dryRunReady: boolean; liveOneShotReady: boolean; awbReady: boolean }) {
  if (!input.awbReady) return "Shipping label is not ready yet.";
  if (input.liveOneShotReady) return "Shipping setup is ready for a controlled label approval check.";
  if (input.dryRunReady) return "Shipping setup is still being verified.";
  return "Shipmastr will keep this shipment in review.";
}

function statusFor(input: {
  awbReady: boolean;
  providerRefsReady: boolean;
  dryRunReady: boolean;
  liveOneShotReady: boolean;
}): CourierLabelCertificationStatus {
  if (!input.awbReady) return "MISSING_AWB";
  if (!input.providerRefsReady) return "MISSING_PROVIDER_REFS";
  if (input.liveOneShotReady) return "READY_FOR_ONE_SHOT";
  if (input.dryRunReady) return "DRY_RUN_ONLY";
  return "BLOCKED";
}

function liveGateBlockers(readiness: LiveAwbLabelReadiness): CourierLabelCertificationBlocker[] {
  const blockers: CourierLabelCertificationBlocker[] = [];
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE") blockers.push("LABEL_CERTIFICATION_LIVE_MODE_DISABLED");
  if (!readiness.shiprocket.oneShotEnabled || !readiness.shiprocket.oneShotApprovalPresent) blockers.push("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  if (!readiness.shiprocket.allowedMerchantMatched) blockers.push("LABEL_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) blockers.push("LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  return blockers;
}

function adminNextActions(blockers: CourierLabelCertificationBlocker[]) {
  const actions: string[] = [];
  if (blockers.includes("LABEL_CERTIFICATION_AWB_MISSING")) actions.push("Complete AWB certification before attempting label certification.");
  if (blockers.includes("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING")) actions.push("Confirm the shipment has safe internal provider references from AWB creation.");
  if (blockers.includes("LABEL_CERTIFICATION_ADAPTER_MISSING")) actions.push("Keep label certification blocked until the provider label adapter is ready.");
  if (blockers.includes("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED")) actions.push("Provide explicit one-shot approval only after label dry-run readiness passes.");
  if (blockers.includes("LABEL_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH")) actions.push("Align the pilot merchant allowlist before label certification.");
  if (blockers.includes("LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH")) actions.push("Align the pilot shipment allowlist before label certification.");
  if (!actions.length) actions.push("Proceed only through the existing explicit Ship Now one-shot gate; this sandbox does not generate labels.");
  return unique(actions);
}

function providerLabelAdapterReady(providerKey: CourierLiveProviderKey, override?: boolean) {
  if (typeof override === "boolean") return override;
  return providerKey === "SHIPROCKET" && getCourierLiveProviderDefinition(providerKey).supportsAwbLabelReadiness;
}

export async function getCourierLabelCertificationProviderStatus(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: { client?: Db } = {}
): Promise<CourierLabelCertificationProviderStatus> {
  const client = options.client ?? prisma;
  const { provider } = await getCourierCertificationProvider(merchantId, providerKey, {
    client,
    includePickupProbe: false
  });
  const labelDimension = provider.dimensions.find((dimension) => dimension.key === "LABEL");
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    sandbox_available: providerKey === "SHIPROCKET",
    status: providerKey === "SHIPROCKET" ? "READY_FOR_DRY_RUN" : "UNSUPPORTED",
    label_dimension_status: labelDimension?.status ?? "NOT_RUN",
    can_use_for_label: provider.can_use_for_label,
    blockers: providerKey === "SHIPROCKET" ? provider.blockers : ["LABEL_CERTIFICATION_ADAPTER_MISSING"],
    warnings: provider.warnings,
    next_actions: providerKey === "SHIPROCKET"
      ? ["Run the label certification sandbox after AWB exists and before any explicit label attempt."]
      : ["Keep this provider in safe review until label sandbox support is added."]
  };
}

export async function runCourierLabelCertificationDryRun(
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
    labelAdapterReady?: boolean;
  } = {}
): Promise<CourierLabelCertificationDryRunResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "LABEL_CERTIFICATION_PROVIDER_UNSUPPORTED");
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

  const payloadReadiness = {
    awb_ready: Boolean(shipment.awbNumber),
    provider_refs_ready: providerRefReady(providerRef),
    label_adapter_ready: providerLabelAdapterReady(providerKey, options.labelAdapterReady),
    label_public_safety_ready: publicSafetyReady(snapshot, shipment),
    no_raw_provider_label_leak: rawProviderLabelSafe(shipment)
  };
  const blockers: CourierLabelCertificationBlocker[] = [];
  if (!payloadReadiness.awb_ready) blockers.push("LABEL_CERTIFICATION_AWB_MISSING");
  if (!payloadReadiness.provider_refs_ready) blockers.push("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING");
  if (!payloadReadiness.label_adapter_ready) blockers.push("LABEL_CERTIFICATION_ADAPTER_MISSING");
  if (!payloadReadiness.label_public_safety_ready) blockers.push("LABEL_CERTIFICATION_PUBLIC_SAFETY_NOT_READY");
  if (!payloadReadiness.no_raw_provider_label_leak) blockers.push("LABEL_CERTIFICATION_RAW_PROVIDER_URL_BLOCKED");
  const payloadBlockerCount = blockers.length;
  blockers.push(...liveGateBlockers(readiness));

  const dryRunReady = payloadBlockerCount === 0;
  const liveOneShotReady = dryRunReady && readiness.ready;
  const finalBlockers = unique(blockers);
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: shipment.id,
    pickup_location_id: pickupLocationId,
    dry_run_ready: dryRunReady,
    live_one_shot_ready: liveOneShotReady,
    status: statusFor({
      awbReady: payloadReadiness.awb_ready,
      providerRefsReady: payloadReadiness.provider_refs_ready,
      dryRunReady,
      liveOneShotReady
    }),
    payload_readiness: payloadReadiness,
    live_gate_readiness: {
      label_live_enabled: readiness.runtime.enabled,
      live_mode: readiness.runtime.mode === "LIVE",
      pilot_only: readiness.runtime.pilotOnly,
      allowed_merchant_matched: readiness.shiprocket.allowedMerchantMatched,
      allowed_shipment_matched: readiness.shiprocket.allowedShipmentMatched,
      approval_present: readiness.shiprocket.oneShotApprovalPresent,
      one_shot_ready: liveOneShotReady
    },
    blockers: finalBlockers,
    warnings: unique([
      ...readiness.warnings,
      "Label certification sandbox is read-only and does not generate labels."
    ]),
    seller_safe_message: sellerMessage({
      dryRunReady,
      liveOneShotReady,
      awbReady: payloadReadiness.awb_ready
    }),
    admin_next_actions: adminNextActions(finalBlockers)
  };
}
