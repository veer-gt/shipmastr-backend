import { ShipmentStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { createMockSafeShippingAdapter } from "./shipping-pickup-location.service.js";
import { ensureShipmentIsNotTerminal, getSellerShipment } from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type CancelOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
};

export async function cancelShipment(
  sellerId: string,
  shipmentId: string,
  reason: string | undefined,
  options: CancelOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter ?? createMockSafeShippingAdapter();
  const shipment = await getSellerShipment(sellerId, shipmentId, client);
  ensureShipmentIsNotTerminal(shipment.status);

  const providerRef = await client.shipmentProviderRef.findFirst({
    where: { shipmentId: shipment.id },
    orderBy: { createdAt: "desc" }
  });

  if (providerRef) {
    await adapter.cancelOrder({
      awb: providerRef.providerAwb ?? shipment.awbNumber,
      trackingNumber: shipment.awbNumber,
      providerOrderId: providerRef.providerOrderId,
      reason: reason ?? null
    });
  }

  const updated = await client.shipment.update({
    where: { id: shipment.id },
    data: {
      status: ShipmentStatus.cancelled
    }
  });

  return {
    shipment_id: updated.id,
    status: String(updated.status)
  };
}
