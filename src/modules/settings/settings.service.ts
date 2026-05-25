import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

const DEFAULT_TRACKING_BRANDING = {
  logoText: "",
  primaryColor: "#0e5c84",
  accentColor: "#c66d1a",
  bannerHeadline: "",
  bannerSubcopy: "",
  supportEmail: "",
  supportPhone: "",
  websiteUrl: ""
};

const DEFAULT_SOCIAL_LINKS = {
  instagram: "",
  facebook: "",
  whatsapp: "",
  supportPortal: ""
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  email: true,
  sms: true,
  whatsapp: false,
  ivr: false
};

type TrackingBrandingPatch = Partial<typeof DEFAULT_TRACKING_BRANDING>;
type SocialLinksPatch = Partial<typeof DEFAULT_SOCIAL_LINKS>;
type NotificationPreferencesPatch = Partial<typeof DEFAULT_NOTIFICATION_PREFERENCES>;

export type SellerSettingsPatch = {
  businessName?: string;
  brandedWhatsAppNumber?: string;
  settings?: {
    trackingBranding?: TrackingBrandingPatch;
    socialLinks?: SocialLinksPatch;
    notificationPreferences?: NotificationPreferencesPatch;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function colorValue(value: unknown, fallback: string) {
  const candidate = stringValue(value);
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate : fallback;
}

function profileFromMetadata(metadata: unknown) {
  if (!isRecord(metadata)) return {};
  const profile = metadata.sellerSettingsProfile;
  return isRecord(profile) ? profile : {};
}

function normalizeTrackingBranding(input: unknown, merchant: { name: string; email: string; phone: string | null }) {
  const record = isRecord(input) ? input : {};

  return {
    ...DEFAULT_TRACKING_BRANDING,
    logoText: stringValue(record.logoText, merchant.name),
    primaryColor: colorValue(record.primaryColor, DEFAULT_TRACKING_BRANDING.primaryColor),
    accentColor: colorValue(record.accentColor, DEFAULT_TRACKING_BRANDING.accentColor),
    bannerHeadline: stringValue(record.bannerHeadline),
    bannerSubcopy: stringValue(record.bannerSubcopy),
    supportEmail: stringValue(record.supportEmail, merchant.email),
    supportPhone: stringValue(record.supportPhone, merchant.phone || ""),
    websiteUrl: stringValue(record.websiteUrl)
  };
}

function normalizeSocialLinks(input: unknown) {
  const record = isRecord(input) ? input : {};

  return {
    ...DEFAULT_SOCIAL_LINKS,
    instagram: stringValue(record.instagram),
    facebook: stringValue(record.facebook),
    whatsapp: stringValue(record.whatsapp),
    supportPortal: stringValue(record.supportPortal)
  };
}

function normalizeNotificationPreferences(input: unknown) {
  const record = isRecord(input) ? input : {};

  return {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    email: booleanValue(record.email, DEFAULT_NOTIFICATION_PREFERENCES.email),
    sms: booleanValue(record.sms, DEFAULT_NOTIFICATION_PREFERENCES.sms),
    whatsapp: booleanValue(record.whatsapp, DEFAULT_NOTIFICATION_PREFERENCES.whatsapp),
    ivr: booleanValue(record.ivr, DEFAULT_NOTIFICATION_PREFERENCES.ivr)
  };
}

function buildProfile(input: {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    userType: string;
    merchantId: string;
  };
  merchant: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    onboardingStatus: string;
  };
  metadata: unknown;
}) {
  const savedProfile = profileFromMetadata(input.metadata);
  const trackingBranding = normalizeTrackingBranding(savedProfile.trackingBranding, input.merchant);
  const socialLinks = normalizeSocialLinks(savedProfile.socialLinks);
  const notificationPreferences = normalizeNotificationPreferences(savedProfile.notificationPreferences);
  const brandedWhatsAppNumber = stringValue(savedProfile.brandedWhatsAppNumber, input.merchant.phone || "");

  const settings = {
    merchantName: input.merchant.name,
    businessName: input.merchant.name,
    supportEmail: trackingBranding.supportEmail || null,
    supportPhone: trackingBranding.supportPhone || null,
    brandColor: trackingBranding.primaryColor || null,
    logoUrl: null,
    trackingPageEnabled: true,
    brandedWhatsAppNumber,
    trackingBranding,
    socialLinks,
    notificationPreferences,
    notificationChannels: {
      email: notificationPreferences.email,
      whatsapp: notificationPreferences.whatsapp
    }
  };

  return {
    id: input.user.id,
    email: input.user.email,
    name: input.user.name,
    role: input.user.role,
    userType: input.user.userType,
    merchantId: input.merchant.id,
    businessName: input.merchant.name,
    merchantName: input.merchant.name,
    onboardingStatus: input.merchant.onboardingStatus,
    merchant: {
      id: input.merchant.id,
      name: input.merchant.name,
      businessName: input.merchant.name,
      onboardingStatus: input.merchant.onboardingStatus
    },
    settings
  };
}

export async function getSellerSettingsProfile(userId: string, merchantId: string, client: Db = prisma) {
  const [user, merchant, policy] = await Promise.all([
    client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        userType: true,
        merchantId: true
      }
    }),
    client.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        onboardingStatus: true
      }
    }),
    client.automationPreference.findUnique({
      where: { merchantId },
      select: { metadata: true }
    })
  ]);

  if (!user || user.merchantId !== merchantId || !merchant) {
    throw new HttpError(403, "MERCHANT_SETTINGS_SCOPE_DENIED");
  }

  return buildProfile({
    user,
    merchant,
    metadata: policy?.metadata
  });
}

function buildStoredSettings(existingMetadata: unknown, patch: SellerSettingsPatch, currentProfile: Awaited<ReturnType<typeof getSellerSettingsProfile>>) {
  const metadata = isRecord(existingMetadata) ? existingMetadata : {};
  const saved = profileFromMetadata(metadata);
  const trackingBranding = {
    ...currentProfile.settings.trackingBranding,
    ...(isRecord(saved.trackingBranding) ? saved.trackingBranding : {}),
    ...(patch.settings?.trackingBranding || {})
  };
  const socialLinks = {
    ...currentProfile.settings.socialLinks,
    ...(isRecord(saved.socialLinks) ? saved.socialLinks : {}),
    ...(patch.settings?.socialLinks || {})
  };
  const notificationPreferences = {
    ...currentProfile.settings.notificationPreferences,
    ...(isRecord(saved.notificationPreferences) ? saved.notificationPreferences : {}),
    ...(patch.settings?.notificationPreferences || {})
  };

  return {
    ...metadata,
    sellerSettingsProfile: {
      brandedWhatsAppNumber: stringValue(patch.brandedWhatsAppNumber, currentProfile.settings.brandedWhatsAppNumber),
      trackingBranding: normalizeTrackingBranding(trackingBranding, {
        name: patch.businessName || currentProfile.businessName,
        email: currentProfile.email,
        phone: currentProfile.settings.brandedWhatsAppNumber || null
      }),
      socialLinks: normalizeSocialLinks(socialLinks),
      notificationPreferences: normalizeNotificationPreferences(notificationPreferences)
    }
  };
}

export async function updateSellerSettingsProfile(input: {
  userId: string;
  merchantId: string;
  patch: SellerSettingsPatch;
}, client: Db = prisma) {
  const currentProfile = await getSellerSettingsProfile(input.userId, input.merchantId, client);
  const policy = await client.automationPreference.findUnique({
    where: { merchantId: input.merchantId },
    select: { metadata: true }
  });

  if (input.patch.businessName) {
    await client.merchant.update({
      where: { id: input.merchantId },
      data: { name: input.patch.businessName.trim() }
    });
  }

  const metadata = buildStoredSettings(policy?.metadata, input.patch, currentProfile);

  await client.automationPreference.upsert({
    where: { merchantId: input.merchantId },
    create: {
      merchantId: input.merchantId,
      metadata: metadata as Prisma.InputJsonValue
    },
    update: {
      metadata: metadata as Prisma.InputJsonValue
    }
  });

  return getSellerSettingsProfile(input.userId, input.merchantId, client);
}
