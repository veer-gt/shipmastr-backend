import {
  AdminOnboardingChecklistItemStatus,
  CourierSandboxVerificationStatus,
  FirstShipmentRequestStatus,
  LeadStatus,
  MerchantAdminStatus,
  OrderStatus,
  Prisma,
  SellerKycStatus
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { normalizeCourierServiceTaxClassification } from "../../lib/courierServiceTax.js";
import { normalizeOptionalGstin, normalizeRequiredGstin } from "../../lib/gstin.js";
import { HttpError } from "../../lib/httpError.js";
import { convertLeadToSeller, listLeads, updateLead } from "../leads/lead.service.js";
import { createSellerInvite } from "../auth/password-reset.service.js";
import {
  adminFirstShipmentPatchSchema,
  notFoundFirstShipmentRequest
} from "../firstShipmentRequest/first-shipment-request.routes.js";
import {
  convertFirstShipmentRequestToManualShipment,
  listAdminFirstShipmentRequests,
  updateFirstShipmentRequest
} from "../firstShipmentRequest/first-shipment-request.service.js";
import {
  deleteCourierServiceablePincode,
  getCourierPilotSetup,
  updateCourierPilotChecklistItem,
  upsertCourierServiceablePincodes
} from "../courierPilot/courier-pilot.service.js";
import {
  getAdminCourierDeveloperCredentials,
  issueCourierDeveloperCredentials,
  revokeCourierDeveloperCredentials,
  rotateCourierDeveloperApiKey,
  rotateCourierDeveloperSigningSecret
} from "../courierDeveloper/courier-developer.service.js";
import { getCourierActivationReadiness } from "../taxCompliance/tax-compliance.service.js";
import {
  getAdminSellerDetail,
  listAdminSellers,
  updateAdminSeller
} from "./services/admin-seller.service.js";
import { buildAdminOpsDashboard } from "./services/admin-ops-dashboard.service.js";
import {
  getAdminOnboardingChecklistAudit,
  getOrInitAdminOnboardingChecklist,
  patchAdminOnboardingChecklistItem
} from "./services/admin-onboarding-checklist.service.js";
import {
  manualShipmentStatusValues,
  updateManualShipmentStatus
} from "./services/manual-shipment-status.service.js";

export const adminRouter = Router();

async function courierDeveloperCredentialActor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, userType: true }
  });

  if (!user || user.userType !== "INTERNAL_SHIPMASTR" || !["MASTER_ADMIN", "COURIER_MANAGER"].includes(user.role)) {
    throw new HttpError(403, "COURIER_DEVELOPER_CREDENTIAL_ADMIN_ONLY");
  }

  return user.role;
}

const courierSchema = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().min(2),
  gstin: z.string().trim().max(15),
  serviceCodeType: z.literal("SAC").default("SAC"),
  serviceCode: z.enum(["996811", "996812", "996813", "996819"]).default("996812"),
  serviceDescription: z.string().trim().optional().or(z.literal("")),
  gstRate: z.coerce.number().default(18),
  active: z.boolean().default(true),
  apiMode: z.enum(["manual", "mock", "live"]).default("manual"),
  bookingMode: z.enum(["manual", "api", "hybrid"]).default("manual"),
  supportsCOD: z.boolean().default(true),
  supportsPrepaid: z.boolean().default(true),
  supportsPickup: z.boolean().default(true),
  priority: z.number().int().min(1).default(100),
  trackingUrlTemplate: z.string().trim().url().optional().or(z.literal(""))
});

const courierPatchSchema = courierSchema.partial();

const courierUserSchema = z.object({
  courierId: z.string().min(1),
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  password: z.string().min(8),
  active: z.boolean().default(true)
});

const courierUserPatchSchema = z.object({
  name: z.string().trim().min(2).optional(),
  email: z.string().trim().email().optional(),
  password: z.string().min(8).optional(),
  active: z.boolean().optional()
});

const courierShipmentSchema = z.object({
  courierId: z.string().min(1),
  awbNumber: z.string().trim().min(4),
  orderId: z.string().trim().optional(),
  fromPincode: z.string().trim().regex(/^\d{6}$/),
  toPincode: z.string().trim().regex(/^\d{6}$/),
  status: z.string().trim().min(2).default("pickup_scheduled"),
  weightGrams: z.number().int().positive().optional(),
  paymentMode: z.enum(["PREPAID", "COD", "prepaid", "cod"]).default("PREPAID"),
  codAmount: z.number().int().min(0).default(0),
  freightEstimate: z.number().int().min(0).optional(),
  trackingUrl: z.string().trim().url().optional().or(z.literal("")),
  opsNotes: z.string().trim().max(2000).optional().or(z.literal("")),
  firstShipmentRequestId: z.string().trim().optional().or(z.literal("")),
  expectedDeliveryDate: z.string().trim().optional()
});

const manualShipmentStatusUpdateSchema = z.object({
  status: z.enum(manualShipmentStatusValues),
  eventType: z.string().trim().min(2).max(80).optional().or(z.literal("")),
  location: z.string().trim().max(160).optional().or(z.literal("")),
  remarks: z.string().trim().max(500).optional().or(z.literal(""))
});

const rateCardSchema = z.object({
  courierId: z.string().min(1),
  zone: z.string().trim().min(1).default("standard"),
  minWeight: z.number().int().min(0),
  maxWeight: z.number().int().positive(),
  baseRate: z.number().int().min(0),
  additionalRate: z.number().int().min(0).default(0),
  codFee: z.number().int().min(0).default(0),
  fuelSurcharge: z.number().int().min(0).default(0),
  rtoCharge: z.number().int().min(0).default(0),
  etaDays: z.number().int().positive().default(5)
}).refine((body) => body.maxWeight >= body.minWeight, {
  path: ["maxWeight"],
  message: "maxWeight must be greater than or equal to minWeight"
});

const rateCardBulkSchema = z.object({
  rateCards: z.array(rateCardSchema).min(1).max(200)
});

const serviceablePincodeSchema = z.object({
  pincodes: z.array(z.string()).min(1).max(500),
  supportsPickup: z.boolean().default(true),
  supportsDelivery: z.boolean().default(true),
  supportsCOD: z.boolean().default(true),
  active: z.boolean().default(true),
  notes: z.string().trim().max(1200).optional().or(z.literal(""))
});

const courierPilotChecklistPatchSchema = z.object({
  status: z.nativeEnum(CourierSandboxVerificationStatus).optional(),
  owner: z.string().trim().max(160).optional().nullable().or(z.literal("")),
  notes: z.string().trim().max(2500).optional().nullable().or(z.literal("")),
  evidenceUrl: z.string().trim().url().optional().nullable().or(z.literal(""))
}).refine((body) => (
  body.status !== undefined ||
  body.owner !== undefined ||
  body.notes !== undefined ||
  body.evidenceUrl !== undefined
), {
  message: "At least one pilot checklist field is required"
});

const manualShipmentFromRequestSchema = z.object({
  courierId: z.string().trim().min(1),
  awbNumber: z.string().trim().min(4).max(80),
  freightEstimate: z.number().int().min(0).optional(),
  codAmount: z.number().int().min(0).optional(),
  status: z.string().trim().min(2).max(80).default("pickup_scheduled"),
  trackingUrl: z.string().trim().url().optional().or(z.literal("")),
  opsNotes: z.string().trim().max(2000).optional().or(z.literal(""))
});

const serviceabilitySchema = z.object({
  fromPincode: z.string().trim().regex(/^\d{6}$/),
  toPincode: z.string().trim().regex(/^\d{6}$/),
  weight: z.number().positive(),
  paymentMode: z.enum(["PREPAID", "COD", "prepaid", "cod"])
});

const leadQuerySchema = z.object({
  status: z.nativeEnum(LeadStatus).optional()
});

const leadPatchSchema = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  notes: z.string().trim().max(1200).optional().or(z.literal(""))
}).refine((body) => body.status !== undefined || body.notes !== undefined, {
  message: "status or notes is required"
});

const sellerPatchSchema = z.object({
  gstin: z.string().trim().max(15).optional().nullable().or(z.literal("")),
  adminStatus: z.nativeEnum(MerchantAdminStatus).optional(),
  sellerKycStatus: z.nativeEnum(SellerKycStatus).optional(),
  sellerKycChecklist: z.record(z.string(), z.unknown()).optional(),
  sellerKycNotes: z.string().trim().max(2500).optional().nullable().or(z.literal("")),
  adminNotes: z.string().trim().max(2000).optional().nullable().or(z.literal("")),
  onboardingNotes: z.string().trim().max(2000).optional().nullable().or(z.literal(""))
}).refine((body) => (
  body.gstin !== undefined ||
  body.adminStatus !== undefined ||
  body.sellerKycStatus !== undefined ||
  body.sellerKycChecklist !== undefined ||
  body.sellerKycNotes !== undefined ||
  body.adminNotes !== undefined ||
  body.onboardingNotes !== undefined
), {
  message: "At least one seller admin field is required"
});

const adminOnboardingPatchSchema = z.object({
  status: z.nativeEnum(AdminOnboardingChecklistItemStatus).optional(),
  owner: z.string().trim().max(160).optional().nullable().or(z.literal("")),
  notes: z.string().trim().max(2500).optional().nullable().or(z.literal("")),
  dueDate: z.coerce.date().optional().nullable().or(z.literal("")),
  blockerReason: z.string().trim().max(1000).optional().nullable().or(z.literal("")),
  completedAt: z.coerce.date().optional().nullable().or(z.literal(""))
}).refine((body) => (
  body.status !== undefined ||
  body.owner !== undefined ||
  body.notes !== undefined ||
  body.dueDate !== undefined ||
  body.blockerReason !== undefined ||
  body.completedAt !== undefined
), {
  message: "At least one checklist item field is required"
});

function zoneForLane(fromPincode: string, toPincode: string) {
  return fromPincode.slice(0, 2) === toPincode.slice(0, 2) ? "local" : "standard";
}

function priceForRate(rate: {
  minWeight: number;
  maxWeight: number;
  baseRate: number;
  additionalRate: number;
  codFee: number;
  fuelSurcharge: number;
}, weightGrams: number, paymentMode: string) {
  const extraWeight = Math.max(0, weightGrams - rate.minWeight);
  const extraBlocks = Math.ceil(extraWeight / 500);
  return rate.baseRate + extraBlocks * rate.additionalRate + rate.fuelSurcharge + (paymentMode.toUpperCase() === "COD" ? rate.codFee : 0);
}

adminRouter.get("/couriers", async (_req, res) => {
  const couriers = await prisma.courierPartner.findMany({
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }]
  });
  res.json({ couriers });
});

adminRouter.post("/couriers", async (req, res) => {
  const body = courierSchema.parse(req.body);
  const serviceTax = normalizeCourierServiceTaxClassification(body);
  const courier = await prisma.courierPartner.create({
    data: {
      ...body,
      code: body.code.toUpperCase(),
      gstin: normalizeRequiredGstin(body.gstin),
      serviceCodeType: serviceTax.serviceCodeType,
      serviceCode: serviceTax.serviceCode,
      serviceDescription: serviceTax.serviceDescription,
      gstRate: serviceTax.gstRate,
      trackingUrlTemplate: body.trackingUrlTemplate || null
    }
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "ADMIN_COURIER_CREATED",
      entityType: "courier_partner",
      entityId: courier.id,
      metadata: {
        courierId: courier.id,
        code: courier.code,
        apiMode: courier.apiMode,
        bookingMode: courier.bookingMode
      }
    }
  });

  res.status(201).json({ courier });
});

adminRouter.patch("/couriers/:id", async (req, res) => {
  const body = courierPatchSchema.parse(req.body);
  const data: Prisma.CourierPartnerUpdateInput = {};

  if (body.name !== undefined) data.name = body.name;
  if (body.code !== undefined) data.code = body.code.toUpperCase();
  if (body.gstin !== undefined) data.gstin = normalizeRequiredGstin(body.gstin);
  if (
    body.serviceCodeType !== undefined ||
    body.serviceCode !== undefined ||
    body.serviceDescription !== undefined ||
    body.gstRate !== undefined
  ) {
    const serviceTax = normalizeCourierServiceTaxClassification(body);
    data.serviceCodeType = serviceTax.serviceCodeType;
    data.serviceCode = serviceTax.serviceCode;
    data.serviceDescription = serviceTax.serviceDescription;
    data.gstRate = serviceTax.gstRate;
  }
  if (body.active !== undefined) data.active = body.active;
  if (body.apiMode !== undefined) data.apiMode = body.apiMode;
  if (body.bookingMode !== undefined) data.bookingMode = body.bookingMode;
  if (body.supportsCOD !== undefined) data.supportsCOD = body.supportsCOD;
  if (body.supportsPrepaid !== undefined) data.supportsPrepaid = body.supportsPrepaid;
  if (body.supportsPickup !== undefined) data.supportsPickup = body.supportsPickup;
  if (body.priority !== undefined) data.priority = body.priority;
  if (body.trackingUrlTemplate !== undefined) data.trackingUrlTemplate = body.trackingUrlTemplate || null;

  if (body.apiMode === "live") {
    const readiness = await getCourierActivationReadiness(req.params.id);
    if (!readiness.ready) {
      await prisma.auditLog.create({
        data: {
          actorId: req.auth!.userId,
          action: "ADMIN_COURIER_LIVE_ACTIVATION_BLOCKED",
          entityType: "courier_partner",
          entityId: req.params.id,
          metadata: {
            courierId: req.params.id,
            issues: readiness.issues
          }
        }
      });
      throw new HttpError(400, readiness.issues[0]?.code || "COURIER_NOT_READY_FOR_LIVE");
    }
  }

  const courier = await prisma.courierPartner.update({
    where: { id: req.params.id },
    data
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: body.apiMode === "live" ? "ADMIN_COURIER_LIVE_ACTIVATED" : "ADMIN_COURIER_UPDATED",
      entityType: "courier_partner",
      entityId: courier.id,
      metadata: {
        courierId: courier.id,
        apiMode: courier.apiMode,
        bookingMode: courier.bookingMode,
        active: courier.active
      }
    }
  });

  res.json({ courier });
});

adminRouter.get("/couriers/:courierId/setup", async (req, res) => {
  res.json(await getCourierPilotSetup(req.params.courierId));
});

adminRouter.get("/couriers/:courierId/developer-credentials", async (req, res) => {
  await courierDeveloperCredentialActor(req.auth!.userId);
  res.json(await getAdminCourierDeveloperCredentials({ courierId: req.params.courierId }));
});

adminRouter.post("/couriers/:courierId/developer-credentials/issue", async (req, res) => {
  const actorRole = await courierDeveloperCredentialActor(req.auth!.userId);
  const result = await issueCourierDeveloperCredentials({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    actorRole
  });

  res.status(201).json(result);
});

adminRouter.post("/couriers/:courierId/developer-credentials/rotate-api-key", async (req, res) => {
  const actorRole = await courierDeveloperCredentialActor(req.auth!.userId);
  const result = await rotateCourierDeveloperApiKey({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    actorRole
  });

  res.json(result);
});

adminRouter.post("/couriers/:courierId/developer-credentials/rotate-signing-secret", async (req, res) => {
  const actorRole = await courierDeveloperCredentialActor(req.auth!.userId);
  const result = await rotateCourierDeveloperSigningSecret({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    actorRole
  });

  res.json(result);
});

adminRouter.post("/couriers/:courierId/developer-credentials/revoke", async (req, res) => {
  const actorRole = await courierDeveloperCredentialActor(req.auth!.userId);
  const result = await revokeCourierDeveloperCredentials({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    actorRole
  });

  res.json(result);
});

adminRouter.post("/couriers/:courierId/serviceable-pincodes", async (req, res) => {
  const body = serviceablePincodeSchema.parse(req.body);
  const records = await upsertCourierServiceablePincodes({
    courierId: req.params.courierId,
    actorId: req.auth!.userId,
    patch: body
  });

  res.status(201).json({ serviceablePincodes: records });
});

adminRouter.delete("/couriers/:courierId/serviceable-pincodes/:pincodeId", async (req, res) => {
  const record = await deleteCourierServiceablePincode({
    courierId: req.params.courierId,
    pincodeId: req.params.pincodeId,
    actorId: req.auth!.userId
  });

  res.json({ serviceablePincode: record });
});

adminRouter.patch("/couriers/:courierId/pilot-checklist/:itemKey", async (req, res) => {
  const body = courierPilotChecklistPatchSchema.parse(req.body);
  const item = await updateCourierPilotChecklistItem({
    courierId: req.params.courierId,
    itemKey: req.params.itemKey,
    actorId: req.auth!.userId,
    patch: {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.owner !== undefined ? { owner: body.owner || null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      ...(body.evidenceUrl !== undefined ? { evidenceUrl: body.evidenceUrl || null } : {})
    }
  });

  res.json({ item });
});

adminRouter.get("/courier-users", async (_req, res) => {
  const users = await prisma.courierUser.findMany({
    include: { courier: true },
    orderBy: { createdAt: "desc" }
  });

  res.json({
    users: users.map((user) => ({
      id: user.id,
      courierId: user.courierId,
      courierName: user.courier.name,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt
    }))
  });
});

adminRouter.post("/courier-users", async (req, res) => {
  const body = courierUserSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const user = await prisma.courierUser.create({
    data: {
      courierId: body.courierId,
      name: body.name,
      email: body.email.toLowerCase(),
      passwordHash,
      active: body.active
    },
    include: { courier: true }
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "ADMIN_COURIER_USER_CREATED",
      entityType: "courier_user",
      entityId: user.id,
      metadata: {
        courierId: user.courierId,
        email: user.email
      }
    }
  });

  res.status(201).json({
    user: {
      id: user.id,
      courierId: user.courierId,
      courierName: user.courier.name,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      createdAt: user.createdAt
    }
  });
});

adminRouter.patch("/courier-users/:id", async (req, res) => {
  const body = courierUserPatchSchema.parse(req.body);
  const data: Prisma.CourierUserUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.email !== undefined) data.email = body.email.toLowerCase();
  if (body.active !== undefined) data.active = body.active;
  if (body.password !== undefined) data.passwordHash = await bcrypt.hash(body.password, 12);

  const user = await prisma.courierUser.update({
    where: { id: req.params.id },
    data,
    include: { courier: true }
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "ADMIN_COURIER_USER_UPDATED",
      entityType: "courier_user",
      entityId: user.id,
      metadata: {
        courierId: user.courierId,
        email: user.email,
        active: user.active
      }
    }
  });

  res.json({
    user: {
      id: user.id,
      courierId: user.courierId,
      courierName: user.courier.name,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt
    }
  });
});

adminRouter.get("/rate-cards", async (_req, res) => {
  const rateCards = await prisma.rateCard.findMany({
    include: { courier: true },
    orderBy: [{ createdAt: "desc" }]
  });
  res.json({ rateCards });
});

adminRouter.post("/rate-cards", async (req, res) => {
  const body = rateCardSchema.parse(req.body);
  const rateCard = await prisma.rateCard.create({
    data: body,
    include: { courier: true }
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "ADMIN_RATE_CARD_CREATED",
      entityType: "rate_card",
      entityId: rateCard.id,
      metadata: {
        courierId: rateCard.courierId,
        zone: rateCard.zone,
        minWeight: rateCard.minWeight,
        maxWeight: rateCard.maxWeight
      }
    }
  });

  res.status(201).json({ rateCard });
});

adminRouter.post("/rate-cards/bulk", async (req, res) => {
  const body = rateCardBulkSchema.parse(req.body);
  const rateCards = await prisma.$transaction(body.rateCards.map((rateCard) => (
    prisma.rateCard.create({
      data: rateCard,
      include: { courier: true }
    })
  )));

  const courierIds = [...new Set(rateCards.map((rateCard) => rateCard.courierId))];
  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "ADMIN_RATE_CARDS_BULK_CREATED",
      entityType: "rate_card",
      metadata: {
        rateCardCount: rateCards.length,
        courierIds
      }
    }
  });

  res.status(201).json({ rateCards });
});

adminRouter.post("/serviceability/check", async (req, res) => {
  const body = serviceabilitySchema.parse(req.body);
  const zone = zoneForLane(body.fromPincode, body.toPincode);
  const weightGrams = Math.ceil(body.weight * 1000);
  const paymentMode = body.paymentMode.toUpperCase();

  const rateCards = await prisma.rateCard.findMany({
    where: {
      minWeight: { lte: weightGrams },
      maxWeight: { gte: weightGrams },
      courier: {
        active: true,
        ...(paymentMode === "COD" ? { supportsCOD: true } : { supportsPrepaid: true }),
        AND: [
          { serviceablePincodes: { some: { pincode: body.fromPincode, active: true, supportsPickup: true } } },
          {
            serviceablePincodes: {
              some: {
                pincode: body.toPincode,
                active: true,
                supportsDelivery: true,
                ...(paymentMode === "COD" ? { supportsCOD: true } : {})
              }
            }
          }
        ]
      },
      OR: [{ zone }, { zone: "standard" }]
    },
    include: { courier: true }
  });

  const options = rateCards
    .map((rateCard) => ({
      courierId: rateCard.courierId,
      courierName: rateCard.courier.name,
      courierCode: rateCard.courier.code,
      apiMode: rateCard.courier.apiMode,
      priority: rateCard.courier.priority,
      zone: rateCard.zone,
      price: priceForRate(rateCard, weightGrams, paymentMode),
      etaDays: rateCard.etaDays,
      supportsPickup: rateCard.courier.supportsPickup
    }))
    .sort((a, b) => a.price - b.price || a.priority - b.priority || a.etaDays - b.etaDays);

  res.json({ fromPincode: body.fromPincode, toPincode: body.toPincode, paymentMode, weightGrams, options });
});

adminRouter.get("/shipments", async (_req, res) => {
  const courierShipments = await prisma.courierShipment.findMany({
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { courier: true, events: { orderBy: { createdAt: "desc" }, take: 1 } }
  });

  if (courierShipments.length) {
    return res.json({
      shipments: courierShipments.map((shipment) => ({
        id: shipment.id,
        orderId: shipment.orderId,
        awbNumber: shipment.awbNumber,
        carrier: shipment.courier.name,
        courierId: shipment.courierId,
        status: shipment.status,
        fromPincode: shipment.fromPincode,
        toPincode: shipment.toPincode,
        weightGrams: shipment.weightGrams,
        paymentMode: shipment.paymentMode,
        codAmount: shipment.codAmount,
        freightEstimate: shipment.freightEstimate,
        trackingUrl: shipment.trackingUrl,
        opsNotes: shipment.opsNotes,
        firstShipmentRequestId: shipment.firstShipmentRequestId,
        lastEvent: shipment.lastEvent || shipment.events[0]?.remarks || null,
        createdAt: shipment.createdAt
      }))
    });
  }

  const orders = await prisma.order.findMany({
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { merchant: true }
  });

  res.json({
    shipments: orders.map((order) => ({
      id: order.id,
      orderId: order.externalOrderId,
      awbNumber: `PENDING-${order.externalOrderId}`,
      carrier: "Manual allocation",
      status: order.status,
      merchant: order.merchant.name,
      fromPincode: null,
      toPincode: order.pincode,
      createdAt: order.createdAt
    }))
  });
});

adminRouter.post("/shipments", async (req, res) => {
  const body = courierShipmentSchema.parse(req.body);
  const shipment = await prisma.courierShipment.create({
    data: {
      courierId: body.courierId,
      awbNumber: body.awbNumber.toUpperCase(),
      firstShipmentRequestId: body.firstShipmentRequestId || null,
      orderId: body.orderId || null,
      fromPincode: body.fromPincode,
      toPincode: body.toPincode,
      status: body.status,
      weightGrams: body.weightGrams || null,
      paymentMode: body.paymentMode.toUpperCase() as "PREPAID" | "COD",
      codAmount: body.codAmount,
      freightEstimate: body.freightEstimate ?? null,
      trackingUrl: body.trackingUrl || null,
      opsNotes: body.opsNotes || null,
      expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
      lastEvent: "Shipment assigned to courier",
      events: {
        create: {
          courierId: body.courierId,
          courierUserId: req.auth!.userId,
          eventType: "shipment_assigned",
          status: body.status,
          remarks: "Shipment assigned to courier"
        }
      }
    },
    include: { courier: true, events: true }
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "ADMIN_COURIER_SHIPMENT_ASSIGNED",
      entityType: "courier_shipment",
      entityId: shipment.id,
      metadata: {
        courierId: shipment.courierId,
        awbNumber: shipment.awbNumber,
        orderId: shipment.orderId,
        firstShipmentRequestId: shipment.firstShipmentRequestId,
        freightEstimate: shipment.freightEstimate,
        codAmount: shipment.codAmount,
        status: shipment.status
      }
    }
  });

  res.status(201).json({ shipment });
});

adminRouter.patch("/shipments/:id/status", async (req, res) => {
  const body = manualShipmentStatusUpdateSchema.parse(req.body);
  const result = await updateManualShipmentStatus({
    shipmentIdOrAwb: req.params.id,
    actorId: req.auth!.userId,
    status: body.status,
    eventType: body.eventType || null,
    location: body.location || null,
    remarks: body.remarks || null
  });

  res.json({
    shipment: {
      orderId: result.shipment.orderId,
      awbNumber: result.shipment.awbNumber,
      carrier: result.shipment.courier.name,
      status: result.shipment.status,
      previousStatus: result.previousStatus,
      fromPincode: result.shipment.fromPincode,
      toPincode: result.shipment.toPincode,
      trackingUrl: result.shipment.trackingUrl,
      lastEvent: result.shipment.lastEvent,
      updatedAt: result.shipment.updatedAt,
      events: result.shipment.events.map((event) => ({
        status: event.status,
        eventType: event.eventType,
        location: event.location || "",
        remarks: event.remarks || event.eventType,
        createdAt: event.createdAt
      }))
    }
  });
});

adminRouter.get("/webhook-events", async (_req, res) => {
  const events = await prisma.webhookEvent.findMany({
    take: 100,
    orderBy: { receivedAt: "desc" }
  });

  res.json({
    events: events.map((event) => {
      const payload = event.payload as Prisma.JsonObject;
      return {
        id: event.id,
        courierCode: String(payload.courierCode || payload.carrier || event.provider),
        awbNumber: String(payload.awbNumber || payload.trackingNumber || event.externalId),
        eventType: event.eventType,
        status: event.status,
        rawPayload: event.payload,
        receivedAt: event.receivedAt
      };
    })
  });
});

adminRouter.get("/courier-scorecard", async (_req, res) => {
  const couriers = await prisma.courierPartner.findMany({
    orderBy: { priority: "asc" }
  });
  const orders = await prisma.order.findMany();
  const totalOrders = orders.length;
  const counts = {
    delivered: orders.filter((order) => order.status === OrderStatus.DELIVERED).length,
    ndr: orders.filter((order) => order.status === OrderStatus.NDR).length,
    rto: orders.filter((order) => order.status === OrderStatus.RTO).length
  };

  res.json({
    scorecard: couriers.map((courier) => ({
      courierId: courier.id,
      courierName: courier.name,
      courierCode: courier.code,
      deliveryRate: totalOrders ? Number(((counts.delivered / totalOrders) * 100).toFixed(1)) : 0,
      rtoRate: totalOrders ? Number(((counts.rto / totalOrders) * 100).toFixed(1)) : 0,
      ndrRate: totalOrders ? Number(((counts.ndr / totalOrders) * 100).toFixed(1)) : 0,
      avgDeliveryDays: 0,
      codDelayDays: 0,
      shipmentCount: totalOrders
    }))
  });
});

adminRouter.get("/leads", async (req, res) => {
  const query = leadQuerySchema.parse(req.query);
  res.json(await listLeads(query.status ? { status: query.status as LeadStatus } : {}));
});

adminRouter.get("/ops-dashboard", async (_req, res) => {
  res.json(await buildAdminOpsDashboard());
});

adminRouter.get("/onboarding", async (req, res) => {
  const checklist = await getOrInitAdminOnboardingChecklist(req.auth!.userId);
  res.json(checklist);
});

adminRouter.post("/onboarding/init", async (req, res) => {
  const checklist = await getOrInitAdminOnboardingChecklist(req.auth!.userId);
  res.status(201).json(checklist);
});

adminRouter.patch("/onboarding/items/:itemKey", async (req, res) => {
  const params = z.object({ itemKey: z.string().trim().min(1) }).parse(req.params);
  const body = adminOnboardingPatchSchema.parse(req.body);
  const patch: Parameters<typeof patchAdminOnboardingChecklistItem>[0]["patch"] = {};

  if (body.status !== undefined) patch.status = body.status;
  if (body.owner !== undefined) patch.owner = body.owner || null;
  if (body.notes !== undefined) patch.notes = body.notes || null;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate === "" ? null : body.dueDate;
  if (body.blockerReason !== undefined) patch.blockerReason = body.blockerReason || null;
  if (body.completedAt !== undefined) patch.completedAt = body.completedAt === "" ? null : body.completedAt;

  const result = await patchAdminOnboardingChecklistItem({
    actorId: req.auth!.userId,
    itemKey: params.itemKey,
    patch
  });

  if (!result) throw new HttpError(404, "ADMIN_ONBOARDING_ITEM_NOT_FOUND");

  res.json(result);
});

adminRouter.get("/onboarding/audit", async (_req, res) => {
  res.json(await getAdminOnboardingChecklistAudit());
});

adminRouter.patch("/leads/:id", async (req, res) => {
  const body = leadPatchSchema.parse(req.body);
  const patch: { status?: LeadStatus; notes?: string } = {};
  if (body.status !== undefined) patch.status = body.status as LeadStatus;
  if (body.notes !== undefined) patch.notes = body.notes;

  const input: Parameters<typeof updateLead>[0] = {
    id: req.params.id,
    patch
  };
  if (req.auth?.userId) input.actorId = req.auth.userId;

  const result = await updateLead(input);

  if (!result) {
    throw new HttpError(404, "LEAD_NOT_FOUND");
  }

  res.json(result);
});

adminRouter.post("/leads/:id/convert", async (req, res) => {
  const input: Parameters<typeof convertLeadToSeller>[0] = {
    id: req.params.id
  };
  if (req.auth?.userId) input.actorId = req.auth.userId;

  const result = await convertLeadToSeller(input);

  if (!result) {
    throw new HttpError(404, "LEAD_NOT_FOUND");
  }

  res.json({ ok: true, ...result });
});

adminRouter.post("/users/:id/invite", async (req, res) => {
  const input: Parameters<typeof createSellerInvite>[0] = {
    userId: req.params.id
  };
  if (req.auth?.userId) input.actorId = req.auth.userId;

  res.json(await createSellerInvite(input));
});

adminRouter.get("/sellers", async (_req, res) => {
  res.json(await listAdminSellers());
});

adminRouter.get("/sellers/:merchantId", async (req, res) => {
  const result = await getAdminSellerDetail(req.params.merchantId);
  if (!result) throw new HttpError(404, "SELLER_NOT_FOUND");

  res.json(result);
});

adminRouter.patch("/sellers/:merchantId", async (req, res) => {
  const body = sellerPatchSchema.parse(req.body);
  const patch: Parameters<typeof updateAdminSeller>[0]["patch"] = {};
  if (body.gstin !== undefined) patch.gstin = body.gstin;
  if (body.adminStatus !== undefined) patch.adminStatus = body.adminStatus;
  if (body.sellerKycStatus !== undefined) patch.sellerKycStatus = body.sellerKycStatus;
  if (body.sellerKycChecklist !== undefined) patch.sellerKycChecklist = body.sellerKycChecklist;
  if (body.sellerKycNotes !== undefined) patch.sellerKycNotes = body.sellerKycNotes;
  if (body.adminNotes !== undefined) patch.adminNotes = body.adminNotes;
  if (body.onboardingNotes !== undefined) patch.onboardingNotes = body.onboardingNotes;

  const input: Parameters<typeof updateAdminSeller>[0] = {
    merchantId: req.params.merchantId,
    patch
  };
  if (req.auth?.userId) input.actorId = req.auth.userId;

  const result = await updateAdminSeller(input);
  if (!result) throw new HttpError(404, "SELLER_NOT_FOUND");

  res.json(result);
});

adminRouter.get("/first-shipment-requests", async (_req, res) => {
  res.json(await listAdminFirstShipmentRequests());
});

adminRouter.patch("/first-shipment-requests/:id", async (req, res) => {
  const body = adminFirstShipmentPatchSchema.parse(req.body);
  const patch: Parameters<typeof updateFirstShipmentRequest>[0]["patch"] = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.courierPreference !== undefined) patch.courierPreference = body.courierPreference;
  if (body.assignedCourierId !== undefined) patch.assignedCourierId = body.assignedCourierId || null;
  if (body.freightEstimate !== undefined) patch.freightEstimate = body.freightEstimate === "" ? null : body.freightEstimate;
  if (body.codAmount !== undefined) patch.codAmount = body.codAmount === "" ? null : body.codAmount;
  if (body.awb !== undefined) patch.awb = body.awb;
  if (body.trackingNumber !== undefined) patch.trackingNumber = body.trackingNumber;
  if (body.trackingUrl !== undefined) patch.trackingUrl = body.trackingUrl || null;
  if (body.opsNotes !== undefined) patch.opsNotes = body.opsNotes || null;
  if (body.notes !== undefined) patch.notes = body.notes;

  const input: Parameters<typeof updateFirstShipmentRequest>[0] = {
    id: req.params.id,
    patch
  };
  if (req.auth?.userId) input.actorId = req.auth.userId;

  const result = await updateFirstShipmentRequest(input);
  if (!result) throw notFoundFirstShipmentRequest();

  res.json({ request: result });
});

adminRouter.post("/first-shipment-requests/:id/manual-shipment", async (req, res) => {
  const body = manualShipmentFromRequestSchema.parse(req.body);
  const result = await convertFirstShipmentRequestToManualShipment({
    requestId: req.params.id,
    actorId: req.auth!.userId,
    courierId: body.courierId,
    awbNumber: body.awbNumber,
    freightEstimate: body.freightEstimate,
    codAmount: body.codAmount,
    status: body.status,
    trackingUrl: body.trackingUrl || null,
    opsNotes: body.opsNotes || null
  });

  res.status(201).json(result);
});

adminRouter.use((_req, _res, next) => {
  next(new HttpError(404, "ADMIN_ROUTE_NOT_FOUND"));
});
