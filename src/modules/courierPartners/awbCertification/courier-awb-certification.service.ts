import { Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import {
  getLiveAwbLabelReadiness,
  type LiveAwbLabelReadiness
} from "../../shippingNetwork/shipping-live-ship-gate.service.js";
import {
  getCourierCertificationProvider
} from "../certification/courier-certification.service.js";
import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import { diagnoseCourierPickupServiceability } from "../pickupServiceability/courier-pickup-serviceability.service.js";
import type { CourierPickupServiceabilityResult } from "../pickupServiceability/courier-pickup-serviceability.types.js";
import type {
  CourierAwbCertificationBlocker,
  CourierAwbCertificationDryRunResult,
  CourierAwbCertificationProviderStatus,
  CourierAwbCertificationStatus,
  CourierAwbCertificationTier
} from "./courier-awb-certification.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type ShipmentRecord = Awaited<ReturnType<typeof getSellerShipment>>;

type PickupRecord = {
  id: string;
  sellerId?: string | null;
  pincode?: string | null;
  status?: string | null;
};

type RateRecord = {
  id: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  rateBreakup?: unknown;
  amountPaise?: number | null;
  createdAt?: Date | string;
};

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

function unique<T extends string>(values: Array<T | null | undefined>) {
  return [...new Set(values.filter((value): value is T => Boolean(value)))];
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function positiveNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value) > 0;
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return Number(value.toNumber()) > 0;
  }
  return false;
}

function shipmentMetadata(value: unknown) {
  return metadataObject(value);
}

function isTierRate(rate: RateRecord, tier: CourierAwbCertificationTier | null) {
  const code = tier ? `shipmastr_${tier}` : "shipmastr_smart";
  const name = tier ? `Shipmastr ${tier[0]!.toUpperCase()}${tier.slice(1)}` : "Shipmastr Smart";
  return rate.publicServiceCode === code || rate.publicServiceName === name;
}

function rateCourierId(rate: RateRecord | null) {
  const metadata = metadataObject(rate?.rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const result = metadataObject(metadata.result);
  const value = firstString(
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

function rateLiveReady(rate: RateRecord | null) {
  const metadata = metadataObject(rate?.rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const mode = firstString(phase6.livePilotRatesMode, metadata.livePilotRatesMode);
  return Boolean(rate && mode === "LIVE" && (phase6.livePilotRatesReady === true || metadata.livePilotRatesReady === true));
}

async function selectedPickup(merchantId: string, pickupLocationId: string | null, client: Db): Promise<PickupRecord | null> {
  if (!pickupLocationId) return null;
  return client.pickupLocation.findFirst({
    where: {
      id: pickupLocationId,
      sellerId: merchantId
    }
  }) as Promise<PickupRecord | null>;
}

async function selectedRate(
  merchantId: string,
  shipmentId: string,
  requestedTier: CourierAwbCertificationTier | null,
  client: Db
) {
  const rows = await client.shipmentRate.findMany({
    where: {
      sellerId: merchantId,
      shipmentId
    },
    orderBy: { createdAt: "desc" },
    take: 25
  }) as RateRecord[];
  return rows.find((rate) => isTierRate(rate, requestedTier)) ?? rows[0] ?? null;
}

function packageReady(shipment: ShipmentRecord) {
  return positiveNumber(shipment.deadWeightKg)
    && positiveNumber(shipment.lengthCm)
    && positiveNumber(shipment.breadthCm)
    && positiveNumber(shipment.heightCm);
}

function invoiceReady(shipment: ShipmentRecord) {
  const metadata = shipmentMetadata(shipment.metadata);
  const invoice = metadataObject(metadata.invoice);
  return positiveNumber(shipment.declaredValuePaise) || positiveNumber(invoice.invoice_amount) || positiveNumber(invoice.invoiceAmount);
}

function deliveryReady(shipment: ShipmentRecord) {
  return Boolean(shipment.toPincode && String(shipment.toPincode).trim());
}

function publicSafetyReady(snapshot: CourierCertificationSnapshot) {
  const dimension = snapshot.dimensions.find((item) => item.key === "PUBLIC_SAFETY");
  return dimension?.status === "PASS";
}

function credentialReady(readiness: LiveAwbLabelReadiness, snapshot: CourierCertificationSnapshot) {
  const credentialDimension = snapshot.dimensions.find((item) => item.key === "CREDENTIALS");
  return Boolean(
    readiness.shiprocket.credentialRefConfigured
      && readiness.shiprocket.credentialResolved
      && readiness.shiprocket.credentialId
      && (!credentialDimension || credentialDimension.status === "PASS")
  );
}

function sellerMessage(result: { dryRunReady: boolean; liveOneShotReady: boolean; pickupUnavailable: boolean }) {
  if (result.liveOneShotReady) return "This shipment is ready for a controlled shipping approval check.";
  if (result.pickupUnavailable) return "Try another pickup location.";
  if (result.dryRunReady) return "This shipment passed payload checks, but live shipping approval is still required.";
  return "This shipment is not ready for shipping yet.";
}

function adminNextActions(blockers: CourierAwbCertificationBlocker[]) {
  const actions: string[] = [];
  if (blockers.includes("AWB_CERTIFICATION_PICKUP_UNAVAILABLE")) actions.push("Try another pickup location before attempting AWB certification.");
  if (blockers.includes("AWB_CERTIFICATION_COURIER_ID_MISSING")) actions.push("Refresh pilot live rates and confirm a numeric internal courier mapping is present.");
  if (blockers.includes("AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED")) actions.push("Provide explicit one-shot AWB approval only after payload readiness passes.");
  if (blockers.includes("AWB_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH")) actions.push("Align the one-shot merchant allowlist before live certification.");
  if (blockers.includes("AWB_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH")) actions.push("Align the one-shot shipment allowlist before live certification.");
  if (blockers.includes("AWB_CERTIFICATION_LIVE_MODE_DISABLED")) actions.push("Keep this shipment in dry-run review until live AWB mode is explicitly enabled.");
  if (!actions.length) actions.push("Proceed only through the existing explicit one-shot Ship Now gate; this sandbox does not create AWB.");
  return unique(actions);
}

function statusFor(input: {
  existingAwb: boolean;
  dryRunReady: boolean;
  liveOneShotReady: boolean;
}): CourierAwbCertificationStatus {
  if (input.existingAwb) return "ALREADY_HAS_AWB";
  if (input.liveOneShotReady) return "READY_FOR_ONE_SHOT";
  if (input.dryRunReady) return "DRY_RUN_ONLY";
  return "BLOCKED";
}

function liveGateBlockers(readiness: LiveAwbLabelReadiness): CourierAwbCertificationBlocker[] {
  const blockers: CourierAwbCertificationBlocker[] = [];
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE") blockers.push("AWB_CERTIFICATION_LIVE_MODE_DISABLED");
  if (!readiness.shiprocket.oneShotEnabled || !readiness.shiprocket.oneShotApprovalPresent) blockers.push("AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  if (!readiness.shiprocket.allowedMerchantMatched) blockers.push("AWB_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) blockers.push("AWB_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  return blockers;
}

export async function getCourierAwbCertificationProviderStatus(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: { client?: Db } = {}
): Promise<CourierAwbCertificationProviderStatus> {
  const client = options.client ?? prisma;
  const { provider } = await getCourierCertificationProvider(merchantId, providerKey, {
    client,
    includePickupProbe: false
  });
  const awbDimension = provider.dimensions.find((dimension) => dimension.key === "AWB");
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    sandbox_available: providerKey === "SHIPROCKET",
    status: providerKey === "SHIPROCKET" ? "READY_FOR_DRY_RUN" : "UNSUPPORTED",
    awb_dimension_status: awbDimension?.status ?? "NOT_RUN",
    can_use_for_awb: provider.can_use_for_awb,
    blockers: providerKey === "SHIPROCKET" ? provider.blockers : ["AWB_CERTIFICATION_PROVIDER_UNSUPPORTED"],
    warnings: provider.warnings,
    next_actions: providerKey === "SHIPROCKET"
      ? ["Run the AWB certification sandbox before any explicit one-shot AWB attempt."]
      : ["Keep this provider in safe review until AWB sandbox support is added."]
  };
}

export async function runCourierAwbCertificationDryRun(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: {
    shipmentId: string;
    pickupLocationId?: string;
    requestedTier?: CourierAwbCertificationTier | null;
  },
  options: {
    client?: Db;
    liveReadinessProvider?: () => Promise<LiveAwbLabelReadiness>;
    certificationProvider?: () => Promise<CourierCertificationSnapshot>;
    pickupServiceabilityProvider?: () => Promise<CourierPickupServiceabilityResult>;
  } = {}
): Promise<CourierAwbCertificationDryRunResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "AWB_CERTIFICATION_PROVIDER_UNSUPPORTED");
  const client = options.client ?? prisma;
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const pickupLocationId = input.pickupLocationId ?? shipment.pickupLocationId ?? null;
  const [pickup, rate, readiness, snapshot, pickupServiceability] = await Promise.all([
    selectedPickup(merchantId, pickupLocationId, client),
    selectedRate(merchantId, shipment.id, input.requestedTier ?? "smart", client),
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
      }).then((result) => result.provider),
    options.pickupServiceabilityProvider
      ? options.pickupServiceabilityProvider()
      : diagnoseCourierPickupServiceability(merchantId, {
        providerKey,
        shipmentId: shipment.id,
        ...(pickupLocationId ? { pickupLocationId } : {})
      }, { client })
  ]);

  const existingAwb = Boolean(shipment.awbNumber);
  const pickupUnavailable = pickupServiceability.status === "PICKUP_UNAVAILABLE";
  const payloadReadiness = {
    merchant_ready: true,
    credential_ready: credentialReady(readiness, snapshot),
    pickup_ready: Boolean(pickup && pickup.status === "active" && pickup.pincode),
    delivery_ready: deliveryReady(shipment),
    package_ready: packageReady(shipment),
    invoice_ready: invoiceReady(shipment),
    selected_rate_ready: rateLiveReady(rate),
    courier_id_ready: Boolean(rateCourierId(rate)),
    no_existing_awb: !existingAwb,
    public_safety_ready: publicSafetyReady(snapshot)
  };
  const blockers: CourierAwbCertificationBlocker[] = [];
  if (!payloadReadiness.credential_ready) blockers.push("AWB_CERTIFICATION_CREDENTIALS_NOT_READY");
  if (!payloadReadiness.pickup_ready) blockers.push("AWB_CERTIFICATION_PICKUP_NOT_READY");
  if (pickupUnavailable) blockers.push("AWB_CERTIFICATION_PICKUP_UNAVAILABLE");
  if (!payloadReadiness.delivery_ready) blockers.push("AWB_CERTIFICATION_DELIVERY_NOT_READY");
  if (!payloadReadiness.package_ready) blockers.push("AWB_CERTIFICATION_PACKAGE_NOT_READY");
  if (!payloadReadiness.invoice_ready) blockers.push("AWB_CERTIFICATION_INVOICE_NOT_READY");
  if (!payloadReadiness.selected_rate_ready) blockers.push("AWB_CERTIFICATION_RATE_NOT_READY");
  if (!payloadReadiness.courier_id_ready && !pickupUnavailable) blockers.push("AWB_CERTIFICATION_COURIER_ID_MISSING");
  if (!payloadReadiness.no_existing_awb) blockers.push("AWB_CERTIFICATION_EXISTING_AWB");
  if (!payloadReadiness.public_safety_ready) blockers.push("AWB_CERTIFICATION_PUBLIC_SAFETY_NOT_READY");
  const dryRunPayloadBlockers = blockers.length;
  blockers.push(...liveGateBlockers(readiness));

  const dryRunReady = dryRunPayloadBlockers === 0;
  const liveOneShotReady = dryRunReady && readiness.ready;
  const finalBlockers = unique(blockers);
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: shipment.id,
    pickup_location_id: pickupLocationId,
    requested_tier: input.requestedTier ?? "smart",
    dry_run_ready: dryRunReady,
    live_one_shot_ready: liveOneShotReady,
    status: statusFor({ existingAwb, dryRunReady, liveOneShotReady }),
    payload_readiness: payloadReadiness,
    live_gate_readiness: {
      live_awb_enabled: readiness.runtime.enabled,
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
      ...pickupServiceability.warnings,
      "AWB certification sandbox is read-only and does not create AWB or labels."
    ]),
    seller_safe_message: sellerMessage({ dryRunReady, liveOneShotReady, pickupUnavailable }),
    admin_next_actions: adminNextActions(finalBlockers)
  };
}
