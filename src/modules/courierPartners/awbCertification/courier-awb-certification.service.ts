import { Prisma, ShipmentStatus } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../providers/provider-adapter.types.js";
import { createShiprocketLiveAdapter } from "../providers/shiprocket/shiprocket-live.adapter.js";
import {
  getSellerShipment,
  shipmentMetadata as parseShipmentMetadata,
  shipmentWeightForProvider
} from "../../shippingNetwork/shipping-shipments.service.js";
import {
  serviceCodeForName,
  toPrismaJson,
  trackingUrlForAwb
} from "../../shippingNetwork/shipping-public-serializers.js";
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
  CourierAwbCertificationLiveOneShotResult,
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
  courierPartnerId?: string | null;
  sellerCourierPartnerId?: string | null;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  rateBreakup?: unknown;
  amountPaise?: number | null;
  createdAt?: Date | string;
};

type ProviderRefRecord = {
  id?: string | null;
  courierPartnerId?: string | null;
  providerAwb?: string | null;
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
  providerPickupId?: string | null;
  metadata?: unknown;
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

function phase42pMetadata(value: unknown) {
  return metadataObject(metadataObject(value).phase42p);
}

function phase6Metadata(value: unknown) {
  return metadataObject(metadataObject(value).phase6);
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

function publicAwb(shipmentId: string, fallback: string | null | undefined) {
  if (fallback?.startsWith("SM")) return fallback;
  const suffix = shipmentId.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  return `SM${suffix || "SHIPMENT"}`;
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
  if (blockers.includes("AWB_CERTIFICATION_CREDENTIALS_NOT_READY")) actions.push("Resolve live credential readiness before attempting one-shot AWB certification.");
  if (blockers.includes("AWB_CERTIFICATION_PICKUP_UNAVAILABLE")) actions.push("Try another pickup location before attempting AWB certification.");
  if (blockers.includes("AWB_CERTIFICATION_COURIER_ID_MISSING")) actions.push("Refresh pilot live rates and confirm a numeric internal courier mapping is present.");
  if (blockers.includes("AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED")) actions.push("Provide explicit one-shot AWB approval only after payload readiness passes.");
  if (blockers.includes("AWB_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH")) actions.push("Align the one-shot merchant allowlist before live certification.");
  if (blockers.includes("AWB_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH")) actions.push("Align the one-shot shipment allowlist before live certification.");
  if (blockers.includes("AWB_CERTIFICATION_LIVE_MODE_DISABLED")) actions.push("Keep this shipment in dry-run review until live AWB mode is explicitly enabled.");
  if (blockers.includes("AWB_CERTIFICATION_RATE_NOT_READY")) actions.push("Refresh pilot live rates before attempting one-shot AWB certification.");
  if (blockers.includes("AWB_CERTIFICATION_PROVIDER_CALL_FAILED")) actions.push("Review the safe failure summary, fix the cause, then rerun the one-shot only with explicit approval.");
  if (blockers.includes("AWB_CERTIFICATION_PROVIDER_RESPONSE_INVALID")) actions.push("Keep AWB certification blocked until the provider response mapper is fixed.");
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

function liveOneShotBlockers(input: {
  dryRun: CourierAwbCertificationDryRunResult;
  readiness: LiveAwbLabelReadiness;
}): CourierAwbCertificationBlocker[] {
  const blockers = new Set<CourierAwbCertificationBlocker>(input.dryRun.blockers);
  if (!input.readiness.ready || !input.dryRun.live_one_shot_ready) {
    if (!input.readiness.runtime.enabled || input.readiness.runtime.mode !== "LIVE") blockers.add("AWB_CERTIFICATION_LIVE_MODE_DISABLED");
    if (!input.readiness.shiprocket.oneShotApprovalPresent) blockers.add("AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
    if (!input.readiness.shiprocket.allowedMerchantMatched) blockers.add("AWB_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
    if (!input.readiness.shiprocket.allowedShipmentMatched) blockers.add("AWB_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  }
  if (!input.dryRun.payload_readiness.credential_ready) blockers.add("AWB_CERTIFICATION_CREDENTIALS_NOT_READY");
  if (!input.dryRun.payload_readiness.pickup_ready) blockers.add("AWB_CERTIFICATION_PICKUP_NOT_READY");
  if (!input.dryRun.payload_readiness.selected_rate_ready) blockers.add("AWB_CERTIFICATION_RATE_NOT_READY");
  if (!input.dryRun.payload_readiness.courier_id_ready) blockers.add("AWB_CERTIFICATION_COURIER_ID_MISSING");
  if (!input.dryRun.payload_readiness.no_existing_awb) blockers.add("AWB_CERTIFICATION_EXISTING_AWB");
  return [...blockers];
}

function liveOneShotBlockedResult(input: {
  providerKey: CourierLiveProviderKey;
  shipmentId: string;
  existingAwb?: string | null;
  blockers: CourierAwbCertificationBlocker[];
  warnings?: string[];
}): CourierAwbCertificationLiveOneShotResult {
  const existingAwb = input.existingAwb ?? null;
  return {
    success: false,
    provider_key: input.providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: input.shipmentId,
    public_awb_status: existingAwb ? "ALREADY_EXISTS" : "BLOCKED",
    shipmastr_awb_number: existingAwb,
    label_ready: false,
    tracking_ready: false,
    certification_status: existingAwb ? "ALREADY_CERTIFIED" : "BLOCKED",
    blockers: unique(input.blockers),
    warnings: unique(input.warnings ?? []),
    seller_safe_message: existingAwb ? "Shipping is being safely verified." : "Shipment creation is not ready yet.",
    admin_next_actions: adminNextActions(input.blockers)
  };
}

function liveOneShotAdapter(input: {
  readiness: LiveAwbLabelReadiness;
  source?: Record<string, unknown>;
  adapter?: InternalCourierProviderAdapter;
}) {
  if (input.adapter) return input.adapter;
  if (!input.readiness.shiprocket.credentialRef) throw new HttpError(409, "AWB_CERTIFICATION_CREDENTIALS_NOT_READY");
  return createShiprocketLiveAdapter({
    credentialRef: input.readiness.shiprocket.credentialRef,
    source: input.source ?? {}
  });
}

async function latestProviderRef(client: Db, shipmentId: string, courierPartnerId?: string | null): Promise<ProviderRefRecord | null> {
  const model = (client as Db & { shipmentProviderRef?: { findFirst?: Function } }).shipmentProviderRef;
  if (!model?.findFirst) return null;
  return model.findFirst({
    where: {
      shipmentId,
      ...(courierPartnerId ? { courierPartnerId } : {})
    },
    orderBy: { createdAt: "desc" }
  }) as Promise<ProviderRefRecord | null>;
}

async function pickupProviderId(input: {
  client: Db;
  merchantId: string;
  pickupLocationId: string | null;
  courierPartnerId: string | null;
}) {
  if (!input.pickupLocationId) throw new HttpError(409, "AWB_CERTIFICATION_PICKUP_NOT_READY");
  const pickup = await input.client.pickupLocation.findFirst({
    where: {
      id: input.pickupLocationId,
      sellerId: input.merchantId
    }
  });
  if (!pickup) throw new HttpError(409, "AWB_CERTIFICATION_PICKUP_NOT_READY");
  if (input.courierPartnerId) {
    const mapping = await input.client.pickupLocationProviderMapping.findUnique({
      where: {
        pickupLocationId_courierPartnerId: {
          pickupLocationId: pickup.id,
          courierPartnerId: input.courierPartnerId
        }
      }
    });
    const mapped = firstString(mapping?.providerPickupId);
    if (mapped) return mapped;
  }
  return firstString(pickup.label, pickup.id) ?? pickup.id;
}

function draftProducts(metadata: ReturnType<typeof parseShipmentMetadata>) {
  return metadata.boxes.flatMap((box) => box.products ?? []).map((product) => ({
    name: product.name,
    sku: product.sku ?? null,
    quantity: product.quantity,
    unitPrice: product.unit_price
  }));
}

async function ensureLiveProviderRef(input: {
  client: Db;
  adapter: InternalCourierProviderAdapter;
  merchantId: string;
  shipment: ShipmentRecord;
  pickupLocationId: string | null;
  courierPartnerId: string | null;
  existingProviderRef: ProviderRefRecord | null;
  operatorNote?: string | null;
}) {
  const existingOrderId = firstString(input.existingProviderRef?.providerOrderId);
  if (existingOrderId && /^[0-9]+$/.test(existingOrderId)) return input.existingProviderRef!;
  const pickupLocationProviderId = await pickupProviderId({
    client: input.client,
    merchantId: input.merchantId,
    pickupLocationId: input.pickupLocationId,
    courierPartnerId: input.courierPartnerId
  });
  const metadata = parseShipmentMetadata(input.shipment.metadata);
  const weight = shipmentWeightForProvider(input.shipment);
  const draft = await input.adapter.createDraftOrder({
    sellerId: input.merchantId,
    shipmentId: input.shipment.id,
    sellerOrderId: input.shipment.externalOrderId ?? input.shipment.id,
    segment: input.shipment.segment,
    paymentMode: input.shipment.paymentMode,
    pickupLocationProviderId,
    returnLocationProviderId: pickupLocationProviderId,
    invoiceNumber: metadata.invoice.invoice_number ?? null,
    invoiceAmount: metadata.invoice.invoice_amount,
    collectableAmount: metadata.invoice.collectable_amount ?? null,
    deadWeightKg: weight.deadWeightKg,
    dimensions: weight.dimensions,
    buyer: {
      name: metadata.buyer.name,
      phone: metadata.buyer.phone,
      email: metadata.buyer.email ?? null,
      addressLine1: metadata.buyer.address.line1,
      addressLine2: metadata.buyer.address.line2 ?? null,
      landmark: metadata.buyer.address.landmark ?? null,
      city: metadata.buyer.address.city,
      state: metadata.buyer.address.state,
      country: metadata.buyer.address.country.toUpperCase(),
      pincode: metadata.buyer.address.pincode
    },
    products: draftProducts(metadata)
  });
  const safeMetadata = toPrismaJson({
    phase42p: {
      status: draft.status,
      reference: draft.providerReferenceNumber,
      liveOneShot: true,
      rawProviderResponseStored: false,
      operatorNote: input.operatorNote ?? null
    }
  });

  if (input.existingProviderRef?.id) {
    return input.client.shipmentProviderRef.update({
      where: { id: input.existingProviderRef.id },
      data: {
        courierPartnerId: input.courierPartnerId,
        providerShipmentId: draft.providerOrderId,
        providerOrderId: draft.providerOrderId,
        providerPickupId: pickupLocationProviderId,
        metadata: safeMetadata
      }
    });
  }

  return input.client.shipmentProviderRef.create({
    data: {
      shipmentId: input.shipment.id,
      courierPartnerId: input.courierPartnerId,
      providerShipmentId: draft.providerOrderId,
      providerOrderId: draft.providerOrderId,
      providerPickupId: pickupLocationProviderId,
      metadata: safeMetadata
    }
  });
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

export async function runCourierAwbCertificationLiveOneShot(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: {
    shipmentId: string;
    pickupLocationId?: string;
    requestedTier?: CourierAwbCertificationTier | null;
    operatorNote?: string | null;
  },
  options: {
    client?: Db;
    source?: Record<string, unknown>;
    adapter?: InternalCourierProviderAdapter;
    liveReadinessProvider?: () => Promise<LiveAwbLabelReadiness>;
    certificationProvider?: () => Promise<CourierCertificationSnapshot>;
    pickupServiceabilityProvider?: () => Promise<CourierPickupServiceabilityResult>;
  } = {}
): Promise<CourierAwbCertificationLiveOneShotResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "AWB_CERTIFICATION_PROVIDER_UNSUPPORTED");
  const client = options.client ?? prisma;
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  if (shipment.awbNumber) {
    return liveOneShotBlockedResult({
      providerKey,
      shipmentId: shipment.id,
      existingAwb: shipment.awbNumber,
      blockers: ["AWB_CERTIFICATION_EXISTING_AWB"],
      warnings: ["Existing AWB was found; no provider call was made."]
    });
  }

  const readinessProvider = options.liveReadinessProvider
    ? options.liveReadinessProvider
    : () => getLiveAwbLabelReadiness(merchantId, {
      client,
      shipmentId: shipment.id,
      includePickupAlignment: true,
      ...(options.source ? { source: options.source } : {})
    });
  const dryRun = await runCourierAwbCertificationDryRun(merchantId, providerKey, {
    shipmentId: shipment.id,
    ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {}),
    requestedTier: input.requestedTier ?? "smart"
  }, {
    client,
    liveReadinessProvider: readinessProvider,
    ...(options.certificationProvider ? { certificationProvider: options.certificationProvider } : {}),
    ...(options.pickupServiceabilityProvider ? { pickupServiceabilityProvider: options.pickupServiceabilityProvider } : {})
  });
  const readiness = await readinessProvider();
  const blockers = liveOneShotBlockers({ dryRun, readiness });
  if (blockers.length) {
    return liveOneShotBlockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers,
      warnings: dryRun.warnings
    });
  }

  const rate = await selectedRate(merchantId, shipment.id, input.requestedTier ?? "smart", client);
  const courierId = rateCourierId(rate);
  if (!rate || !rateLiveReady(rate)) {
    return liveOneShotBlockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["AWB_CERTIFICATION_RATE_NOT_READY"],
      warnings: ["Selected live rate was not ready; no provider call was made."]
    });
  }
  if (!courierId) {
    return liveOneShotBlockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["AWB_CERTIFICATION_COURIER_ID_MISSING"],
      warnings: ["Selected live rate did not include a numeric internal mapping; no provider call was made."]
    });
  }

  const adapter = liveOneShotAdapter({
    readiness,
    ...(options.source ? { source: options.source } : {}),
    ...(options.adapter ? { adapter: options.adapter } : {})
  });
  const existingProviderRef = await latestProviderRef(client, shipment.id, rate.courierPartnerId ?? null);

  try {
    const providerRef = await ensureLiveProviderRef({
      client,
      adapter,
      merchantId,
      shipment,
      pickupLocationId: input.pickupLocationId ?? shipment.pickupLocationId ?? null,
      courierPartnerId: rate.courierPartnerId ?? null,
      existingProviderRef,
      operatorNote: input.operatorNote ?? null
    });
    if (!providerRef.id || !providerRef.providerOrderId) {
      return liveOneShotBlockedResult({
        providerKey,
        shipmentId: shipment.id,
        blockers: ["AWB_CERTIFICATION_PROVIDER_RESPONSE_INVALID"],
        warnings: ["Provider reference was not ready after draft creation; no public AWB was stored."]
      });
    }

    const manifested = await adapter.manifestOrder({
      sellerId: merchantId,
      shipmentId: shipment.id,
      providerOrderId: providerRef.providerOrderId,
      providerCourierId: courierId,
      selectedRateId: rate.id
    });
    const awb = publicAwb(shipment.id, manifested.awb);
    if (!awb || !awb.startsWith("SM")) {
      return liveOneShotBlockedResult({
        providerKey,
        shipmentId: shipment.id,
        blockers: ["AWB_CERTIFICATION_PROVIDER_RESPONSE_INVALID"],
        warnings: ["Provider response did not map to a safe Shipmastr AWB."]
      });
    }

    await client.shipmentProviderRef.update({
      where: { id: providerRef.id },
      data: {
        providerAwb: manifested.providerAwb ?? manifested.awb,
        metadata: toPrismaJson({
          ...metadataObject(providerRef.metadata),
          phase42p: {
            ...metadataObject(metadataObject(providerRef.metadata).phase42p),
            manifestReference: manifested.providerReferenceNumber,
            manifestStatus: manifested.status,
            liveOneShot: true,
            rawProviderResponseStored: false
          }
        })
      }
    });

    const metadata = shipmentMetadata(shipment.metadata);
    const phase6 = phase6Metadata(shipment.metadata);
    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        status: ShipmentStatus.manifested,
        awbNumber: awb,
        trackingUrl: trackingUrlForAwb(awb),
        serviceLevel: rate.publicServiceName ?? null,
        sellerCourierPartnerId: rate.sellerCourierPartnerId ?? null,
        courierPartnerId: rate.courierPartnerId ?? null,
        metadata: toPrismaJson({
          ...metadata,
          phase6: {
            ...phase6,
            selectedTier: input.requestedTier ?? "smart",
            selectedRateId: rate.id,
            selectedServiceCode: serviceCodeForName(rate.publicServiceName ?? "Shipmastr Smart"),
            providerStatus: "awb_assigned",
            awbAssignedAt: new Date().toISOString(),
            livePilotAwbLabelMode: readiness.runtime.mode,
            livePilotAwbLabelReady: readiness.ready,
            rawProviderResponseStored: false
          },
          phase42p: {
            ...phase42pMetadata(shipment.metadata),
            awbCertified: true,
            awbCertifiedAt: new Date().toISOString(),
            labelCertified: false,
            trackingCertified: false,
            operatorNote: input.operatorNote ?? null,
            rawProviderResponseStored: false
          }
        })
      }
    });

    return {
      success: true,
      provider_key: providerKey,
      public_network_name: PUBLIC_NETWORK_NAME,
      shipment_id: shipment.id,
      public_awb_status: "CREATED",
      shipmastr_awb_number: awb,
      label_ready: false,
      tracking_ready: false,
      certification_status: "AWB_CERTIFIED",
      blockers: [],
      warnings: ["AWB certification succeeded. Label and tracking certification remain separate."],
      seller_safe_message: "Shipping is being safely verified.",
      admin_next_actions: ["Run label certification next; tracking remains blocked until label/AWB prerequisites are complete."]
    };
  } catch (error) {
    const maybe = error as { code?: unknown };
    const code = typeof maybe?.code === "string" && maybe.code.startsWith("AWB_CERTIFICATION_")
      ? maybe.code as CourierAwbCertificationBlocker
      : "AWB_CERTIFICATION_PROVIDER_CALL_FAILED";
    return liveOneShotBlockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: [code],
      warnings: ["Provider call failed safely. No public AWB was stored."]
    });
  }
}
