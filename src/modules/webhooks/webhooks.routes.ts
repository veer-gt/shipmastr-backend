import { OrderStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { verifyWebhookSignature } from "./webhook.security.js";

export const webhooksRouter = Router();

const schema = z.object({
  externalId: z.string(),
  eventType: z.string(),
  merchantId: z.string().optional(),
  orderId: z.string().optional(),
  externalOrderId: z.string().optional()
}).passthrough();

const statusByEventType: Record<string, OrderStatus> = {
  "shipment.delivered": "DELIVERED",
  "shipment.ndr": "NDR",
  "shipment.rto": "RTO",
  "shipment.shipped": "SHIPPED"
};

webhooksRouter.post(
  "/carrier",
  async (req, res) => {
    const signatureValid = verifyWebhookSignature(
      req.rawBody ?? Buffer.from(JSON.stringify(req.body)),
      req.header("x-shipmastr-signature") ?? undefined
    );

    if (!signatureValid) {
      throw new HttpError(401, "INVALID_WEBHOOK_SIGNATURE");
    }

    const body = schema.parse(req.body);

    const existing = await prisma.webhookEvent.findUnique({
      where: {
        provider_externalId: {
          provider: "CARRIER",
          externalId: body.externalId
        }
      }
    });

    if (existing) {
      return res.json({
        ok: true,
        duplicate: true
      });
    }

    const order = body.orderId
      ? await prisma.order.findUnique({
          where: { id: body.orderId }
        })
      : body.externalOrderId && body.merchantId
        ? await prisma.order.findUnique({
            where: {
              merchantId_externalOrderId: {
                merchantId: body.merchantId,
                externalOrderId: body.externalOrderId
              }
            }
          })
        : null;

    const mappedStatus = statusByEventType[body.eventType];

    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.webhookEvent.create({
        data: {
          provider: "CARRIER",
          externalId: body.externalId,
          eventType: body.eventType,
          payload: body as Prisma.InputJsonObject,
          signatureValid,
          status: "PROCESSED",
          ...(order?.id ? { orderId: order.id } : {})
        }
      });

      if (order && mappedStatus) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: mappedStatus }
        });

        await tx.auditLog.create({
          data: {
            merchantId: order.merchantId,
            action: "ORDER_STATUS_TRANSITIONED",
            entityType: "Order",
            entityId: order.id,
            metadata: {
              eventType: body.eventType,
              externalId: body.externalId,
              status: mappedStatus
            }
          }
        });
      }

      return event;
    });

    res.json({
      ok: true,
      eventId: result.id,
      status: mappedStatus ?? null,
      orderMatched: Boolean(order)
    });
  }
);
