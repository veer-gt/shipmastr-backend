import { LeadStatus, OrderStatus, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { convertLeadToSeller, listLeads, updateLead } from "../leads/lead.service.js";
import { createSellerInvite } from "../auth/password-reset.service.js";

export const adminRouter = Router();

const courierSchema = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().min(2),
  active: z.boolean().default(true),
  apiMode: z.enum(["manual", "mock", "live"]).default("manual"),
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
  expectedDeliveryDate: z.string().trim().optional()
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
  const courier = await prisma.courierPartner.create({
    data: {
      ...body,
      code: body.code.toUpperCase(),
      trackingUrlTemplate: body.trackingUrlTemplate || null
    }
  });
  res.status(201).json({ courier });
});

adminRouter.patch("/couriers/:id", async (req, res) => {
  const body = courierPatchSchema.parse(req.body);
  const data: Prisma.CourierPartnerUpdateInput = {};

  if (body.name !== undefined) data.name = body.name;
  if (body.code !== undefined) data.code = body.code.toUpperCase();
  if (body.active !== undefined) data.active = body.active;
  if (body.apiMode !== undefined) data.apiMode = body.apiMode;
  if (body.supportsCOD !== undefined) data.supportsCOD = body.supportsCOD;
  if (body.supportsPrepaid !== undefined) data.supportsPrepaid = body.supportsPrepaid;
  if (body.supportsPickup !== undefined) data.supportsPickup = body.supportsPickup;
  if (body.priority !== undefined) data.priority = body.priority;
  if (body.trackingUrlTemplate !== undefined) data.trackingUrlTemplate = body.trackingUrlTemplate || null;

  const courier = await prisma.courierPartner.update({
    where: { id: req.params.id },
    data
  });
  res.json({ courier });
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
  res.status(201).json({ rateCard });
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
        ...(paymentMode === "COD" ? { supportsCOD: true } : { supportsPrepaid: true })
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
      orderId: body.orderId || null,
      fromPincode: body.fromPincode,
      toPincode: body.toPincode,
      status: body.status,
      weightGrams: body.weightGrams || null,
      paymentMode: body.paymentMode.toUpperCase() as "PREPAID" | "COD",
      codAmount: body.codAmount,
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
        orderId: shipment.orderId
      }
    }
  });

  res.status(201).json({ shipment });
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

adminRouter.use((_req, _res, next) => {
  next(new HttpError(404, "ADMIN_ROUTE_NOT_FOUND"));
});
