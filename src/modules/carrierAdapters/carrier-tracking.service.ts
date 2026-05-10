import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import type { CarrierTrackingStatus } from "./carrier-adapter.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type CarrierTrackingPersistenceInput = {
  awbNumber?: string | null;
  trackingNumber?: string | null;
  orderId?: string | null;
  status: CarrierTrackingStatus;
  eventType?: string | null;
  latestEvent?: string | null;
  location?: string | null;
  actorId?: string | null;
  rawPayload?: Record<string, unknown> | null;
};

async function findShipment(input: CarrierTrackingPersistenceInput, client: Db) {
  const awb = input.awbNumber?.trim() || input.trackingNumber?.trim();
  if (awb) {
    const byAwb = await client.courierShipment.findUnique({ where: { awbNumber: awb } });
    if (byAwb) return byAwb;
  }

  const orderId = input.orderId?.trim();
  if (orderId) {
    return client.courierShipment.findFirst({ where: { orderId } });
  }

  return null;
}

async function applyInClient(input: CarrierTrackingPersistenceInput, client: Db) {
  const shipment = await findShipment(input, client);

  if (!shipment) {
    return {
      updated: false as const,
      reason: "COURIER_SHIPMENT_NOT_FOUND"
    };
  }

  const previousStatus = shipment.status;
  const latestEvent = input.latestEvent?.trim() || `Carrier tracking update: ${input.status}`;
  const eventData: Prisma.CourierEventUncheckedCreateWithoutShipmentInput = {
    courierId: shipment.courierId,
    courierUserId: input.actorId ?? null,
    eventType: input.eventType?.trim() || "carrier_tracking_update",
    status: input.status,
    location: input.location?.trim() || null,
    remarks: latestEvent
  };
  if (input.rawPayload) eventData.rawPayload = input.rawPayload as Prisma.InputJsonObject;

  const updated = await client.courierShipment.update({
    where: { id: shipment.id },
    data: {
      status: input.status,
      lastEvent: latestEvent,
      events: {
        create: eventData
      }
    }
  });

  const auditInput: Parameters<typeof audit>[0] = {
    action: "CARRIER_TRACKING_UPDATE_RECORDED",
    entityType: "courier_shipment",
    entityId: shipment.id,
    metadata: {
      courierId: shipment.courierId,
      awbNumber: shipment.awbNumber,
      orderId: shipment.orderId,
      fromStatus: previousStatus,
      toStatus: input.status,
      eventType: eventData.eventType,
      source: "carrier_adapter"
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client);

  return {
    updated: true as const,
    shipment: updated,
    previousStatus
  };
}

export async function applyCarrierTrackingUpdate(
  input: CarrierTrackingPersistenceInput,
  client: Db = prisma
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => applyInClient(input, tx));
  }

  return applyInClient(input, client);
}
