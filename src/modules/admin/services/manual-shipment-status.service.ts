import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { HttpError } from "../../../lib/httpError.js";
import { audit } from "../../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const manualShipmentStatusValues = [
  "pickup_scheduled",
  "ready_to_ship",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "ndr",
  "rto_initiated",
  "rto_delivered",
  "lost",
  "damaged"
] as const;

export type ManualShipmentStatus = (typeof manualShipmentStatusValues)[number];

export type ManualShipmentStatusUpdateInput = {
  shipmentIdOrAwb: string;
  actorId: string;
  status: ManualShipmentStatus;
  eventType?: string | null;
  location?: string | null;
  remarks?: string | null;
};

function clean(value: string | null | undefined) {
  return value?.trim() || "";
}

function latestEventFor(input: Pick<ManualShipmentStatusUpdateInput, "status" | "remarks">) {
  return clean(input.remarks) || `Manual shipment status updated to ${input.status}`;
}

async function findShipment(idOrAwb: string, client: Db) {
  const identifier = clean(idOrAwb);
  if (!identifier) throw new HttpError(400, "SHIPMENT_ID_OR_AWB_REQUIRED");

  return client.courierShipment.findFirst({
    where: {
      OR: [
        { id: identifier },
        { awbNumber: identifier },
        { awbNumber: identifier.toUpperCase() }
      ]
    }
  });
}

async function updateInClient(input: ManualShipmentStatusUpdateInput, client: Db) {
  const shipment = await findShipment(input.shipmentIdOrAwb, client);
  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");

  const previousStatus = shipment.status;
  const latestEvent = latestEventFor(input);
  const eventType = clean(input.eventType) || "manual_status_update";
  const location = clean(input.location) || null;

  const updated = await client.courierShipment.update({
    where: { id: shipment.id },
    data: {
      status: input.status,
      lastEvent: latestEvent,
      events: {
        create: {
          courierId: shipment.courierId,
          courierUserId: input.actorId,
          eventType,
          status: input.status,
          location,
          remarks: latestEvent
        }
      }
    },
    include: {
      courier: true,
      events: { orderBy: { createdAt: "asc" } }
    }
  });

  await audit({
    actorId: input.actorId,
    action: "ADMIN_MANUAL_SHIPMENT_STATUS_UPDATED",
    entityType: "courier_shipment",
    entityId: shipment.id,
    metadata: {
      courierId: shipment.courierId,
      awbNumber: shipment.awbNumber,
      orderId: shipment.orderId,
      fromStatus: previousStatus,
      toStatus: input.status,
      eventType,
      location,
      source: "admin_manual_status_update"
    }
  }, client);

  return {
    shipment: updated,
    previousStatus
  };
}

export async function updateManualShipmentStatus(
  input: ManualShipmentStatusUpdateInput,
  client: Db = prisma
) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => updateInClient(input, tx));
  }

  return updateInClient(input, client);
}
