import { OrderStatus, PaymentMode, ShipmentSegment, ShipmentStatus, ShippingPaymentMode, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { existingOrderAmountToPaise } from "./shipping-amounts.js";
import { NEEDS_ATTENTION_REASONS } from "./shipping-order-foundation.types.js";
import { toPrismaJson } from "./shipping-public-serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;

function decimalKgFromGrams(value: number | null | undefined) {
  if (!value || value <= 0) return null;
  return Math.round((value / 1000) * 1000) / 1000;
}

function cmFromMm(value: number | null | undefined) {
  if (!value || value <= 0) return null;
  return Math.round((value / 10) * 100) / 100;
}

function paymentModeForShipment(paymentMode: PaymentMode | string) {
  return String(paymentMode) === PaymentMode.COD ? ShippingPaymentMode.cod : ShippingPaymentMode.prepaid;
}

function metadataObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function buildOrUpdateShipmentCandidate(orderId: string, client: Db = prisma) {
  const order = await client.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { pickupLocation: true }
  });

  if (order.status !== OrderStatus.READY_TO_SHIP) {
    return null;
  }

  if (!order.pickupLocation) {
    await client.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.NEEDS_ATTENTION,
        needsAttentionReasons: toPrismaJson([NEEDS_ATTENTION_REASONS.MISSING_PICKUP_LOCATION])
      }
    });
    return null;
  }

  const physicalWeightKg = decimalKgFromGrams(order.weightGrams);
  const volumetricWeightKg = decimalKgFromGrams(order.volumetricWeightGrams);
  const chargeableWeightKg = Math.max(physicalWeightKg ?? 0, volumetricWeightKg ?? 0);
  const paymentMode = paymentModeForShipment(order.paymentMode);
  const shipmentData = {
    sellerId: order.merchantId,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    pickupLocationId: order.pickupLocation.id,
    segment: ShipmentSegment.domestic_b2c,
    status: ShipmentStatus.draft,
    paymentMode,
    codAmountPaise: paymentMode === ShippingPaymentMode.cod ? existingOrderAmountToPaise(order.codAmount) : 0,
    declaredValuePaise: existingOrderAmountToPaise(order.declaredValue || order.orderValue),
    fromPincode: order.pickupLocation.pincode,
    toPincode: order.pincode,
    deadWeightKg: physicalWeightKg,
    lengthCm: cmFromMm(order.packageLengthMm),
    breadthCm: cmFromMm(order.packageWidthMm),
    heightCm: cmFromMm(order.packageHeightMm),
    volumetricDivisor: 5000,
    volumetricWeightKg,
    chargeableWeightKg: chargeableWeightKg > 0 ? Math.round(chargeableWeightKg * 1000) / 1000 : null,
    metadata: toPrismaJson({
      candidateLayer: "shipment",
      source: order.source,
      importBatchId: order.importBatchId ?? null,
      validation: {
        addressQualityScore: order.addressQualityScore ?? null,
        addressQualityFlags: order.addressQualityFlags ?? [],
        needsAttentionReasons: order.needsAttentionReasons ?? []
      },
      pickup: {
        name: order.pickupLocation.label,
        contactName: order.pickupLocation.contactName,
        phone: order.pickupLocation.phone,
        addressLine1: order.pickupLocation.addressLine1,
        addressLine2: order.pickupLocation.addressLine2,
        city: order.pickupLocation.city,
        state: order.pickupLocation.state,
        country: order.pickupLocation.country,
        pincode: order.pickupLocation.pincode
      },
      invoice: {
        invoice_amount: order.orderValue,
        collectable_amount: paymentMode === ShippingPaymentMode.cod ? order.codAmount : 0,
        declared_value: order.declaredValue || order.orderValue
      },
      buyer: {
        name: order.buyerName,
        phone: order.buyerPhone,
        email: order.buyerEmail ?? null,
        alternatePhone: order.buyerAltPhone ?? null,
        address: {
          line1: order.addressLine1,
          line2: order.addressLine2 ?? null,
          landmark: order.landmark ?? null,
          city: order.city,
          state: order.state,
          country: order.country,
          pincode: order.pincode
        }
      },
      boxes: [{
        weight_kg: physicalWeightKg,
        dimensions: {
          length_cm: cmFromMm(order.packageLengthMm),
          breadth_cm: cmFromMm(order.packageWidthMm),
          height_cm: cmFromMm(order.packageHeightMm)
        },
        products: order.productDescription
          ? [{
            name: order.productDescription,
            quantity: order.itemCount,
            unit_price: order.orderValue
          }]
          : []
      }],
      orderMetadata: {
        productDescription: order.productDescription ?? null,
        hsnCode: order.hsnCode ?? null,
        itemCount: order.itemCount,
        sellerNotes: order.sellerNotes ?? null,
        tags: order.tags ?? null
      },
      internal: {
        courierOverride: order.courierOverride ?? null
      }
    })
  } satisfies Prisma.ShipmentUncheckedCreateInput;

  const existing = await client.shipment.findFirst({
    where: {
      sellerId: order.merchantId,
      OR: [
        { orderId: order.id },
        { externalOrderId: order.externalOrderId }
      ]
    }
  });

  if (existing) {
    return client.shipment.update({
      where: { id: existing.id },
      data: {
        ...shipmentData,
        metadata: toPrismaJson({
          ...metadataObject(existing.metadata),
          ...metadataObject(shipmentData.metadata)
        })
      }
    });
  }

  return client.shipment.create({ data: shipmentData });
}
