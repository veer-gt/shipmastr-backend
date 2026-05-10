import { Router } from "express";
import { z } from "zod";
import { emailTemplates, sendTransactionalEmail, trackingUrl } from "../../lib/email.js";
import { prisma } from "../../lib/prisma.js";

export const shipmentsRouter = Router();

const demoShipment = {
  id: "ship_demo_bliss_17774438577588613",
  awbNumber: "BLISS17774438577588613",
  status: "confirmed",
  carrier: "Demo Courier",
  fromPincode: "302001",
  toPincode: "560001",
  labelUrl: null,
  createdAt: "2026-04-29T10:12:00.000Z",
  events: [
    {
      status: "confirmed",
      location: "Jaipur",
      timestamp: "2026-04-29T10:12:00.000Z",
      description: "Shipment created"
    }
  ],
  order: {
    orderId: "SM-ORD-2941",
    customerName: "Demo Customer",
    customerPhone: "9999999999"
  }
};

const createShipmentSchema = z.object({
  orderId: z.string().optional(),
  carrier: z.string().optional(),
  fromPincode: z.string().optional(),
  toPincode: z.string().optional(),
  expectedDeliveryDate: z.string().optional()
});

shipmentsRouter.get("/", (_req, res) => {
  res.json([demoShipment]);
});

shipmentsRouter.post("/", async (req, res) => {
  const body = createShipmentSchema.parse(req.body);
  const shipment = {
    ...demoShipment,
    carrier: body.carrier || demoShipment.carrier,
    fromPincode: body.fromPincode || demoShipment.fromPincode,
    toPincode: body.toPincode || demoShipment.toPincode,
    order: {
      ...demoShipment.order,
      orderId: body.orderId || demoShipment.order.orderId
    },
    expectedDeliveryDate: body.expectedDeliveryDate || null
  };

  const merchant = await prisma.merchant.findUnique({
    where: { id: req.auth!.merchantId }
  });

  if (merchant?.email) {
    const template = emailTemplates.shipmentCreated({
      orderId: shipment.order.orderId,
      awbNumber: shipment.awbNumber,
      carrier: shipment.carrier,
      trackingUrl: trackingUrl(shipment.awbNumber),
      expectedDeliveryDate: shipment.expectedDeliveryDate
    });

    await sendTransactionalEmail({
      to: merchant.email,
      type: "shipment-created",
      metadata: {
        merchantId: merchant.id,
        orderId: shipment.order.orderId,
        awbNumber: shipment.awbNumber
      },
      ...template
    });
  }

  res.status(201).json(shipment);
});
