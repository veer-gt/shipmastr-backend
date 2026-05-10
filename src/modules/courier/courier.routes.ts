import { PaymentMode, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env.js";
import { dashboardPathForRole, UserRole } from "../../lib/accountRoles.js";
import { emailTemplates, sendTransactionalEmail, trackingUrl } from "../../lib/email.js";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { requireCourierJwt } from "../../middleware/jwtAuth.js";

export const courierRouter = Router();

const courierLoginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const courierWriteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false
});

const allowedStatuses = [
  "pickup_scheduled",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "ndr",
  "rto_initiated",
  "rto_delivered",
  "lost",
  "damaged"
] as const;

const terminalStatuses = new Set(["delivered", "rto_delivered", "lost", "damaged"]);

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

const statusSchema = z.object({
  status: z.enum(allowedStatuses),
  location: z.string().trim().optional(),
  remarks: z.string().trim().optional()
});

const pickupStatusSchema = z.object({
  status: z.enum(["pickup_scheduled", "picked_up", "in_transit"]),
  location: z.string().trim().optional(),
  remarks: z.string().trim().optional()
});

const ndrSchema = z.object({
  reason: z.string().trim().min(2),
  actionRequired: z.string().trim().min(2),
  nextAttemptDate: z.string().trim().optional(),
  remarks: z.string().trim().optional()
});

const rtoSchema = z.object({
  rtoStatus: z.string().trim().min(2),
  reason: z.string().trim().min(2),
  expectedReturnDate: z.string().trim().optional(),
  remarks: z.string().trim().optional()
});

const webhookSchema = z.object({
  targetUrl: z.string().trim().url(),
  active: z.boolean().default(true),
  events: z.array(z.string().trim().min(1)).default([])
});

function signCourierToken(user: { id: string; courierId: string; role: string }) {
  return jwt.sign(
    {
      userId: user.id,
      courierId: user.courierId,
      role: UserRole.COURIER
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function courierId(req: import("express").Request) {
  const id = req.auth?.courierId;
  if (!id) throw new HttpError(401, "COURIER_TOKEN_REQUIRED");
  return id;
}

function assertTransition(currentStatus: string, nextStatus: string) {
  if (!allowedStatuses.includes(nextStatus as (typeof allowedStatuses)[number])) {
    throw new HttpError(400, "INVALID_STATUS");
  }

  if (terminalStatuses.has(currentStatus) && currentStatus !== nextStatus) {
    throw new HttpError(400, "TERMINAL_STATUS_LOCKED");
  }
}

function publicShipment(shipment: Prisma.CourierShipmentGetPayload<{ include: { courier: true; events: true } }>) {
  return {
    awbNumber: shipment.awbNumber,
    status: shipment.status,
    carrier: shipment.courier.name,
    fromPincode: shipment.fromPincode,
    toPincode: shipment.toPincode,
    labelUrl: null,
    createdAt: shipment.createdAt,
    events: shipment.events.map((event) => ({
      status: event.status,
      location: event.location || "",
      timestamp: event.createdAt,
      description: event.remarks || event.eventType
    }))
  };
}

function cleanWebhookConfig(config: {
  id: string;
  targetUrl: string;
  active: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: config.id,
    targetUrl: config.targetUrl,
    active: config.active,
    events: config.events,
    secret: "configured",
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

async function getMerchantForShipment(orderId?: string | null) {
  if (!orderId) return null;
  return prisma.order.findFirst({
    where: {
      OR: [{ id: orderId }, { externalOrderId: orderId }]
    },
    include: { merchant: true }
  });
}

async function sendStatusEmail(input: {
  orderId?: string | null;
  awbNumber: string;
  status: string;
  latestEvent: string;
}) {
  const order = await getMerchantForShipment(input.orderId);
  if (!order?.merchant.email) return;

  const template = input.status === "ndr"
    ? emailTemplates.ndrUpdate({
        orderId: order.externalOrderId,
        awbNumber: input.awbNumber,
        latestEvent: input.latestEvent,
        trackingUrl: trackingUrl(input.awbNumber)
      })
    : emailTemplates.shipmentStatusUpdate({
        orderId: order.externalOrderId,
        awbNumber: input.awbNumber,
        currentStatus: input.status,
        latestEvent: input.latestEvent,
        trackingUrl: trackingUrl(input.awbNumber)
      });

  await sendTransactionalEmail({
    to: order.merchant.email,
    type: input.status === "ndr" ? "ndr-update" : "shipment-status-update",
    metadata: {
      merchantId: order.merchantId,
      orderId: order.externalOrderId,
      awbNumber: input.awbNumber
    },
    ...template
  });
}

async function updateShipmentStatus(req: import("express").Request, shipmentId: string, body: z.infer<typeof statusSchema>) {
  const scopedCourierId = courierId(req);
  const actorId = req.auth!.userId;

  const shipment = await prisma.courierShipment.findFirst({
    where: {
      id: shipmentId,
      courierId: scopedCourierId
    }
  });

  if (!shipment) throw new HttpError(404, "SHIPMENT_NOT_FOUND");
  assertTransition(shipment.status, body.status);

  const latestEvent = body.remarks || `Courier marked shipment ${body.status}`;
  const updated = await prisma.$transaction(async (tx) => {
    const nextShipment = await tx.courierShipment.update({
      where: { id: shipment.id },
      data: {
        status: body.status,
        lastEvent: latestEvent,
        events: {
          create: {
            courierId: scopedCourierId,
            courierUserId: actorId,
            eventType: "status_update",
            status: body.status,
            location: body.location || null,
            remarks: latestEvent,
            rawPayload: {
              source: "courier_portal"
            }
          }
        }
      },
      include: { courier: true, events: { orderBy: { createdAt: "asc" } } }
    });

    if (body.status === "ndr") {
      await tx.courierNdr.upsert({
        where: { courierShipmentId: shipment.id },
        update: {
          reason: latestEvent,
          actionRequired: "Seller/customer action required",
          remarks: body.remarks || null,
          status: "open"
        },
        create: {
          courierShipmentId: shipment.id,
          courierId: scopedCourierId,
          reason: latestEvent,
          actionRequired: "Seller/customer action required",
          remarks: body.remarks || null
        }
      });
    }

    if (body.status === "rto_initiated" || body.status === "rto_delivered") {
      await tx.courierRto.upsert({
        where: { courierShipmentId: shipment.id },
        update: {
          rtoStatus: body.status,
          reason: latestEvent,
          remarks: body.remarks || null
        },
        create: {
          courierShipmentId: shipment.id,
          courierId: scopedCourierId,
          rtoStatus: body.status,
          reason: latestEvent,
          remarks: body.remarks || null
        }
      });
    }

    await tx.auditLog.create({
      data: {
        actorId,
        action: "COURIER_STATUS_UPDATE",
        entityType: "courier_shipment",
        entityId: shipment.id,
        metadata: {
          courierId: scopedCourierId,
          awbNumber: shipment.awbNumber,
          fromStatus: shipment.status,
          toStatus: body.status,
          location: body.location || null
        }
      }
    });

    return nextShipment;
  });

  sendStatusEmail({
    orderId: updated.orderId,
    awbNumber: updated.awbNumber,
    status: updated.status,
    latestEvent
  }).catch((err) => {
    logger.error({ err, awbNumber: updated.awbNumber }, "Courier status email failed");
  });

  return updated;
}

courierRouter.post("/auth/login", courierLoginLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const courierUser = await prisma.courierUser.findUnique({
    where: { email: body.email.toLowerCase() },
    include: { courier: true }
  });

  if (!courierUser || !courierUser.active || !courierUser.courier.active) {
    throw new HttpError(400, "INVALID_LOGIN");
  }

  const valid = await bcrypt.compare(body.password, courierUser.passwordHash);
  if (!valid) throw new HttpError(400, "INVALID_LOGIN");

  await prisma.courierUser.update({
    where: { id: courierUser.id },
    data: { lastLoginAt: new Date() }
  });

  res.json({
    token: signCourierToken(courierUser),
    role: UserRole.COURIER,
    accountType: UserRole.COURIER,
    dashboardPath: dashboardPathForRole(UserRole.COURIER),
    user: {
      id: courierUser.id,
      name: courierUser.name,
      email: courierUser.email,
      role: UserRole.COURIER,
      accountType: UserRole.COURIER,
      courierId: courierUser.courierId,
      courierName: courierUser.courier.name,
      courierCode: courierUser.courier.code,
      dashboardPath: dashboardPathForRole(UserRole.COURIER)
    }
  });
});

courierRouter.use(requireCourierJwt);

courierRouter.get("/me", async (req, res) => {
  const user = await prisma.courierUser.findUnique({
    where: { id: req.auth!.userId },
    include: { courier: true }
  });

  if (!user) throw new HttpError(404, "COURIER_USER_NOT_FOUND");

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: UserRole.COURIER,
    accountType: UserRole.COURIER,
    courierId: user.courierId,
    courierName: user.courier.name,
    courierCode: user.courier.code,
    dashboardPath: dashboardPathForRole(UserRole.COURIER)
  });
});

courierRouter.get("/shipments", async (req, res) => {
  const shipments = await prisma.courierShipment.findMany({
    where: { courierId: courierId(req) },
    orderBy: { updatedAt: "desc" },
    include: { courier: true, events: { orderBy: { createdAt: "asc" } } }
  });

  res.json({
    shipments: shipments.map((shipment) => ({
      id: shipment.id,
      orderId: shipment.orderId,
      awbNumber: shipment.awbNumber,
      fromPincode: shipment.fromPincode,
      toPincode: shipment.toPincode,
      status: shipment.status,
      weightGrams: shipment.weightGrams,
      paymentMode: shipment.paymentMode,
      codAmount: shipment.codAmount,
      lastEvent: shipment.lastEvent,
      createdAt: shipment.createdAt,
      publicTracking: publicShipment(shipment)
    }))
  });
});

courierRouter.patch("/shipments/:id/status", courierWriteLimiter, async (req, res) => {
  const body = statusSchema.parse(req.body);
  const shipment = await updateShipmentStatus(req, String(req.params.id), body);
  res.json({ shipment });
});

courierRouter.get("/pickups", async (req, res) => {
  const pickups = await prisma.courierShipment.findMany({
    where: {
      courierId: courierId(req),
      status: { in: ["pickup_scheduled", "picked_up"] }
    },
    orderBy: { updatedAt: "desc" }
  });

  res.json({ pickups });
});

courierRouter.patch("/pickups/:id/status", courierWriteLimiter, async (req, res) => {
  const body = pickupStatusSchema.parse(req.body);
  const shipment = await updateShipmentStatus(req, String(req.params.id), body);
  res.json({ shipment });
});

courierRouter.get("/ndr", async (req, res) => {
  const ndr = await prisma.courierNdr.findMany({
    where: { courierId: courierId(req) },
    orderBy: { updatedAt: "desc" },
    include: { shipment: true }
  });

  res.json({ ndr });
});

courierRouter.patch("/ndr/:id", courierWriteLimiter, async (req, res) => {
  const body = ndrSchema.parse(req.body);
  const scopedCourierId = courierId(req);
  const recordId = String(req.params.id);
  const shipment = await prisma.courierShipment.findFirst({
    where: {
      courierId: scopedCourierId,
      OR: [{ id: recordId }, { ndr: { id: recordId } }]
    }
  });

  if (!shipment) throw new HttpError(404, "NDR_NOT_FOUND");

  const ndr = await prisma.$transaction(async (tx) => {
    const record = await tx.courierNdr.upsert({
      where: { courierShipmentId: shipment.id },
      update: {
        reason: body.reason,
        actionRequired: body.actionRequired,
        nextAttemptDate: body.nextAttemptDate ? new Date(body.nextAttemptDate) : null,
        remarks: body.remarks || null,
        status: "open"
      },
      create: {
        courierShipmentId: shipment.id,
        courierId: scopedCourierId,
        reason: body.reason,
        actionRequired: body.actionRequired,
        nextAttemptDate: body.nextAttemptDate ? new Date(body.nextAttemptDate) : null,
        remarks: body.remarks || null
      },
      include: { shipment: true }
    });

    await tx.courierShipment.update({
      where: { id: shipment.id },
      data: {
        status: "ndr",
        lastEvent: body.remarks || body.reason,
        events: {
          create: {
            courierId: scopedCourierId,
            courierUserId: req.auth!.userId,
            eventType: "ndr_update",
            status: "ndr",
            remarks: body.remarks || body.reason
          }
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorId: req.auth!.userId,
        action: "COURIER_NDR_UPDATE",
        entityType: "courier_ndr",
        entityId: record.id,
        metadata: { courierId: scopedCourierId, awbNumber: shipment.awbNumber }
      }
    });

    return record;
  });

  sendStatusEmail({
    orderId: shipment.orderId,
    awbNumber: shipment.awbNumber,
    status: "ndr",
    latestEvent: body.remarks || body.reason
  }).catch((err) => logger.error({ err, awbNumber: shipment.awbNumber }, "Courier NDR email failed"));

  res.json({ ndr });
});

courierRouter.get("/rto", async (req, res) => {
  const rto = await prisma.courierRto.findMany({
    where: { courierId: courierId(req) },
    orderBy: { updatedAt: "desc" },
    include: { shipment: true }
  });

  res.json({ rto });
});

courierRouter.patch("/rto/:id", courierWriteLimiter, async (req, res) => {
  const body = rtoSchema.parse(req.body);
  const scopedCourierId = courierId(req);
  const recordId = String(req.params.id);
  const shipment = await prisma.courierShipment.findFirst({
    where: {
      courierId: scopedCourierId,
      OR: [{ id: recordId }, { rto: { id: recordId } }]
    }
  });

  if (!shipment) throw new HttpError(404, "RTO_NOT_FOUND");

  const rto = await prisma.$transaction(async (tx) => {
    const record = await tx.courierRto.upsert({
      where: { courierShipmentId: shipment.id },
      update: {
        rtoStatus: body.rtoStatus,
        reason: body.reason,
        expectedReturnDate: body.expectedReturnDate ? new Date(body.expectedReturnDate) : null,
        remarks: body.remarks || null
      },
      create: {
        courierShipmentId: shipment.id,
        courierId: scopedCourierId,
        rtoStatus: body.rtoStatus,
        reason: body.reason,
        expectedReturnDate: body.expectedReturnDate ? new Date(body.expectedReturnDate) : null,
        remarks: body.remarks || null
      },
      include: { shipment: true }
    });

    await tx.courierShipment.update({
      where: { id: shipment.id },
      data: {
        status: body.rtoStatus.includes("delivered") ? "rto_delivered" : "rto_initiated",
        lastEvent: body.remarks || body.reason,
        events: {
          create: {
            courierId: scopedCourierId,
            courierUserId: req.auth!.userId,
            eventType: "rto_update",
            status: body.rtoStatus,
            remarks: body.remarks || body.reason
          }
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorId: req.auth!.userId,
        action: "COURIER_RTO_UPDATE",
        entityType: "courier_rto",
        entityId: record.id,
        metadata: { courierId: scopedCourierId, awbNumber: shipment.awbNumber }
      }
    });

    return record;
  });

  res.json({ rto });
});

courierRouter.get("/webhooks", async (req, res) => {
  const configs = await prisma.courierWebhookConfig.findMany({
    where: { courierId: courierId(req) },
    orderBy: { createdAt: "desc" }
  });

  res.json({
    docs: {
      authentication: "Shipmastr signs outbound courier webhook payloads with the configured shared secret.",
      events: allowedStatuses
    },
    configs: configs.map(cleanWebhookConfig)
  });
});

courierRouter.post("/webhooks", courierWriteLimiter, async (req, res) => {
  const body = webhookSchema.parse(req.body);
  const config = await prisma.courierWebhookConfig.create({
    data: {
      courierId: courierId(req),
      targetUrl: body.targetUrl,
      active: body.active,
      events: body.events,
      secret: randomBytes(24).toString("hex")
    }
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.auth!.userId,
      action: "COURIER_WEBHOOK_CONFIG_CREATED",
      entityType: "courier_webhook_config",
      entityId: config.id,
      metadata: { courierId: courierId(req), targetUrl: body.targetUrl, events: body.events }
    }
  });

  res.status(201).json({ config: cleanWebhookConfig(config) });
});

courierRouter.get("/scorecard", async (req, res) => {
  const scopedCourierId = courierId(req);
  const shipments = await prisma.courierShipment.findMany({
    where: { courierId: scopedCourierId }
  });

  const shipmentCount = shipments.length;
  const delivered = shipments.filter((shipment) => shipment.status === "delivered").length;
  const rto = shipments.filter((shipment) => shipment.status.startsWith("rto")).length;
  const ndr = shipments.filter((shipment) => shipment.status === "ndr").length;
  const active = shipments.filter((shipment) => !terminalStatuses.has(shipment.status)).length;

  res.json({
    scorecard: {
      shipmentCount,
      deliveryRate: shipmentCount ? Number(((delivered / shipmentCount) * 100).toFixed(1)) : 0,
      rtoRate: shipmentCount ? Number(((rto / shipmentCount) * 100).toFixed(1)) : 0,
      ndrRate: shipmentCount ? Number(((ndr / shipmentCount) * 100).toFixed(1)) : 0,
      avgDeliveryDays: 0,
      codDelayDays: 0,
      activeShipments: active
    }
  });
});

courierRouter.get("/invoices", async (req, res) => {
  const invoices = await prisma.courierInvoice.findMany({
    where: { courierId: courierId(req) },
    orderBy: { periodEnd: "desc" }
  });

  res.json({ invoices });
});
