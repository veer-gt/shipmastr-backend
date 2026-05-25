import type { OrderStatus, PaymentMode, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

const MAX_RETURN_ITEMS = 100;
const OPEN_RETURN_STATUSES = new Set(["REQUESTED", "QUALITY_CHECK", "IN_TRANSIT", "RTO", "RTO_INITIATED", "RTO_IN_TRANSIT"]);

type ReturnOrderRecord = {
  id: string;
  merchantId: string;
  externalOrderId: string;
  buyerName: string;
  orderValue: number;
  paymentMode: PaymentMode | string;
  status: OrderStatus | string;
  createdAt: Date;
  updatedAt: Date;
  shipmentDetails: {
    id: string;
    merchantId: string;
    courierId: string | null;
    awb: string | null;
    trackingNumber: string | null;
    shipmentStatus: string;
    rtoStatus: string | null;
    rtoInitiatedAt: Date | null;
    rtoDeliveredAt: Date | null;
    updatedAt: Date;
  } | null;
};

function moneyFromPaise(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed / 100) * 100) / 100 : 0;
}

function normalizeStatus(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

function sellerStatus(order: ReturnOrderRecord) {
  const shipment = order.shipmentDetails;
  const status = normalizeStatus(shipment?.rtoStatus || shipment?.shipmentStatus || order.status);
  if (shipment?.rtoDeliveredAt || status.includes("DELIVERED") || status.includes("RESOLVED")) return "resolved";
  if (status.includes("QUALITY")) return "quality_check";
  if (status.includes("IN_TRANSIT") || status.includes("TRANSIT")) return "in_transit";
  if (status.includes("RTO") || status.includes("RETURN")) return "requested";
  return "requested";
}

function returnType(order: ReturnOrderRecord) {
  const status = normalizeStatus(order.shipmentDetails?.shipmentStatus || order.status);
  return status.includes("EXCHANGE") ? "exchange" : "return";
}

function refundDisposition(order: ReturnOrderRecord) {
  const type = returnType(order);
  if (type === "exchange") return "exchange";
  if (order.paymentMode === "COD") return "store_credit";
  return "refund";
}

function toReturnRequest(order: ReturnOrderRecord) {
  const shipment = order.shipmentDetails;
  const status = sellerStatus(order);
  const type = returnType(order);
  const disposition = refundDisposition(order);
  const createdAt = shipment?.rtoInitiatedAt || shipment?.updatedAt || order.updatedAt || order.createdAt;

  return {
    _id: order.id,
    id: order.id,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    rmaNumber: `RMA-${order.externalOrderId}`,
    type,
    exchangePreference: type === "exchange" ? "exchange_order" : "refund",
    awbNumber: shipment?.awb || shipment?.trackingNumber || null,
    courierId: shipment?.courierId || null,
    status,
    refundDisposition: disposition,
    reason: status === "resolved" ? "Reverse logistics completed" : "Return to origin or reverse logistics review",
    amount: moneyFromPaise(order.orderValue),
    amountPaise: order.orderValue || 0,
    createdAt: createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

function isOpen(status: string) {
  return OPEN_RETURN_STATUSES.has(normalizeStatus(status)) || status === "requested" || status === "quality_check" || status === "in_transit";
}

export async function getReturnsActionCenter(
  merchantId: string,
  client: Db = prisma
) {
  const orders = await client.order.findMany({
    where: {
      merchantId,
      OR: [
        { status: "RTO" },
        {
          shipmentDetails: {
            is: {
              merchantId,
              OR: [
                { rtoStatus: { not: null } },
                { shipmentStatus: { contains: "RTO" } },
                { shipmentStatus: { contains: "RETURN" } }
              ]
            }
          }
        }
      ]
    },
    include: { shipmentDetails: true },
    orderBy: { updatedAt: "desc" },
    take: MAX_RETURN_ITEMS
  });

  const scopedOrders = (orders as ReturnOrderRecord[]).filter((order) => (
    order.merchantId === merchantId &&
    (!order.shipmentDetails || order.shipmentDetails.merchantId === merchantId)
  ));
  const requests = scopedOrders.map(toReturnRequest);
  const exchanges = requests.filter((request) => request.type === "exchange");
  const credits = requests.filter((request) => request.refundDisposition === "store_credit");
  const open = requests.filter((request) => isOpen(request.status)).length;

  return {
    summary: {
      openRmas: open,
      open,
      exchanges: exchanges.length,
      storeCredits: credits.length,
      totalReverseRequests: requests.length,
      total: requests.length
    },
    requests,
    items: requests,
    returns: requests,
    rmas: requests,
    exchanges,
    credits,
    count: requests.length
  };
}
