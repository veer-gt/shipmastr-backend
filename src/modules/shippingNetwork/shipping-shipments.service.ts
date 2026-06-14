import { ShippingPaymentMode, ShipmentStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { CreateShipmentInput, ShipmentBoxInput } from "./shipping-validation.js";
import {
  decimalToNumber,
  serializeShipment,
  terminalShipmentStatuses,
  toPrismaJson
} from "./shipping-public-serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ShipmentMetadata = {
  invoice: CreateShipmentInput["invoice"];
  buyer: CreateShipmentInput["buyer"];
  boxes: CreateShipmentInput["boxes"];
  returnLocationId?: string | null;
  sellerMetadata?: Record<string, unknown>;
};

function roundWeight(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function calculateShipmentWeight(boxes: ShipmentBoxInput[]) {
  const deadWeightKg = boxes.reduce((sum, box) => sum + box.weight_kg, 0);
  const volumetricWeightKg = boxes.reduce((sum, box) => {
    const dimensions = box.dimensions;
    return sum + (dimensions.length_cm * dimensions.breadth_cm * dimensions.height_cm) / 5000;
  }, 0);
  const lengthCm = Math.max(...boxes.map((box) => box.dimensions.length_cm));
  const breadthCm = Math.max(...boxes.map((box) => box.dimensions.breadth_cm));
  const heightCm = Math.max(...boxes.map((box) => box.dimensions.height_cm));
  const chargeableWeightKg = Math.max(0.5, Math.ceil(Math.max(deadWeightKg, volumetricWeightKg) * 2) / 2);

  return {
    deadWeightKg: roundWeight(deadWeightKg),
    volumetricWeightKg: roundWeight(volumetricWeightKg),
    chargeableWeightKg: roundWeight(chargeableWeightKg),
    lengthCm: roundWeight(lengthCm),
    breadthCm: roundWeight(breadthCm),
    heightCm: roundWeight(heightCm),
    volumetricDivisor: 5000
  };
}

export function shipmentMetadata(value: unknown): ShipmentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(409, "SHIPMENT_DRAFT_METADATA_MISSING");
  }

  const metadata = value as Partial<ShipmentMetadata>;
  if (!metadata.invoice || !metadata.buyer || !Array.isArray(metadata.boxes)) {
    throw new HttpError(409, "SHIPMENT_DRAFT_METADATA_MISSING");
  }

  return metadata as ShipmentMetadata;
}

export async function createShipmentDraft(
  sellerId: string,
  input: CreateShipmentInput,
  client: Db = prisma
) {
  const pickupLocation = await client.pickupLocation.findFirst({
    where: {
      id: input.pickup_location_id,
      sellerId
    }
  });

  if (!pickupLocation) {
    throw new HttpError(404, "PICKUP_LOCATION_NOT_FOUND");
  }

  if (input.return_location_id) {
    const returnLocation = await client.pickupLocation.findFirst({
      where: {
        id: input.return_location_id,
        sellerId
      }
    });

    if (!returnLocation) {
      throw new HttpError(404, "RETURN_LOCATION_NOT_FOUND");
    }
  }

  const weight = calculateShipmentWeight(input.boxes);
  const shipment = await client.shipment.create({
    data: {
      sellerId,
      externalOrderId: input.seller_order_id,
      pickupLocationId: input.pickup_location_id,
      segment: input.segment,
      status: ShipmentStatus.draft,
      paymentMode: input.payment_mode as ShippingPaymentMode,
      codAmountPaise: input.payment_mode === "cod" ? Math.round((input.invoice.collectable_amount ?? 0) * 100) : 0,
      declaredValuePaise: Math.round(input.invoice.invoice_amount * 100),
      fromPincode: pickupLocation.pincode,
      toPincode: input.buyer.address.pincode,
      deadWeightKg: weight.deadWeightKg,
      lengthCm: weight.lengthCm,
      breadthCm: weight.breadthCm,
      heightCm: weight.heightCm,
      volumetricDivisor: weight.volumetricDivisor,
      volumetricWeightKg: weight.volumetricWeightKg,
      chargeableWeightKg: weight.chargeableWeightKg,
      metadata: toPrismaJson({
        invoice: input.invoice,
        buyer: input.buyer,
        boxes: input.boxes,
        returnLocationId: input.return_location_id ?? null,
        sellerMetadata: input.metadata ?? {}
      })
    }
  });

  return serializeShipment(shipment);
}

export async function getSellerShipment(
  sellerId: string,
  shipmentId: string,
  client: Db = prisma
) {
  const shipment = await client.shipment.findFirst({
    where: {
      id: shipmentId,
      sellerId
    }
  });

  if (!shipment) {
    throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  }

  return shipment;
}

export async function getShipmentDetails(
  sellerId: string,
  shipmentId: string,
  client: Db = prisma
) {
  const shipment = await getSellerShipment(sellerId, shipmentId, client);
  return serializeShipment(shipment);
}

export function ensureShipmentIsNotTerminal(status: ShipmentStatus | string) {
  if (terminalShipmentStatuses.has(String(status))) {
    throw new HttpError(409, "SHIPMENT_STATUS_TERMINAL");
  }
}

export function shipmentWeightForProvider(shipment: {
  deadWeightKg?: unknown;
  lengthCm?: unknown;
  breadthCm?: unknown;
  heightCm?: unknown;
}) {
  const deadWeightKg = decimalToNumber(shipment.deadWeightKg);
  const lengthCm = decimalToNumber(shipment.lengthCm);
  const breadthCm = decimalToNumber(shipment.breadthCm);
  const heightCm = decimalToNumber(shipment.heightCm);

  if (deadWeightKg === null || lengthCm === null || breadthCm === null || heightCm === null) {
    throw new HttpError(409, "SHIPMENT_WEIGHT_METADATA_MISSING");
  }

  return {
    deadWeightKg,
    dimensions: {
      lengthCm,
      breadthCm,
      heightCm
    }
  };
}
