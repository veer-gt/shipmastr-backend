import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { buildTrackingTimeline, publicStatusForShipmentStatus } from "./shipping-tracking-timeline.js";

type Db = Prisma.TransactionClient | typeof prisma;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nestedRecord(value: unknown, key: string) {
  if (!isRecord(value)) return {};
  const nested = value[key];
  return isRecord(nested) ? nested : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maskPhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `ending ${digits.slice(-4)}` : null;
}

function phase6Metadata(value: unknown) {
  return nestedRecord(value, "phase6");
}

function buyerMetadata(value: unknown) {
  return nestedRecord(value, "buyer");
}

function buyerAddressMetadata(value: unknown) {
  return nestedRecord(buyerMetadata(value), "address");
}

function sellerSettingsProfile(value: unknown) {
  return nestedRecord(value, "sellerSettingsProfile");
}

function trackingBranding(value: unknown) {
  return nestedRecord(sellerSettingsProfile(value), "trackingBranding");
}

function publicBrand(input: {
  merchant?: { name?: string | null } | null;
  automationPreference?: { metadata?: unknown } | null;
}) {
  const branding = trackingBranding(input.automationPreference?.metadata);
  return {
    name: stringValue(branding.logoText) || input.merchant?.name || "Shipmastr seller",
    logoUrl: null
  };
}

function publicSupport(input: {
  merchant?: { phone?: string | null } | null;
  automationPreference?: { metadata?: unknown } | null;
}) {
  const branding = trackingBranding(input.automationPreference?.metadata);
  return {
    message: "For delivery help, contact the seller.",
    contactEmail: stringValue(branding.supportEmail) || null,
    contactPhoneMasked: maskPhone(stringValue(branding.supportPhone) || input.merchant?.phone || null)
  };
}

export async function getPublicTrackingByToken(trackingToken: string, client: Db = prisma) {
  const token = trackingToken.trim();
  if (!token) return null;

  const shipment = await client.shipment.findUnique({
    where: { trackingToken: token }
  });

  if (!shipment) return null;

  const [merchant, automationPreference, order, trackingEvents, rates] = await Promise.all([
    client.merchant.findUnique({
      where: { id: shipment.sellerId },
      select: { id: true, name: true, phone: true }
    }),
    client.automationPreference.findUnique({
      where: { merchantId: shipment.sellerId },
      select: { metadata: true }
    }),
    shipment.orderId || shipment.externalOrderId
      ? client.order.findFirst({
        where: {
          merchantId: shipment.sellerId,
          OR: [
            ...(shipment.orderId ? [{ id: shipment.orderId }] : []),
            ...(shipment.externalOrderId ? [{ externalOrderId: shipment.externalOrderId }] : [])
          ]
        }
      })
      : Promise.resolve(null),
    client.shipmentTrackingEvent.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { occurredAt: "asc" }
    }),
    client.shipmentRate.findMany({
      where: { shipmentId: shipment.id, sellerId: shipment.sellerId },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const metadata = isRecord(shipment.metadata) ? shipment.metadata : {};
  const phase6 = phase6Metadata(metadata);
  const buyerAddress = buyerAddressMetadata(metadata);
  const status = String(shipment.trackingStatus || phase6.providerStatus || shipment.status);
  const publicStatus = publicStatusForShipmentStatus(status);
  const selectedTier = stringValue(phase6.selectedTier);
  const selectedTierSummary = selectedTier && isRecord(phase6.tierSummary)
    ? nestedRecord(phase6.tierSummary, selectedTier)
    : {};
  const amount = shipment.declaredValuePaise ?? (order?.orderValue ? order.orderValue * 100 : null);

  return {
    trackingToken: token,
    brand: publicBrand({ merchant, automationPreference }),
    shipment: {
      status,
      publicStatus: publicStatus.publicStatus,
      awbNumber: shipment.awbNumber ?? null,
      estimatedDeliveryDays: numberValue(selectedTierSummary.estimatedDeliveryDays),
      estimatedDeliveryDate: null,
      trackingUrl: null
    },
    order: {
      externalOrderId: shipment.externalOrderId || order?.externalOrderId || null,
      paymentMode: String(shipment.paymentMode || order?.paymentMode || "").toUpperCase() || null,
      amount
    },
    delivery: {
      city: stringValue(buyerAddress.city) || order?.city || null,
      state: stringValue(buyerAddress.state) || order?.state || null,
      pincode: stringValue(buyerAddress.pincode) || order?.pincode || shipment.toPincode || null
    },
    timeline: buildTrackingTimeline({
      order,
      shipment,
      rates,
      trackingEvents
    }),
    support: publicSupport({ merchant, automationPreference })
  };
}
