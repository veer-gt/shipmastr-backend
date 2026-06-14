import { PlatformHealthCheckStatus } from "@prisma/client";
import type { PlatformApiClient, PlatformApiClientContext } from "./platform-api-client.types.js";

function baseUrl(context: PlatformApiClientContext) {
  return String(context.safeMetadata?.base_url || context.storeUrl || "");
}

function mockDetails(context: PlatformApiClientContext) {
  return {
    mockMode: !context.realReadsEnabled,
    platform: "MAGENTO",
    baseUrl: baseUrl(context),
    storeViewCode: context.safeMetadata?.store_view_code || null,
    credentialType: context.credentialType,
    readOnly: true
  };
}

export function createMagentoPlatformClient(): PlatformApiClient {
  return {
    async getPlatformIdentity(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "Magento / Adobe Commerce store identity is ready for read-only checks.",
        safeDetails: mockDetails(context)
      };
    },

    async checkAuthentication(context) {
      return {
        status: context.credentialSecret ? PlatformHealthCheckStatus.HEALTHY : PlatformHealthCheckStatus.NOT_CONFIGURED,
        message: context.credentialSecret ? "Magento credential is available to the internal read client." : "Magento credential is missing.",
        safeDetails: mockDetails(context),
        errorCode: context.credentialSecret ? null : "PLATFORM_HEALTH_CREDENTIAL_MISSING"
      };
    },

    async checkReadPermissions(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "Magento order read permission check is simulated and ready.",
        safeDetails: { ...mockDetails(context), scope: "orders_read" }
      };
    },

    async checkWebhookCapability(context) {
      return {
        status: PlatformHealthCheckStatus.DEGRADED,
        message: "Magento webhook/event registration remains a later foundation phase.",
        safeDetails: { ...mockDetails(context), capability: "webhooks", configured: false }
      };
    },

    async checkFulfillmentOrTrackingCapability(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "Magento shipment read capability is ready for future simulation.",
        safeDetails: { ...mockDetails(context), capability: "shipment_read" }
      };
    }
  };
}
