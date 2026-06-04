import { Router } from "express";
import admin from "../../lib/firebase.js";
import { prisma } from "../../lib/prisma.js";

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

function publicTrackingEvents(shipment: NonNullable<Awaited<ReturnType<typeof findCourierShipmentByAwb>>>) {
  const events = shipment.events.map((event) => ({
    status: event.status,
    location: event.location || "",
    timestamp: event.createdAt,
    description: event.remarks || event.eventType
  }));

  if (events.length > 0) return events;

  return [
    {
      status: shipment.status,
      location: "",
      timestamp: shipment.updatedAt || shipment.createdAt,
      description: shipment.lastEvent || "Shipment status updated."
    }
  ];
}

function normalizeCourierShipment(shipment: Awaited<ReturnType<typeof findCourierShipmentByAwb>>) {
  if (!shipment) return null;

  return {
    shipment: {
      awbNumber: shipment.awbNumber,
      status: shipment.status,
      carrier: shipment.courier.name,
      fromPincode: shipment.fromPincode,
      toPincode: shipment.toPincode,
      labelUrl: null,
      trackingUrl: shipment.trackingUrl,
      lastEvent: shipment.lastEvent || null,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
      expectedDeliveryDate: shipment.expectedDeliveryDate,
      events: publicTrackingEvents(shipment)
    },
    order: {
      orderId: shipment.orderId || shipment.awbNumber,
      customerName: "Shipmastr shipment",
      customerPhone: ""
    }
  };
}

async function findCourierShipmentByAwb(awbNumber: string) {
  return prisma.courierShipment.findUnique({
    where: { awbNumber },
    include: {
      courier: true,
      events: { orderBy: { createdAt: "asc" } }
    }
  });
}

async function findCourierShipmentByOrder(orderId: string) {
  return prisma.courierShipment.findFirst({
    where: { orderId },
    include: {
      courier: true,
      events: { orderBy: { createdAt: "asc" } }
    }
  });
}

trackingRouter.get("/awb/:awbNumber", async (req, res) => {
  const awbNumber = req.params.awbNumber?.trim();
  if (invalidLookup(awbNumber)) {
    return res.status(400).json({ success: false, error: "Invalid lookup value" });
  }

  const courierShipment = normalizeCourierShipment(await findCourierShipmentByAwb(awbNumber!));
  if (courierShipment) {
    return res.json({ success: true, lookupType: "awb", ...courierShipment });
  }

  if (awbNumber !== demoShipment.awbNumber) return notFound(res);
  return res.json(normalizedResponse("awb"));
});

trackingRouter.get("/order/:orderId", async (req, res) => {
  const orderId = req.params.orderId?.trim();
  if (invalidLookup(orderId)) {
    return res.status(400).json({ success: false, error: "Invalid lookup value" });
  }

  const courierShipment = normalizeCourierShipment(await findCourierShipmentByOrder(orderId!));
  if (courierShipment) {
    return res.json({ success: true, lookupType: "order", ...courierShipment });
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

trackingRouter.post("/mobile/verified", async (req, res) => {
  const mobile = String(req.body?.mobile || "").trim();
  const firebaseIdToken = String(req.body?.firebaseIdToken || "").trim();

  if (!/^\d{10}$/.test(mobile) || !firebaseIdToken) {
    return res.status(400).json({ success: false, error: "Invalid lookup value" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
    const tokenPhone = decoded.phone_number || "";
    if (tokenPhone !== `+91${mobile}`) {
      return res.status(403).json({ success: false, error: "Phone verification mismatch" });
    }

    if (mobile !== demoOrder.customerPhone) return notFound(res);
    return res.json(normalizedResponse("mobile"));
  } catch (err) {
    console.error("Firebase mobile tracking verification failed:", err);
    return res.status(401).json({ success: false, error: "Invalid Firebase token" });
  }
});
