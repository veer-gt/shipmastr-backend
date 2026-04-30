import { Router } from "express";

export const trackingRouter = Router();

const demoOrder = {
  orderId: "SM-ORD-2941",
  customerName: "Demo Customer",
  customerPhone: "9999999999"
};

const demoShipment = {
  awbNumber: "BLISS17774438577588613",
  status: "in_transit",
  carrier: "Demo Courier",
  fromPincode: "302001",
  toPincode: "560001",
  labelUrl: null,
  createdAt: "2026-04-29T10:12:00.000Z",
  events: [
    {
      status: "created",
      location: "Jaipur",
      timestamp: "2026-04-29T10:12:00.000Z",
      description: "Order created"
    },
    {
      status: "picked_up",
      location: "Jaipur hub",
      timestamp: "2026-04-29T17:18:00.000Z",
      description: "Shipment picked up"
    },
    {
      status: "in_transit",
      location: "North sort center",
      timestamp: "2026-04-30T09:10:00.000Z",
      description: "Shipment is moving through the courier network"
    }
  ]
};

function invalidLookup(value: string | undefined) {
  return !value || !value.trim();
}

function notFound(res: import("express").Response) {
  return res.status(404).json({
    success: false,
    error: "Shipment not found"
  });
}

function normalizedResponse(lookupType: "awb" | "order" | "mobile") {
  return {
    success: true,
    lookupType,
    shipment: demoShipment,
    order: demoOrder
  };
}

trackingRouter.get("/awb/:awbNumber", (req, res) => {
  const awbNumber = req.params.awbNumber?.trim();
  if (invalidLookup(awbNumber)) {
    return res.status(400).json({ success: false, error: "Invalid lookup value" });
  }

  if (awbNumber !== demoShipment.awbNumber) return notFound(res);
  return res.json(normalizedResponse("awb"));
});

trackingRouter.get("/order/:orderId", (req, res) => {
  const orderId = req.params.orderId?.trim();
  if (invalidLookup(orderId)) {
    return res.status(400).json({ success: false, error: "Invalid lookup value" });
  }

  if (orderId !== demoOrder.orderId) return notFound(res);
  return res.json(normalizedResponse("order"));
});

trackingRouter.get("/mobile/:mobile", (req, res) => {
  const mobile = req.params.mobile?.trim();
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return res.status(400).json({ success: false, error: "Invalid lookup value" });
  }

  if (mobile !== demoOrder.customerPhone) return notFound(res);
  return res.json(normalizedResponse("mobile"));
});
