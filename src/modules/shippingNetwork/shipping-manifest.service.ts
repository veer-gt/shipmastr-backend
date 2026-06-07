import { ShipmentStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { PUBLIC_COURIER_NETWORK, toPrismaJson } from "./shipping-public-serializers.js";
import { createMockSafeShippingAdapter } from "./shipping-pickup-location.service.js";
import { ensureShipmentIsNotTerminal, getSellerShipment } from "./shipping-shipments.service.js";
import { ensureShipmentTrackingToken } from "./shipping-tracking-token.js";

type Db = Prisma.TransactionClient | typeof prisma;

type ManifestOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
};

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function selectedCourierId(rateBreakup: unknown) {
  const metadata = metadataObject(rateBreakup);
  const value = metadata.internalCourierId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publicAwb(shipmentId: string, fallback: string | null | undefined) {
  if (fallback && !fallback.toLowerCase().startsWith("mock_")) return fallback;
  const suffix = shipmentId.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  return `SM${suffix || "SHIPMENT"}`;
}

export async function manifestShipment(
  sellerId: string,
  shipmentId: string,
  rateId: string,
  options: ManifestOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter ?? createMockSafeShippingAdapter();
  const shipment = await getSellerShipment(sellerId, shipmentId, client);
  ensureShipmentIsNotTerminal(shipment.status);

  const rate = await client.shipmentRate.findFirst({
    where: {
      id: rateId,
      shipmentId: shipment.id,
      sellerId
    }
  });

  if (!rate) {
    throw new HttpError(404, "SHIPMENT_RATE_NOT_FOUND");
  }

  const providerRef = await client.shipmentProviderRef.findFirst({
    where: {
      shipmentId: shipment.id,
      courierPartnerId: rate.courierPartnerId
    },
    orderBy: { createdAt: "desc" }
  });

  if (!providerRef?.providerOrderId) {
    throw new HttpError(409, "SHIPMENT_PROVIDER_DRAFT_MISSING");
  }

  const internalCourierId = selectedCourierId(rate.rateBreakup);
  if (!internalCourierId) {
    throw new HttpError(409, "SHIPMENT_RATE_INTERNAL_MAPPING_MISSING");
  }

  const manifested = await adapter.manifestOrder({
    sellerId,
    shipmentId: shipment.id,
    providerOrderId: providerRef.providerOrderId,
    providerCourierId: internalCourierId,
    selectedRateId: rate.id
  });
  const awb = publicAwb(shipment.id, manifested.awb);

  await client.shipmentProviderRef.update({
    where: { id: providerRef.id },
    data: {
      providerAwb: manifested.providerAwb ?? manifested.awb,
      metadata: toPrismaJson({
        ...metadataObject(providerRef.metadata),
        manifestReference: manifested.providerReferenceNumber,
        manifestStatus: manifested.status,
        result: manifested.providerMetadata
      })
    }
  });

  const updated = await client.shipment.update({
    where: { id: shipment.id },
    data: {
      status: ShipmentStatus.manifested,
      awbNumber: awb,
      trackingUrl: `/tracking/?awb=${encodeURIComponent(awb)}`,
      serviceLevel: rate.publicServiceName,
      sellerCourierPartnerId: rate.sellerCourierPartnerId,
      courierPartnerId: rate.courierPartnerId
    }
  });
  const tracked = await ensureShipmentTrackingToken(updated, client);

  return {
    shipment_id: tracked.id,
    status: String(tracked.status),
    awb,
    tracking_number: awb,
    tracking_url: tracked.trackingPublicUrl,
    tracking_public_url: tracked.trackingPublicUrl,
    courier_network: PUBLIC_COURIER_NETWORK,
    service_level: rate.publicServiceName
  };
}
