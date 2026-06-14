import { type Prisma, type ShipmentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { ListShipmentsQueryInput } from "./shipping-validation.js";
import {
  serializeShipmentList,
  serializeShipmentListItem,
  type PublicShipmentListSource
} from "./shipping-public-serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;

function matchesSearch(shipment: PublicShipmentListSource, search: string | undefined) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;

  const item = serializeShipmentListItem(shipment);
  const values = [
    item.shipment_id,
    item.seller_order_id,
    item.order_id,
    item.awb,
    item.tracking_number,
    item.buyer.name,
    item.buyer.phone,
    item.buyer.pincode,
    item.buyer.city,
    item.buyer.state
  ];

  return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
}

export async function listShippingShipments(
  sellerId: string,
  query: ListShipmentsQueryInput,
  client: Db = prisma
) {
  const where: Prisma.ShipmentWhereInput = {
    sellerId,
    ...(query.status ? { status: query.status as ShipmentStatus } : {})
  };

  const shipments = await client.shipment.findMany({
    where,
    orderBy: { createdAt: "desc" }
  });
  const filtered = shipments.filter((shipment) => {
    const item = serializeShipmentListItem(shipment);
    if (query.queue && item.queue !== query.queue) return false;
    return matchesSearch(shipment, query.search);
  });
  const start = (query.page - 1) * query.per_page;
  const pageRows = filtered.slice(start, start + query.per_page);

  return serializeShipmentList({
    shipments: pageRows,
    page: query.page,
    perPage: query.per_page,
    total: filtered.length
  });
}
