import { PlatformHealthCheckStatus } from "@prisma/client";
import type { PlatformApiClient, PlatformApiClientContext } from "./platform-api-client.types.js";

function baseUrl(context: PlatformApiClientContext) {
  return String(context.safeMetadata?.base_url || context.storeUrl || "");
}

function mockDetails(context: PlatformApiClientContext) {
  return {
    mockMode: !context.realReadsEnabled,
    platform: "CUSTOM",
    baseUrl: baseUrl(context),
    headerName: context.safeMetadata?.header_name || null,
    credentialType: context.credentialType || "metadata_only",
    readOnly: true
  };
}

export function createCustomApiPlatformClient(): PlatformApiClient {
  return {
    async getPlatformIdentity(context) {
      return {
        status: PlatformHealthCheckStatus.HEALTHY,
        message: "Custom API base URL is ready for foundation health checks.",
        safeDetails: mockDetails(context)
      };
    },

    async checkAuthentication(context) {
      return {
        status: context.credentialSecret ? PlatformHealthCheckStatus.HEALTHY : PlatformHealthCheckStatus.DEGRADED,
        message: context.credentialSecret ? "Custom API key is available to the internal read client." : "Custom API connection is metadata-only until a credential is attached.",
        safeDetails: mockDetails(context)
      };
    },

    async checkReadPermissions(context) {
      return {
        status: PlatformHealthCheckStatus.DEGRADED,
        message: "Custom API read permission check is a placeholder until an allowlisted health endpoint is configured.",
        safeDetails: { ...mockDetails(context), capability: "read_placeholder" }
      };
    },

    async checkWebhookCapability(context) {
      return {
        status: PlatformHealthCheckStatus.DEGRADED,
        message: "Custom API webhook capability depends on future merchant configuration.",
        safeDetails: { ...mockDetails(context), capability: "webhooks", configured: false }
      };
    },

    async checkFulfillmentOrTrackingCapability(context) {
      return {
        status: PlatformHealthCheckStatus.DEGRADED,
        message: "Custom API tracking capability depends on future merchant configuration.",
        safeDetails: { ...mockDetails(context), capability: "tracking_placeholder" }
      };
    }
  };
}
