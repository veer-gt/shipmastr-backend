import { OrderStatus, ShipmentStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

function countBy<T>(rows: T[], predicate: (row: T) => boolean) {
  return rows.filter(predicate).length;
}

function sumBy<T>(rows: T[], selector: (row: T) => number | null | undefined) {
  return rows.reduce((total, row) => total + (selector(row) ?? 0), 0);
}

export async function getMerchantOperationsSummary(merchantId: string, client: Db = prisma) {
  const [
    orders,
    shipments,
    ndrCases,
    rtoCases,
    codLedger,
    weightCases,
    autopilotPreference
  ] = await Promise.all([
    client.order.findMany({
      where: { merchantId },
      select: { status: true, paymentMode: true }
    }),
    client.shipment.findMany({
      where: { sellerId: merchantId },
      select: { status: true }
    }),
    client.ndrCase.findMany({
      where: { merchantId },
      select: { status: true }
    }),
    client.rtoCase.findMany({
      where: { merchantId },
      select: { status: true, estimatedLossPaise: true }
    }),
    client.codLedgerEntry.findMany({
      where: { merchantId },
      select: { entryType: true, amountPaise: true }
    }),
    client.weightDiscrepancyCase.findMany({
      where: { merchantId },
      select: { status: true }
    }),
    client.autopilotPreference.findUnique({
      where: { merchantId }
    })
  ]);

  const rtoOpenStatuses = new Set(["initiated", "in_transit", "received", "lost", "damaged"]);
  const weightOpenStatuses = new Set(["detected", "evidence_needed", "dispute_ready"]);
  const shipmentInTransitStatuses = new Set<ShipmentStatus>([
    ShipmentStatus.manifested,
    ShipmentStatus.pickup_scheduled,
    ShipmentStatus.picked_up,
    ShipmentStatus.in_transit,
    ShipmentStatus.out_for_delivery
  ]);
  const shipmentFailedStatuses = new Set<ShipmentStatus>([
    ShipmentStatus.delivery_failed,
    ShipmentStatus.exception,
    ShipmentStatus.lost,
    ShipmentStatus.damaged,
    ShipmentStatus.cancelled
  ]);
  const shipmentRtoStatuses = new Set<ShipmentStatus>([
    ShipmentStatus.rto_initiated,
    ShipmentStatus.rto_in_transit,
    ShipmentStatus.rto_delivered
  ]);

  return {
    orders: {
      total: orders.length,
      needs_attention: countBy(orders, (order) => order.status === OrderStatus.NEEDS_ATTENTION),
      ready_to_ship: countBy(orders, (order) => order.status === OrderStatus.READY_TO_SHIP)
    },
    shipments: {
      total: shipments.length,
      in_transit: countBy(shipments, (shipment) => shipmentInTransitStatuses.has(shipment.status)),
      delivered: countBy(shipments, (shipment) => shipment.status === ShipmentStatus.delivered),
      failed: countBy(shipments, (shipment) => shipmentFailedStatuses.has(shipment.status)),
      rto: countBy(shipments, (shipment) => shipmentRtoStatuses.has(shipment.status))
    },
    ndr: {
      open: countBy(ndrCases, (ndr) => ndr.status !== "resolved" && ndr.status !== "cancelled"),
      resolved: countBy(ndrCases, (ndr) => ndr.status === "resolved")
    },
    rto: {
      open: countBy(rtoCases, (rto) => rtoOpenStatuses.has(rto.status)),
      closed: countBy(rtoCases, (rto) => rto.status === "closed"),
      estimated_loss_paise: sumBy(rtoCases, (rto) => rto.estimatedLossPaise)
    },
    cod: {
      expected_collection_paise: sumBy(codLedger, (entry) => entry.entryType === "expected_collection" ? entry.amountPaise : 0),
      collected_paise: sumBy(codLedger, (entry) => entry.entryType === "collected" ? entry.amountPaise : 0),
      remittance_due_paise: sumBy(codLedger, (entry) => entry.entryType === "remittance_due" ? entry.amountPaise : 0),
      remitted_paise: sumBy(codLedger, (entry) => entry.entryType === "remitted" ? entry.amountPaise : 0)
    },
    weight_disputes: {
      open: countBy(weightCases, (weight) => weightOpenStatuses.has(weight.status)),
      submitted: countBy(weightCases, (weight) => weight.status === "submitted"),
      closed: countBy(weightCases, (weight) => weight.status === "closed"),
      won: countBy(weightCases, (weight) => weight.status === "accepted"),
      lost: countBy(weightCases, (weight) => weight.status === "rejected")
    },
    autopilot: {
      enabled: Boolean(autopilotPreference?.isEnabled)
    }
  };
}
