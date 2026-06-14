import { StorePlatform } from "@prisma/client";
import type {
  NormalizedPlatformAddress,
  NormalizedPlatformItem,
  NormalizedPlatformOrder,
  PlatformOrderMapper
} from "../platform-types.js";
import {
  addWarning,
  asArray,
  asNullableString,
  asRecord,
  asString,
  firstNullableString,
  firstString,
  intOrNull,
  normalizeCountry,
  normalizeTags,
  parseAmountToPaise,
  parseDate
} from "./adapter-utils.js";

function shopifyAddress(record: Record<string, unknown>, fallbackName: string): NormalizedPlatformAddress {
  const firstName = asString(record.first_name);
  const lastName = asString(record.last_name);
  const fullName = firstString(record.name, `${firstName} ${lastName}`.trim(), fallbackName);

  return {
    name: fullName || null,
    phone: firstNullableString(record.phone),
    line1: firstString(record.address1),
    line2: firstNullableString(record.address2),
    city: firstString(record.city),
    state: firstString(record.province, record.province_code),
    postalCode: firstString(record.zip, record.postal_code),
    country: normalizeCountry(firstString(record.country_code, record.country))
  };
}

function mapLineItems(lineItems: unknown[], warnings: NormalizedPlatformOrder["mappingWarnings"]): NormalizedPlatformItem[] {
  return lineItems.map((raw, index) => {
    const item = asRecord(raw);
    const requiresShipping = item.requires_shipping !== false;
    const grams = intOrNull(item.grams);
    if (requiresShipping && (!grams || grams <= 0)) {
      addWarning(warnings, "MISSING_ITEM_WEIGHT", `line_items.${index}.grams`, "Shopify line item is missing grams.");
    }
    if (!requiresShipping) {
      addWarning(warnings, "DIGITAL_NON_SHIPPABLE_ITEM", `line_items.${index}`, "Shopify line item is marked non-shippable.", "info");
    }

    return {
      sku: firstNullableString(item.sku),
      name: firstString(item.name, item.title, "Shopify item"),
      quantity: Math.max(1, intOrNull(item.quantity) ?? 1),
      unitPricePaise: parseAmountToPaise(firstString(item.price, item.pre_tax_price)),
      weightGrams: grams && grams > 0 ? grams : null,
      requiresShipping
    };
  });
}

function isCodOrder(order: Record<string, unknown>, tags: string[]) {
  const gateways = asArray(order.payment_gateway_names).map(asString).join(" ");
  const financialStatus = asString(order.financial_status);
  const text = `${gateways} ${tags.join(" ")}`.toLowerCase();
  return /\bcod\b|cash on delivery/.test(text) || (financialStatus === "pending" && /\bcod\b|cash on delivery/.test(gateways.toLowerCase()));
}

export const shopifyAdapter: PlatformOrderMapper = {
  platform: StorePlatform.SHOPIFY,
  mapOrder(payload, options = {}) {
    const order = asRecord(payload);
    const customer = asRecord(order.customer);
    const shippingRecord = asRecord(order.shipping_address);
    const billingRecord = asRecord(order.billing_address);
    const warnings: NormalizedPlatformOrder["mappingWarnings"] = [];
    const buyerName = firstString(
      shippingRecord.name,
      `${asString(customer.first_name)} ${asString(customer.last_name)}`.trim(),
      customer.name,
      "Shopify buyer"
    );
    const shippingAddress = shopifyAddress(shippingRecord, buyerName);
    const billingAddress = Object.keys(billingRecord).length ? shopifyAddress(billingRecord, buyerName) : null;
    const items = mapLineItems(asArray(order.line_items), warnings);
    const tags = normalizeTags(order.tags);
    const orderAmountPaise = parseAmountToPaise(order.total_price);
    const paymentMode = isCodOrder(order, tags) ? "COD" : "PREPAID";
    const shippableWeights = items
      .filter((item) => item.requiresShipping)
      .map((item) => (item.weightGrams ?? 0) * item.quantity)
      .filter((weight) => weight > 0);

    if (!shippingAddress.phone && !asString(order.phone) && !asString(customer.phone)) {
      addWarning(warnings, "MISSING_PHONE", "shipping_address.phone", "Shopify order is missing a buyer phone.");
    }
    if (!shippingAddress.postalCode) {
      addWarning(warnings, "MISSING_POSTAL_CODE", "shipping_address.zip", "Shopify shipping address is missing a postal code.");
    }
    if (!shippingAddress.line1) {
      addWarning(warnings, "MISSING_ADDRESS_LINE1", "shipping_address.address1", "Shopify shipping address is missing address line 1.");
    }
    if (!items.length) {
      addWarning(warnings, "MISSING_ITEMS", "line_items", "Shopify order has no line items.");
    }
    if (!shippableWeights.length) {
      addWarning(warnings, "MISSING_ITEM_WEIGHT", "line_items.grams", "No shippable Shopify line item has weight.");
    }
    if (asString(order.cancelled_at)) {
      addWarning(warnings, "ORDER_CANCELLED", "cancelled_at", "Shopify order is cancelled.");
    }
    const fulfillmentStatus = asString(order.fulfillment_status).toLowerCase();
    if (fulfillmentStatus === "fulfilled") {
      addWarning(warnings, "ORDER_ALREADY_FULFILLED", "fulfillment_status", "Shopify order is already fulfilled.", "info");
    } else if (fulfillmentStatus === "partial" || fulfillmentStatus === "partially_fulfilled") {
      addWarning(warnings, "ORDER_PARTIALLY_FULFILLED", "fulfillment_status", "Shopify order is partially fulfilled.", "info");
    }
    if (order.test === true) {
      addWarning(warnings, "SHOPIFY_TEST_ORDER", "test", "Shopify order is marked as a test order.", "info");
    }

    return {
      platform: StorePlatform.SHOPIFY,
      externalOrderId: firstString(order.id, order.admin_graphql_api_id, order.order_number),
      externalOrderName: firstNullableString(order.name, order.order_number),
      orderCreatedAt: parseDate(order.created_at),
      buyerName,
      buyerEmail: firstNullableString(order.contact_email, order.email, customer.email),
      buyerPhone: firstNullableString(shippingAddress.phone, order.phone, customer.phone),
      shippingAddress,
      billingAddress,
      paymentMode,
      currency: firstString(order.currency, "INR"),
      orderAmountPaise,
      codAmountPaise: paymentMode === "COD" ? orderAmountPaise : 0,
      items,
      deadWeightGrams: shippableWeights.length ? shippableWeights.reduce((sum, weight) => sum + weight, 0) : null,
      dimensions: null,
      tags,
      notes: asNullableString(order.note),
      pickupLocationId: options.pickupLocationId ?? null,
      rawSourceSummary: {
        platform: "SHOPIFY",
        external_order_id: firstString(order.id, order.admin_graphql_api_id, order.order_number),
        external_order_name: firstString(order.name, order.order_number),
        payment_mode: paymentMode,
        item_count: items.length
      },
      mappingWarnings: warnings
    };
  }
};
