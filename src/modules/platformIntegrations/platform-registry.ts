import { StorePlatform } from "@prisma/client";
import type { PlatformOrderMapper } from "./platform-types.js";
import { magentoAdapter } from "./adapters/magento.adapter.js";
import { shopifyAdapter } from "./adapters/shopify.adapter.js";
import { woocommerceAdapter } from "./adapters/woocommerce.adapter.js";

const adapters = new Map<StorePlatform, PlatformOrderMapper>([
  [StorePlatform.SHOPIFY, shopifyAdapter],
  [StorePlatform.WOOCOMMERCE, woocommerceAdapter],
  [StorePlatform.MAGENTO, magentoAdapter]
]);

export function getPlatformAdapter(platform: StorePlatform) {
  return adapters.get(platform) ?? null;
}

export function supportedOrderImportPlatforms() {
  return [...adapters.keys()];
}
