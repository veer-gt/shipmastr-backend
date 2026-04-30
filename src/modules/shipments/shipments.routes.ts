import { Router } from "express";
import { z } from "zod";

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
  toPincode: z.string().optional()
});

shipmentsRouter.get("/", (_req, res) => {
  res.json([demoShipment]);
});

shipmentsRouter.post("/", (req, res) => {
  const body = createShipmentSchema.parse(req.body);

  res.status(201).json({
    ...demoShipment,
    carrier: body.carrier || demoShipment.carrier,
    fromPincode: body.fromPincode || demoShipment.fromPincode,
    toPincode: body.toPincode || demoShipment.toPincode,
    order: {
      ...demoShipment.order,
      orderId: body.orderId || demoShipment.order.orderId
    }
  });
});
