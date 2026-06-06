import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { serializeTrackingEvent, toPrismaJson } from "./shipping-public-serializers.js";
import { createMockSafeShippingAdapter } from "./shipping-pickup-location.service.js";
import { getSellerShipment } from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type TrackingOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
};

export async function fetchShipmentTracking(
  sellerId: string,
  shipmentId: string,
  options: TrackingOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter ?? createMockSafeShippingAdapter();
  const shipment = await getSellerShipment(sellerId, shipmentId, client);
  const providerRef = await client.shipmentProviderRef.findFirst({
    where: { shipmentId: shipment.id },
    orderBy: { createdAt: "desc" }
  });

  if (providerRef) {
    const tracking = await adapter.trackOrder({
      awb: providerRef.providerAwb ?? shipment.awbNumber,
      trackingNumber: shipment.awbNumber,
      providerOrderId: providerRef.providerOrderId
    });

    for (const event of tracking.events) {
      await client.shipmentTrackingEvent.create({
        data: {
          shipmentId: shipment.id,
          courierPartnerId: providerRef.courierPartnerId,
          status: event.status,
          eventCode: event.status,
          eventLabel: event.publicStatus,
          publicMessage: event.message,
          location: event.location ?? null,
          occurredAt: event.checkpointTime,
          metadata: toPrismaJson({
            source: "internal_adapter"
          })
        }
      });
    }

    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        status: tracking.status
      }
    });
  }

  const events = await client.shipmentTrackingEvent.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { occurredAt: "asc" }
  });
  const latest = events[events.length - 1];

  return {
    shipment_id: shipment.id,
    awb: shipment.awbNumber,
    status: latest ? String(latest.status) : String(shipment.status),
    history: events.map(serializeTrackingEvent)
  };
}
