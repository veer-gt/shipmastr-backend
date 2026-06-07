import { z } from "zod";

const pincodeSchema = z.string().trim().regex(/^[1-9][0-9]{5}$/, "Expected a valid 6 digit Indian pincode.");
const indianPhoneSchema = z.string().trim().refine((value) => {
  const phone = value.replace(/\D/g, "").slice(-10);
  return /^[6-9][0-9]{9}$/.test(phone);
}, "Expected a valid 10 digit Indian mobile number.");
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
  phone: indianPhoneSchema,
  email: z.string().trim().email().optional(),
  address: addressSchema,
  address_type: z.string().trim().max(80).optional(),
  is_default: z.boolean().optional()
}).strict();

export const updatePickupLocationSchema = createPickupLocationSchema.partial().extend({
  is_default: z.boolean().optional()
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

export const fetchShipmentRatesSchema = z.object({
  refresh: z.boolean().optional()
}).strict();

export const shipNowSchema = z.object({
  tier: z.enum(["smart", "economy", "express"]).default("smart")
}).strict();

export const autopilotPreferenceSchema = z.object({
  isEnabled: z.boolean().optional(),
  defaultMode: z.enum(["recommend_only", "auto_ship_with_limits"]).optional(),
  preferredTier: z.enum(["smart", "economy", "express"]).optional(),
  maxCodAmount: z.number().int().nonnegative().nullable().optional(),
  maxOrderAmount: z.number().int().nonnegative().nullable().optional(),
  maxWeightGrams: z.number().int().nonnegative().nullable().optional(),
  allowCodHighRisk: z.boolean().optional(),
  allowWeightHighRisk: z.boolean().optional(),
  requireManualReviewHigh: z.boolean().optional(),
  rulesJson: z.record(z.string(), z.unknown()).nullable().optional()
}).strict();

export const autopilotRecommendSchema = z.object({}).strict();

export const slaStatsQuerySchema = z.object({
  provider: z.string().trim().max(80).optional(),
  courierCode: z.string().trim().max(120).optional(),
  deliveryPincode: z.string().trim().max(12).optional(),
  selectedTier: z.enum(["smart", "economy", "express"]).optional()
}).strict();

export const bulkRatesSchema = z.object({
  shipmentIds: z.array(z.string().trim().min(1)).min(1).max(50),
  refresh: z.boolean().optional()
}).strict();

export const bulkShipNowSchema = z.object({
  shipmentIds: z.array(z.string().trim().min(1)).min(1).max(25),
  tier: z.enum(["smart", "economy", "express"]).default("smart"),
  useAutopilot: z.boolean().optional(),
  acknowledgeProtectionWarnings: z.boolean().optional()
}).strict();

export const cancelShipmentSchema = z.object({
  reason: z.string().trim().max(300).optional()
}).strict();

export const listShipmentsQuerySchema = z.object({
  status: z.enum([
    "draft",
    "rates_fetched",
    "manifested",
    "pickup_scheduled",
    "picked_up",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "delivery_failed",
    "rto_initiated",
    "rto_in_transit",
    "rto_delivered",
    "cancelled",
    "lost",
    "damaged",
    "exception"
  ]).optional(),
  queue: z.enum(["ready_to_ship", "needs_attention", "in_transit", "delivered", "rto_failed"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(120).optional()
}).strict();

export const createShipmentFromOrderSchema = z.object({
  pickup_location_id: z.string().trim().min(1).optional()
}).strict();

export const createShippingOrderSchema = z.object({
  externalOrderId: z.string().trim().min(1).optional(),
  paymentMode: z.enum(["COD", "PREPAID"]).default("COD"),
  orderAmount: z.number().int().nonnegative(),
  codAmount: z.number().int().nonnegative().optional(),
  declaredValue: z.number().int().nonnegative().optional(),
  buyerName: z.string().trim().min(1),
  buyerPhone: z.string().trim().min(1),
  buyerEmail: z.string().trim().email().optional(),
  buyerAltPhone: z.string().trim().optional(),
  addressLine1: z.string().trim().min(1),
  addressLine2: z.string().trim().optional(),
  landmark: z.string().trim().optional(),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
  pincode: z.string().trim().min(1),
  packageWeight: z.number().int().nonnegative().optional(),
  packageLength: z.number().int().nonnegative().optional(),
  packageWidth: z.number().int().nonnegative().optional(),
  packageHeight: z.number().int().nonnegative().optional(),
  productDescription: z.string().trim().optional(),
  hsnCode: z.string().trim().optional(),
  itemCount: z.number().int().positive().optional(),
  sellerNotes: z.string().trim().optional(),
  pickupLocationId: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional()
}).strict();

export const listShippingOrdersQuerySchema = z.object({
  status: z.string().trim().optional(),
  paymentMode: z.enum(["COD", "PREPAID"]).optional(),
  search: z.string().trim().max(120).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();

export type CreatePickupLocationInput = z.infer<typeof createPickupLocationSchema>;
export type UpdatePickupLocationInput = z.infer<typeof updatePickupLocationSchema>;
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;
export type ShipmentBoxInput = z.infer<typeof shipmentBoxSchema>;
export type ManifestShipmentInput = z.infer<typeof manifestShipmentSchema>;
export type FetchShipmentRatesInput = z.infer<typeof fetchShipmentRatesSchema>;
export type ShipNowInput = z.infer<typeof shipNowSchema>;
export type CancelShipmentInput = z.infer<typeof cancelShipmentSchema>;
export type ListShipmentsQueryInput = z.infer<typeof listShipmentsQuerySchema>;
export type CreateShipmentFromOrderInput = z.infer<typeof createShipmentFromOrderSchema>;
export type CreateShippingOrderInput = z.infer<typeof createShippingOrderSchema>;
export type ListShippingOrdersQueryInput = z.infer<typeof listShippingOrdersQuerySchema>;
