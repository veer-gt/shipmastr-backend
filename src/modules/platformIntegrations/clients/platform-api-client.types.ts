import type { PlatformHealthCheckStatus, StorePlatform } from "@prisma/client";

export type PlatformApiClientContext = {
  platform: StorePlatform;
  connectionId: string;
  storeUrl: string;
  storeName?: string | null;
  safeMetadata?: Record<string, unknown> | null;
  credentialType?: string | null;
  credentialSecret?: unknown;
  realReadsEnabled: boolean;
};

export type PlatformApiClientCheckResult = {
  status: PlatformHealthCheckStatus;
  message: string;
  safeDetails?: Record<string, unknown>;
  errorCode?: string | null;
};

export type PlatformApiClient = {
  getPlatformIdentity(context: PlatformApiClientContext): Promise<PlatformApiClientCheckResult>;
  checkAuthentication(context: PlatformApiClientContext): Promise<PlatformApiClientCheckResult>;
  checkReadPermissions(context: PlatformApiClientContext): Promise<PlatformApiClientCheckResult>;
  checkWebhookCapability(context: PlatformApiClientContext): Promise<PlatformApiClientCheckResult>;
  checkFulfillmentOrTrackingCapability(context: PlatformApiClientContext): Promise<PlatformApiClientCheckResult>;
};

export type PlatformHealthStep = PlatformApiClientCheckResult & {
  code: string;
  label: string;
};
