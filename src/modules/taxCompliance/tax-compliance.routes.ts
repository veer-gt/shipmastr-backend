import { PickupPointStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import {
  approveMerchantPickupPoint,
  createCourierGstinRecord,
  createCourierOperationalLocation,
  createMerchantGstinRecord,
  createMerchantPickupPoint,
  listCourierTaxProfile,
  listMerchantTaxProfile,
  rejectCourierGstinRecord,
  rejectMerchantGstinRecord,
  rejectMerchantPickupPoint,
  updateCourierOperationalLocation,
  updateMerchantPickupPoint,
  verifyCourierGstinRecord,
  verifyMerchantGstinRecord
} from "./tax-compliance.service.js";

export const sellerTaxComplianceRouter = Router();
export const courierTaxComplianceRouter = Router();
export const adminTaxComplianceRouter = Router();

const gstinRecordSchema = z.object({
  gstin: z.string().trim().max(15),
  legalName: z.string().trim().max(240).optional().nullable().or(z.literal("")),
  tradeName: z.string().trim().max(240).optional().nullable().or(z.literal("")),
  registrationStatus: z.string().trim().max(120).optional().nullable().or(z.literal("")),
  registeredAddress: z.string().trim().max(1000).optional().nullable().or(z.literal("")),
  registeredState: z.string().trim().min(2).max(120),
  registeredPincode: z.string().trim().regex(/^\d{6}$/).optional().nullable().or(z.literal("")),
  source: z.string().trim().max(120).optional().nullable().or(z.literal(""))
});

const locationSchema = z.object({
  label: z.string().trim().min(2).max(160),
  contactName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(8).max(20),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  addressLine1: z.string().trim().min(4).max(500),
  addressLine2: z.string().trim().max(500).optional().nullable().or(z.literal("")),
  city: z.string().trim().min(2).max(160),
  state: z.string().trim().min(2).max(120),
  pincode: z.string().trim().regex(/^\d{6}$/),
  isDefault: z.boolean().optional()
});

const locationPatchSchema = locationSchema.partial().extend({
  status: z.nativeEnum(PickupPointStatus).optional(),
  rejectionReason: z.string().trim().max(800).optional().nullable().or(z.literal(""))
}).refine((body) => Object.keys(body).length > 0, {
  message: "At least one pickup field is required"
});

const reasonSchema = z.object({
  reason: z.string().trim().max(800).optional().nullable().or(z.literal(""))
});

sellerTaxComplianceRouter.get("/", async (req, res) => {
  res.json(await listMerchantTaxProfile(req.auth!.merchantId!));
});

sellerTaxComplianceRouter.post("/gstins", async (req, res) => {
  const body = gstinRecordSchema.parse(req.body);
  const result = await createMerchantGstinRecord({
    merchantId: req.auth!.merchantId!,
    actorId: req.auth!.userId,
    record: body
  });

  res.status(201).json({ gstinRecord: result });
});

sellerTaxComplianceRouter.post("/pickup-points", async (req, res) => {
  const body = locationSchema.parse(req.body);
  const result = await createMerchantPickupPoint({
    merchantId: req.auth!.merchantId!,
    actorId: req.auth!.userId,
    pickup: body
  });

  res.status(201).json({ pickupPoint: result });
});

sellerTaxComplianceRouter.patch("/pickup-points/:pickupPointId", async (req, res) => {
  const body = locationPatchSchema.parse(req.body);
  const result = await updateMerchantPickupPoint({
    merchantId: req.auth!.merchantId!,
    actorId: req.auth!.userId,
    pickupPointId: req.params.pickupPointId,
    patch: body
  });

  res.json({ pickupPoint: result });
});

courierTaxComplianceRouter.get("/", async (req, res) => {
  res.json(await listCourierTaxProfile(req.auth!.courierId!));
});

courierTaxComplianceRouter.post("/gstins", async (req, res) => {
  const body = gstinRecordSchema.parse(req.body);
  const result = await createCourierGstinRecord({
    courierId: req.auth!.courierId!,
    actorId: req.auth!.userId,
    record: { ...body, source: body.source || "COURIER_PORTAL" }
  });

  res.status(201).json({ gstinRecord: result });
});

courierTaxComplianceRouter.post("/operational-locations", async (req, res) => {
  const body = locationSchema.parse(req.body);
  const result = await createCourierOperationalLocation({
    courierId: req.auth!.courierId!,
    actorId: req.auth!.userId,
    location: body
  });

  res.status(201).json({ operationalLocation: result });
});

courierTaxComplianceRouter.patch("/operational-locations/:locationId", async (req, res) => {
  const body = locationPatchSchema.parse(req.body);
  const result = await updateCourierOperationalLocation({
    courierId: req.auth!.courierId!,
    actorId: req.auth!.userId,
    locationId: req.params.locationId,
    patch: body
  });

  res.json({ operationalLocation: result });
});

adminTaxComplianceRouter.get("/sellers/:merchantId", async (req, res) => {
  res.json(await listMerchantTaxProfile(req.params.merchantId));
});

adminTaxComplianceRouter.post("/sellers/:merchantId/gstins", async (req, res) => {
  const body = gstinRecordSchema.parse(req.body);
  const result = await createMerchantGstinRecord({
    merchantId: req.params.merchantId,
    actorId: req.auth!.userId,
    record: body
  });

  res.status(201).json({ gstinRecord: result });
});

adminTaxComplianceRouter.post("/sellers/:merchantId/gstins/:gstinRecordId/verify", async (req, res) => {
  const result = await verifyMerchantGstinRecord({
    merchantId: req.params.merchantId,
    gstinRecordId: req.params.gstinRecordId,
    actorId: req.auth!.userId
  });

  res.json({ gstinRecord: result });
});

adminTaxComplianceRouter.post("/sellers/:merchantId/gstins/:gstinRecordId/reject", async (req, res) => {
  const body = reasonSchema.parse(req.body);
  const result = await rejectMerchantGstinRecord({
    merchantId: req.params.merchantId,
    gstinRecordId: req.params.gstinRecordId,
    actorId: req.auth!.userId,
    reason: body.reason
  });

  res.json({ gstinRecord: result });
});

adminTaxComplianceRouter.post("/sellers/:merchantId/pickup-points", async (req, res) => {
  const body = locationSchema.parse(req.body);
  const result = await createMerchantPickupPoint({
    merchantId: req.params.merchantId,
    actorId: req.auth!.userId,
    pickup: body
  });

  res.status(201).json({ pickupPoint: result });
});

adminTaxComplianceRouter.patch("/sellers/:merchantId/pickup-points/:pickupPointId", async (req, res) => {
  const body = locationPatchSchema.parse(req.body);
  const result = await updateMerchantPickupPoint({
    merchantId: req.params.merchantId,
    pickupPointId: req.params.pickupPointId,
    actorId: req.auth!.userId,
    patch: body
  });

  res.json({ pickupPoint: result });
});

adminTaxComplianceRouter.post("/sellers/:merchantId/pickup-points/:pickupPointId/approve", async (req, res) => {
  const result = await approveMerchantPickupPoint({
    merchantId: req.params.merchantId,
    pickupPointId: req.params.pickupPointId,
    actorId: req.auth!.userId
  });

  res.json({ pickupPoint: result });
});

adminTaxComplianceRouter.post("/sellers/:merchantId/pickup-points/:pickupPointId/reject", async (req, res) => {
  const body = reasonSchema.parse(req.body);
  const result = await rejectMerchantPickupPoint({
    merchantId: req.params.merchantId,
    pickupPointId: req.params.pickupPointId,
    actorId: req.auth!.userId,
    reason: body.reason
  });

  res.json({ pickupPoint: result });
});

adminTaxComplianceRouter.get("/couriers/:courierId", async (req, res) => {
  res.json(await listCourierTaxProfile(req.params.courierId));
});

adminTaxComplianceRouter.post("/couriers/:courierId/gstins", async (req, res) => {
  const body = gstinRecordSchema.parse(req.body);
  const result = await createCourierGstinRecord({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    record: { ...body, source: body.source || "ADMIN" }
  });

  res.status(201).json({ gstinRecord: result });
});

adminTaxComplianceRouter.post("/couriers/:courierId/gstins/:gstinRecordId/verify", async (req, res) => {
  const result = await verifyCourierGstinRecord({
    courierId: req.params.courierId,
    gstinRecordId: req.params.gstinRecordId,
    actorId: req.auth!.userId
  });

  res.json({ gstinRecord: result });
});

adminTaxComplianceRouter.post("/couriers/:courierId/gstins/:gstinRecordId/reject", async (req, res) => {
  const body = reasonSchema.parse(req.body);
  const result = await rejectCourierGstinRecord({
    courierId: req.params.courierId,
    gstinRecordId: req.params.gstinRecordId,
    actorId: req.auth!.userId,
    reason: body.reason
  });

  res.json({ gstinRecord: result });
});

adminTaxComplianceRouter.post("/couriers/:courierId/operational-locations", async (req, res) => {
  const body = locationSchema.parse(req.body);
  const result = await createCourierOperationalLocation({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    location: body
  });

  res.status(201).json({ operationalLocation: result });
});

adminTaxComplianceRouter.patch("/couriers/:courierId/operational-locations/:locationId", async (req, res) => {
  const body = locationPatchSchema.parse(req.body);
  const result = await updateCourierOperationalLocation({
    courierId: req.params.courierId,
    locationId: req.params.locationId,
    actorId: req.auth!.userId,
    patch: body
  });

  res.json({ operationalLocation: result });
});
