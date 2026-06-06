import { PaymentMode, ShipmentSegment, ShipmentStatus, ShippingPaymentMode, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  serializeOrderShipmentBridgeResult,
  toPrismaJson
} from "./shipping-public-serializers.js";
import type { CreateShipmentFromOrderInput } from "./shipping-validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function moneyToPaise(value: number | null | undefined) {
  return Math.round(Number(value || 0) * 100);
}

function orderWeightKg(order: { weightGrams?: number | null }) {
  if (!order.weightGrams || order.weightGrams <= 0) return null;
  return Math.round((order.weightGrams / 1000) * 1000) / 1000;
}

function shippingPaymentMode(paymentMode: PaymentMode | string) {
  return String(paymentMode) === PaymentMode.COD ? ShippingPaymentMode.cod : ShippingPaymentMode.prepaid;
}

async function resolvePickupLocation(
  sellerId: string,
  input: CreateShipmentFromOrderInput,
  client: Db
) {
  if (input.pickup_location_id) {
    const pickup = await client.pickupLocation.findFirst({
      where: {
        id: input.pickup_location_id,
        sellerId
      }
    });

    if (!pickup) {
      throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");
    }

    return pickup;
  }

  const pickups = await client.pickupLocation.findMany({
    where: { sellerId },
    orderBy: { createdAt: "desc" }
  });

  if (pickups.length === 1) {
    return pickups[0]!;
  }

  throw new HttpError(400, pickups.length ? "PICKUP_LOCATION_REQUIRED" : "PICKUP_LOCATION_NOT_FOUND");
}

export async function createShipmentFromOrder(
  sellerId: string,
  orderId: string,
  input: CreateShipmentFromOrderInput,
  client: Db = prisma
) {
  const order = await client.order.findFirst({
    where: {
      merchantId: sellerId,
      OR: [
        { id: orderId },
        { externalOrderId: orderId }
      ]
    }
  });

  if (!order) {
    throw new HttpError(404, "ORDER_NOT_FOUND");
  }

  const existing = await client.shipment.findFirst({
    where: {
      sellerId,
      OR: [
        { orderId: order.id },
        { externalOrderId: order.externalOrderId }
      ]
    }
  });

  if (existing) {
    return {
      existed: true,
      shipment: serializeOrderShipmentBridgeResult(existing)
    };
  }

  const pickup = await resolvePickupLocation(sellerId, input, client);
  const paymentMode = shippingPaymentMode(order.paymentMode);
  const weightKg = orderWeightKg(order);
  const shipment = await client.shipment.create({
    data: {
      sellerId,
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      pickupLocationId: pickup.id,
      segment: ShipmentSegment.domestic_b2c,
      status: ShipmentStatus.draft,
      paymentMode,
      codAmountPaise: paymentMode === ShippingPaymentMode.cod ? moneyToPaise(order.codAmount) : 0,
      declaredValuePaise: moneyToPaise(order.orderValue),
      fromPincode: pickup.pincode,
      toPincode: order.pincode,
      deadWeightKg: weightKg,
      metadata: toPrismaJson({
        invoice: {
          invoice_amount: order.orderValue,
          collectable_amount: paymentMode === ShippingPaymentMode.cod ? order.codAmount : 0
        },
        buyer: {
          name: order.buyerName,
          phone: order.buyerPhone,
          email: null,
          address: {
            line1: order.addressLine1,
            line2: order.addressLine2 ?? null,
            city: order.city,
            state: order.state,
            country: "IN",
            pincode: order.pincode
          }
        },
        boxes: [{
          weight_kg: weightKg,
          dimensions: null,
          products: []
        }],
        source: "order_bridge"
      })
    }
  });

  return {
    existed: false,
    shipment: serializeOrderShipmentBridgeResult(shipment)
  };
}
