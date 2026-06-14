import type { StorePlatform } from "@prisma/client";

export const PLATFORM_WEBHOOK_REGISTRATION_STATUSES = [
  "DRAFT",
  "READY",
  "REGISTERED",
  "DISABLED",
  "BLOCKED",
  "FAILED"
] as const;

export type PlatformWebhookRegistrationStatus = typeof PLATFORM_WEBHOOK_REGISTRATION_STATUSES[number];

export type PlatformWebhookRegistrationMode = "DRY_RUN" | "LIVE";

export type PlatformWebhookRegistrationRuntime = {
  enabled: boolean;
  mode: PlatformWebhookRegistrationMode;
  pilotOnly: boolean;
  callbackBaseConfigured: boolean;
  callbackBaseUrlSafe: string | null;
};

export type PlatformWebhookRegistrationTopic =
  | "ORDER_CREATED"
  | "ORDER_UPDATED";

export type PlatformWebhookRegistrationTopicSpec = {
  platform: StorePlatform;
  topic: PlatformWebhookRegistrationTopic;
  providerTopic: string;
  callbackPath: string;
};
