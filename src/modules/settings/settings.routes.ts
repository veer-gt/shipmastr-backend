import { Router, type Response } from "express";
import { z } from "zod";
import { getSellerSettingsProfile, type SellerSettingsPatch, updateSellerSettingsProfile } from "./settings.service.js";

export const settingsRouter = Router();

const trackingBrandingSchema = z.object({
  logoText: z.string().trim().max(120).optional(),
  primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bannerHeadline: z.string().trim().max(180).optional(),
  bannerSubcopy: z.string().trim().max(500).optional(),
  supportEmail: z.string().trim().email().or(z.literal("")).optional(),
  supportPhone: z.string().trim().max(40).optional(),
  websiteUrl: z.string().trim().max(300).optional()
}).strict();

const socialLinksSchema = z.object({
  instagram: z.string().trim().max(300).optional(),
  facebook: z.string().trim().max(300).optional(),
  whatsapp: z.string().trim().max(300).optional(),
  supportPortal: z.string().trim().max(300).optional()
}).strict();

const notificationPreferencesSchema = z.object({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  ivr: z.boolean().optional()
}).strict();

const patchProfileSchema = z.object({
  businessName: z.string().trim().min(2).max(160).optional(),
  brandedWhatsAppNumber: z.string().trim().max(40).optional(),
  settings: z.object({
    trackingBranding: trackingBrandingSchema.optional(),
    socialLinks: socialLinksSchema.optional(),
    notificationPreferences: notificationPreferencesSchema.optional()
  }).strict().optional()
}).strict();

function sendNoStoreJson(res: Response, body: unknown) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.json(body);
}

settingsRouter.get("/", async (req, res) => {
  const profile = await getSellerSettingsProfile(req.auth!.userId, req.auth!.merchantId);
  sendNoStoreJson(res, { profile, settings: profile.settings });
});

settingsRouter.get("/profile", async (req, res) => {
  const profile = await getSellerSettingsProfile(req.auth!.userId, req.auth!.merchantId);
  sendNoStoreJson(res, profile);
});

settingsRouter.patch("/profile", async (req, res) => {
  const body = patchProfileSchema.parse(req.body);
  const profile = await updateSellerSettingsProfile({
    userId: req.auth!.userId,
    merchantId: req.auth!.merchantId,
    patch: body as SellerSettingsPatch
  });
  sendNoStoreJson(res, { profile, settings: profile.settings });
});
