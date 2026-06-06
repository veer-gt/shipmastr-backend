import { z } from "zod";

const pincodeSchema = z.string().trim().regex(/^\d{6}$/, "Expected a 6 digit Indian pincode.");
const positiveMoneySchema = z.number().positive();
const positiveDimensionSchema = z.number().positive();

const addressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().optional(),
  landmark: z.string().trim().optional(),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
  country: z.string().trim().min(2).max(2).default("IN"),
  pincode: pincodeSchema,
  latitude: z.number().optional(),
  longitude: z.number().optional()
}).strict();

const productSchema = z.object({
  name: z.string().trim().min(1),
  sku: z.string().trim().optional(),
  quantity: z.number().int().positive(),
  unit_price: positiveMoneySchema
}).strict();

export const createPickupLocationSchema = z.object({
  name: z.string().trim().min(1),
  contact_person: z.string().trim().min(1),
  phone: z.string().trim().min(7).max(20),
  email: z.string().trim().email().optional(),
  address: addressSchema,
  address_type: z.string().trim().max(80).optional()
}).strict();

export const shipmentBoxSchema = z.object({
  weight_kg: positiveDimensionSchema,
  dimensions: z.object({
    length_cm: positiveDimensionSchema,
    breadth_cm: positiveDimensionSchema,
    height_cm: positiveDimensionSchema
  }).strict(),
  products: z.array(productSchema).optional()
}).strict();

export const createShipmentSchema = z.object({
  seller_order_id: z.string().trim().min(1),
  segment: z.enum(["domestic_b2c", "domestic_b2b", "hyperlocal"]).default("domestic_b2c"),
  pickup_location_id: z.string().trim().min(1),
  return_location_id: z.string().trim().min(1).optional(),
  payment_mode: z.enum(["prepaid", "cod"]).default("prepaid"),
  invoice: z.object({
    invoice_number: z.string().trim().optional(),
    invoice_amount: positiveMoneySchema,
    collectable_amount: z.number().nonnegative().optional()
  }).strict(),
  buyer: z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().min(7).max(20),
    address: addressSchema,
    tier: z.string().trim().max(80).optional()
  }).strict(),
  boxes: z.array(shipmentBoxSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
}).strict().superRefine((body, ctx) => {
  if (body.payment_mode === "cod" && body.invoice.collectable_amount === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["invoice", "collectable_amount"],
      message: "COD collectable amount is required."
    });
  }

  if (body.segment === "domestic_b2c") {
    const productTotal = body.boxes.flatMap((box) => box.products ?? [])
      .reduce((sum, product) => sum + product.quantity * product.unit_price, 0);

    if (productTotal > 0 && Math.round(productTotal * 100) !== Math.round(body.invoice.invoice_amount * 100)) {
      ctx.addIssue({
        code: "custom",
        path: ["boxes"],
        message: "Product total must equal invoice amount for domestic B2C shipments."
      });
    }
  }
});

export const manifestShipmentSchema = z.object({
  rate_id: z.string().trim().min(1),
  documents: z.record(z.string(), z.unknown()).optional()
}).strict();

export const cancelShipmentSchema = z.object({
  reason: z.string().trim().max(300).optional()
}).strict();

export type CreatePickupLocationInput = z.infer<typeof createPickupLocationSchema>;
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;
export type ShipmentBoxInput = z.infer<typeof shipmentBoxSchema>;
export type ManifestShipmentInput = z.infer<typeof manifestShipmentSchema>;
export type CancelShipmentInput = z.infer<typeof cancelShipmentSchema>;
