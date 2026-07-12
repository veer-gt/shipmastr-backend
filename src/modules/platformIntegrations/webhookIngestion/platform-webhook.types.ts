import type { StorePlatform } from "@prisma/client";

export type PlatformWebhookStatus =
  | "RECEIVED"
  | "VERIFIED"
  | "REJECTED"
  | "DUPLICATE"
  | "STAGED_FOR_IMPORT"
  | "FAILED"
  | "IGNORED";

export type PlatformWebhookTopic =
  | "SHOPIFY_ORDER_CREATED"
  | "SHOPIFY_ORDER_UPDATED"
  | "WOOCOMMERCE_ORDER_CREATED"
  | "WOOCOMMERCE_ORDER_UPDATED"
  | "MAGENTO_ORDER_CREATED"
  | "MAGENTO_ORDER_UPDATED"
  | "UNKNOWN";

export type PlatformWebhookIngestionInput = {
  platform: Extract<StorePlatform, "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO">;
  connectionId: string;
  headers: Record<string, unknown>;
  payload: unknown;
  rawBody?: Buffer;
};

export type PlatformWebhookVerifierOptions = {
  signatureSecret?: string;
};
