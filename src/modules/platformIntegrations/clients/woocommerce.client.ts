import { PlatformHealthCheckStatus } from "@prisma/client";
import type { PlatformApiClient, PlatformApiClientContext } from "./platform-api-client.types.js";

function siteUrl(context: PlatformApiClientContext) {
  return String(context.safeMetadata?.site_url || context.storeUrl || "");
}

function mockDetails(context: PlatformApiClientContext) {
  return {
    mockMode: !context.realReadsEnabled,
    platform: "WOOCOMMERCE",
    siteUrl: siteUrl(context),
    credentialType: context.credentialType,
    readOnly: true
  };
}

export function createWooCommercePlatformClient(): PlatformApiClient {
  return {
    async getPlatformIdentity(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "WooCommerce site identity is ready for read-only checks.",
        safeDetails: mockDetails(context)
      };
    },

    async checkAuthentication(context) {
      return {
        status: context.credentialSecret ? PlatformHealthCheckStatus.HEALTHY : PlatformHealthCheckStatus.NOT_CONFIGURED,
        message: context.credentialSecret ? "WooCommerce REST credential is available to the internal read client." : "WooCommerce credential is missing.",
        safeDetails: mockDetails(context),
        errorCode: context.credentialSecret ? null : "PLATFORM_HEALTH_CREDENTIAL_MISSING"
      };
    },

    async checkReadPermissions(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "WooCommerce order read permission check is simulated and ready.",
        safeDetails: { ...mockDetails(context), scope: "orders_read" }
      };
    },

    async checkWebhookCapability(context) {
      return {
        status: PlatformHealthCheckStatus.DEGRADED,
        message: "WooCommerce webhook registration remains a later foundation phase.",
        safeDetails: { ...mockDetails(context), capability: "webhooks", configured: false }
      };
    },

    async checkFulfillmentOrTrackingCapability(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "WooCommerce tracking read capability is ready for future simulation.",
        safeDetails: { ...mockDetails(context), capability: "tracking_read" }
      };
    }
  };
}
