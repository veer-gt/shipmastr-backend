import type { Request, Response, NextFunction } from "express";

import { env } from "../../config/env.js";
import { UserRole, isAdminRole, isCourierRole } from "../../lib/accountRoles.js";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";

export const growthNetworkMerchantSellerMessage =
  "Growth Network is available for authenticated Shipmastr merchants and sellers." as const;
export const growthNetworkDisabledMessage =
  "This Growth Network capability is currently disabled." as const;

export type GrowthNetworkAudience = "MERCHANT_SELLER_ONLY";

export type GrowthNetworkRuntimeConfig = {
  enabled: boolean;
  audience: GrowthNetworkAudience;
  externalAdsEnabled: boolean;
  billingEnabled: boolean;
  partnerRoutingEnabled: boolean;
  messagingEnabled: boolean;
  paymentEnabled: boolean;
  buyerExportEnabled: boolean;
  publicTrackingEnabled: boolean;
};

export type GrowthNetworkRuntimeStatus = {
  enabled: boolean;
  audience: GrowthNetworkAudience;
  message: string;
  modules: {
    billing: boolean;
    externalAds: boolean;
    partnerRouting: boolean;
    messaging: boolean;
    payments: boolean;
    buyerExport: boolean;
    publicTracking: boolean;
  };
  safetyDisabledModules: {
    billing: boolean;
    externalAds: boolean;
    partnerRouting: boolean;
    messaging: boolean;
    payments: boolean;
    buyerExport: boolean;
    publicTracking: boolean;
  };
};

export function currentGrowthNetworkRuntime(): GrowthNetworkRuntimeConfig {
  return {
    enabled: env.GROWTH_NETWORK_ENABLED,
    audience: env.GROWTH_NETWORK_AUDIENCE,
    externalAdsEnabled: env.GROWTH_NETWORK_EXTERNAL_ADS_ENABLED,
    billingEnabled: env.GROWTH_NETWORK_BILLING_ENABLED,
    partnerRoutingEnabled: env.GROWTH_NETWORK_PARTNER_ROUTING_ENABLED,
    messagingEnabled: env.GROWTH_NETWORK_MESSAGING_ENABLED,
    paymentEnabled: env.GROWTH_NETWORK_PAYMENT_ENABLED,
    buyerExportEnabled: env.GROWTH_NETWORK_BUYER_EXPORT_ENABLED,
    publicTrackingEnabled: env.GROWTH_NETWORK_PUBLIC_TRACKING_ENABLED
  };
}

export function serializeGrowthNetworkRuntimeStatus(
  runtime: GrowthNetworkRuntimeConfig = currentGrowthNetworkRuntime()
): GrowthNetworkRuntimeStatus {
  return {
    enabled: runtime.enabled,
    audience: runtime.audience,
    message: runtime.enabled ? growthNetworkMerchantSellerMessage : growthNetworkDisabledMessage,
    modules: {
      billing: runtime.billingEnabled,
      externalAds: runtime.externalAdsEnabled,
      partnerRouting: runtime.partnerRoutingEnabled,
      messaging: runtime.messagingEnabled,
      payments: runtime.paymentEnabled,
      buyerExport: runtime.buyerExportEnabled,
      publicTracking: runtime.publicTrackingEnabled
    },
    safetyDisabledModules: {
      billing: !runtime.billingEnabled,
      externalAds: !runtime.externalAdsEnabled,
      partnerRouting: !runtime.partnerRoutingEnabled,
      messaging: !runtime.messagingEnabled,
      payments: !runtime.paymentEnabled,
      buyerExport: !runtime.buyerExportEnabled,
      publicTracking: !runtime.publicTrackingEnabled
    }
  };
}

function disabledResponse(runtime: GrowthNetworkRuntimeConfig) {
  return successEnvelope(growthNetworkDisabledMessage, serializeGrowthNetworkRuntimeStatus(runtime));
}

function isMerchantSellerAuth(auth: Request["auth"]) {
  if (!auth?.userId || !auth.merchantId) return false;
  if (isCourierRole(auth.role)) return false;
  if (isAdminRole(auth.role)) return false;
  return auth.role === UserRole.SELLER
    || auth.role === UserRole.MERCHANT_OWNER
    || auth.role === UserRole.MERCHANT_STAFF
    || auth.role === UserRole.SELLER_OWNER
    || auth.role === UserRole.SELLER_STAFF;
}

function isPublicTrackingPath(req: Request) {
  const path = `${req.path} ${JSON.stringify(req.params)} ${JSON.stringify(req.body ?? {})}`.toUpperCase();
  return path.includes("TRACKING_PAGE") || path.includes("POST_DELIVERY") || req.path.includes("/tracking-page/");
}

function isBillingPath(req: Request) {
  return req.path.startsWith("/billing-readiness");
}

function isPartnerRoutingPath(req: Request) {
  return req.path.includes("/routing-intents") || req.path.includes("/lead-consents");
}

export function requireGrowthNetworkAudience(
  runtime: GrowthNetworkRuntimeConfig = currentGrowthNetworkRuntime()
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (runtime.audience === "MERCHANT_SELLER_ONLY" && !isMerchantSellerAuth(req.auth)) {
      return res.status(403).json({ error: "GROWTH_NETWORK_MERCHANT_SELLER_ONLY" });
    }

    return next();
  };
}

export function requireGrowthNetworkEnabled(
  runtime: GrowthNetworkRuntimeConfig = currentGrowthNetworkRuntime()
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!runtime.enabled) return res.json(disabledResponse(runtime));
    if (isBillingPath(req) && !runtime.billingEnabled) return res.json(disabledResponse(runtime));
    if (isPartnerRoutingPath(req) && !runtime.partnerRoutingEnabled) return res.json(disabledResponse(runtime));
    if (isPublicTrackingPath(req) && !runtime.publicTrackingEnabled) return res.json(disabledResponse(runtime));
    return next();
  };
}
