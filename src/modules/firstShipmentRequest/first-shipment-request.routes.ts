import { FirstShipmentRequestStatus, PaymentMode } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import {
  createFirstShipmentRequest,
  listSellerFirstShipmentRequests
} from "./first-shipment-request.service.js";

export const firstShipmentRequestRouter = Router();

const firstShipmentCreateSchema = z.object({
  pickupName: z.string().trim().min(2).max(120),
  pickupPhone: z.string().trim().min(7).max(24),
  pickupAddress: z.string().trim().min(8).max(500),
  pickupPincode: z.string().trim().regex(/^\d{6}$/),
  deliveryCity: z.string().trim().min(2).max(120),
  deliveryPincode: z.string().trim().regex(/^\d{6}$/),
  buyerName: z.string().trim().min(2).max(120).optional().or(z.literal("")),
  buyerPhone: z.string().trim().min(7).max(24).optional().or(z.literal("")),
  buyerAddress: z.string().trim().min(8).max(500).optional().or(z.literal("")),
  packageDescription: z.string().trim().max(240).optional().or(z.literal("")),
  packageWeight: z.coerce.number().int().positive().max(200000),
  paymentMode: z.nativeEnum(PaymentMode),
  codAmount: z.coerce.number().int().min(0).default(0),
  courierPreference: z.string().trim().max(120).optional().or(z.literal("")),
  notes: z.string().trim().max(1200).optional().or(z.literal(""))
}).refine((body) => body.paymentMode !== PaymentMode.COD || body.codAmount > 0, {
  path: ["codAmount"],
  message: "codAmount is required for COD shipments"
});

firstShipmentRequestRouter.get("/", async (req, res) => {
  res.json(await listSellerFirstShipmentRequests(req.auth!.merchantId!));
});

firstShipmentRequestRouter.post("/", async (req, res) => {
  const body = firstShipmentCreateSchema.parse(req.body);

  const request = await createFirstShipmentRequest({
    merchantId: req.auth!.merchantId!,
    requesterUserId: req.auth!.userId,
    pickupName: body.pickupName,
    pickupPhone: body.pickupPhone,
    pickupAddress: body.pickupAddress,
    pickupPincode: body.pickupPincode,
    deliveryCity: body.deliveryCity,
    deliveryPincode: body.deliveryPincode,
    buyerName: body.buyerName || null,
    buyerPhone: body.buyerPhone || null,
    buyerAddress: body.buyerAddress || null,
    packageDescription: body.packageDescription || null,
    packageWeight: body.packageWeight,
    paymentMode: body.paymentMode,
    codAmount: body.paymentMode === PaymentMode.COD ? body.codAmount : 0,
    courierPreference: body.courierPreference || null,
    notes: body.notes || null
  });

  res.status(201).json({ ok: true, request });
});

export const adminFirstShipmentPatchSchema = z.object({
  status: z.nativeEnum(FirstShipmentRequestStatus).optional(),
  courierPreference: z.string().trim().max(120).optional().or(z.literal("")),
  awb: z.string().trim().max(80).optional().or(z.literal("")),
  trackingNumber: z.string().trim().max(120).optional().or(z.literal("")),
  notes: z.string().trim().max(1200).optional().or(z.literal(""))
}).refine((body) => (
  body.status !== undefined ||
  body.courierPreference !== undefined ||
  body.awb !== undefined ||
  body.trackingNumber !== undefined ||
  body.notes !== undefined
), {
  message: "status, courierPreference, awb, trackingNumber or notes is required"
});

export function notFoundFirstShipmentRequest() {
  return new HttpError(404, "FIRST_SHIPMENT_REQUEST_NOT_FOUND");
}
