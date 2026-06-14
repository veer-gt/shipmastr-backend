import { StorePlatform } from "@prisma/client";
import { env } from "../../../config/env.js";
import type {
  PlatformWebhookRegistrationMode,
  PlatformWebhookRegistrationRuntime,
  PlatformWebhookRegistrationTopic,
  PlatformWebhookRegistrationTopicSpec
} from "./platform-webhook-registration.types.js";

type Source = Record<string, unknown>;

function boolValue(source: Source, key: string, fallback: boolean) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: Source, key: string) {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function modeValue(source: Source): PlatformWebhookRegistrationMode {
  return stringValue(source, "SHIPMASTR_WEBHOOK_REGISTRATION_MODE").toUpperCase() === "LIVE" ? "LIVE" : "DRY_RUN";
}

export function getPlatformWebhookRegistrationRuntime(
  source: Source = env
): PlatformWebhookRegistrationRuntime {
  const callbackBase = stringValue(source, "PUBLIC_WEBHOOK_BASE_URL").replace(/\/+$/, "");
  return {
    enabled: boolValue(source, "SHIPMASTR_WEBHOOK_REGISTRATION_ENABLED", false)
      || boolValue(source, "PLATFORM_WEBHOOK_REGISTRATION_ENABLED", false),
    mode: modeValue(source),
    pilotOnly: boolValue(source, "SHIPMASTR_WEBHOOK_REGISTRATION_PILOT_ONLY", true),
    callbackBaseConfigured: Boolean(callbackBase),
    callbackBaseUrlSafe: callbackBase || null
  };
}

export function topicSpecsForPlatform(platform: StorePlatform): PlatformWebhookRegistrationTopicSpec[] {
  if (platform === StorePlatform.SHOPIFY) {
    return [
      { platform, topic: "ORDER_CREATED", providerTopic: "orders/create", callbackPath: "/shipping/platform-webhooks/shopify" },
      { platform, topic: "ORDER_UPDATED", providerTopic: "orders/update", callbackPath: "/shipping/platform-webhooks/shopify" }
    ];
  }
  if (platform === StorePlatform.WOOCOMMERCE) {
    return [
      { platform, topic: "ORDER_CREATED", providerTopic: "order.created", callbackPath: "/shipping/platform-webhooks/woocommerce" },
      { platform, topic: "ORDER_UPDATED", providerTopic: "order.updated", callbackPath: "/shipping/platform-webhooks/woocommerce" }
    ];
  }
  if (platform === StorePlatform.MAGENTO) {
    return [
      { platform, topic: "ORDER_CREATED", providerTopic: "sales_order_place_after", callbackPath: "/shipping/platform-webhooks/magento" },
      { platform, topic: "ORDER_UPDATED", providerTopic: "sales_order_save_after", callbackPath: "/shipping/platform-webhooks/magento" }
    ];
  }
  return [];
}

export function resolveTopicSpecs(
  platform: StorePlatform,
  topics: PlatformWebhookRegistrationTopic[] | undefined
) {
  const specs = topicSpecsForPlatform(platform);
  if (!topics?.length) return specs;
  const requested = new Set(topics);
  return specs.filter((spec) => requested.has(spec.topic));
}

export function buildCallbackUrl(runtime: PlatformWebhookRegistrationRuntime, spec: PlatformWebhookRegistrationTopicSpec, connectionId: string) {
  if (!runtime.callbackBaseUrlSafe) return null;
  return `${runtime.callbackBaseUrlSafe}${spec.callbackPath}/${encodeURIComponent(connectionId)}`;
}
