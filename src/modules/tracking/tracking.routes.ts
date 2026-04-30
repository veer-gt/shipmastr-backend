import { Router } from "express";

export const trackingRouter = Router();

function buildTrackingPayload(awbNumber: string) {
  const now = new Date().toISOString();

  return {
    awbNumber,
    carrier: "Courier allocation pending",
    status: "tracking_active",
    estimatedDeliveryDate: null,
    promise: {
      badge: "Shipmastr Tracking",
      estimatedDeliveryDate: null,
      serviceLevel: "Standard"
    },
    merchant: {
      businessName: "Shipmastr",
      logoText: "Shipmastr",
      primaryColor: "#3d35b8",
      accentColor: "#0f766e",
      supportEmail: "",
      supportPhone: "",
      websiteUrl: "https://shipmastr.com"
    },
    engagement: {
      bannerHeadline: "Your shipment tracking is active.",
      bannerSubcopy: "Use this page for shipment status, support, and post-purchase updates from Shipmastr.",
      socialLinks: {},
      recommendations: []
    },
    timeline: [
      { label: "Tracking lookup received", completed: true },
      { label: "Courier allocation", completed: false },
      { label: "In transit", completed: false },
      { label: "Out for delivery", completed: false },
      { label: "Delivered", completed: false }
    ],
    notifications: [],
    customerActions: {
      canRequestOtp: false,
      canReschedule: false,
      maskedPhone: "",
      accessWindowMinutes: 30
    },
    order: null,
    events: [
      {
        status: "tracking_active",
        description: "Shipment tracking is available for this AWB.",
        timestamp: now
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

trackingRouter.get("/awb/:awbNumber", (req, res) => {
  res.json(buildTrackingPayload(req.params.awbNumber));
});
