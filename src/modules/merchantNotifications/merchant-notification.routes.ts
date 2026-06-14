import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  generateImportDigestNotification,
  getMerchantNotification,
  getMerchantNotificationPreferences,
  getUnreadMerchantNotificationCount,
  listMerchantNotifications,
  markAllMerchantNotificationsRead,
  markMerchantNotificationRead,
  markMerchantNotificationUnread,
  updateMerchantNotificationPreferences
} from "./merchant-notification.service.js";
import {
  listMerchantNotificationsQuerySchema,
  updateMerchantNotificationPreferencesSchema
} from "./merchant-notification.validation.js";

export const merchantNotificationsRouter = Router();

function routeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

merchantNotificationsRouter.get("/merchant-notifications", async (req, res) => {
  const query = listMerchantNotificationsQuerySchema.parse(req.query);
  const data = await listMerchantNotifications(req.auth!.merchantId, query);
  return res.json(successEnvelope("Merchant notifications fetched successfully.", data));
});

merchantNotificationsRouter.get("/merchant-notifications/unread-count", async (req, res) => {
  const data = await getUnreadMerchantNotificationCount(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant notification unread count fetched successfully.", data));
});

merchantNotificationsRouter.post("/merchant-notifications/mark-all-read", async (req, res) => {
  const data = await markAllMerchantNotificationsRead(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant notifications marked read.", data));
});

merchantNotificationsRouter.post("/merchant-notifications/import-digest/generate", async (req, res) => {
  const data = await generateImportDigestNotification(req.auth!.merchantId);
  return res.status(201).json(successEnvelope("Import digest notification generated in-app only.", data));
});

merchantNotificationsRouter.get("/merchant-notifications/:notificationId", async (req, res) => {
  const data = await getMerchantNotification(req.auth!.merchantId, routeParam(req.params.notificationId));
  return res.json(successEnvelope("Merchant notification fetched successfully.", data));
});

merchantNotificationsRouter.post("/merchant-notifications/:notificationId/read", async (req, res) => {
  const data = await markMerchantNotificationRead(req.auth!.merchantId, routeParam(req.params.notificationId));
  return res.json(successEnvelope("Merchant notification marked read.", data));
});

merchantNotificationsRouter.post("/merchant-notifications/:notificationId/unread", async (req, res) => {
  const data = await markMerchantNotificationUnread(req.auth!.merchantId, routeParam(req.params.notificationId));
  return res.json(successEnvelope("Merchant notification marked unread.", data));
});

merchantNotificationsRouter.get("/merchant-notification-preferences", async (req, res) => {
  const data = await getMerchantNotificationPreferences(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant notification preferences fetched successfully.", data));
});

merchantNotificationsRouter.put("/merchant-notification-preferences", async (req, res) => {
  const body = updateMerchantNotificationPreferencesSchema.parse(req.body);
  const data = await updateMerchantNotificationPreferences(req.auth!.merchantId, body);
  return res.json(successEnvelope("Merchant notification preferences updated safely.", data));
});
