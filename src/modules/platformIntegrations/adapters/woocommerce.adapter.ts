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
  parseAmountToPaise,
  parseDate
} from "./adapter-utils.js";

function wooAddress(record: Record<string, unknown>, fallbackName: string): NormalizedPlatformAddress {
  const firstName = asString(record.first_name);
  const lastName = asString(record.last_name);

  return {
    name: firstString(`${firstName} ${lastName}`.trim(), fallbackName) || null,
    phone: firstNullableString(record.phone),
    line1: firstString(record.address_1),
    line2: firstNullableString(record.address_2),
    city: firstString(record.city),
    state: firstString(record.state),
    postalCode: firstString(record.postcode),
    country: normalizeCountry(record.country)
  };
}

function metaValue(record: Record<string, unknown>, keys: string[]) {
  const meta = asArray(record.meta_data);
  for (const raw of meta) {
    const item = asRecord(raw);
    const key = asString(item.key).toLowerCase();
    if (keys.includes(key)) return item.value;
  }
  return null;
}

function wooItemWeightGrams(item: Record<string, unknown>) {
  const direct = intOrNull(item.weight_grams ?? item.grams);
  if (direct && direct > 0) return direct;

  const metaWeight = intOrNull(metaValue(item, ["weight_grams", "_weight_grams", "grams"]));
  if (metaWeight && metaWeight > 0) return metaWeight;

  const kgWeight = Number(asString(item.weight || metaValue(item, ["weight", "_weight"])));
  return Number.isFinite(kgWeight) && kgWeight > 0 ? Math.round(kgWeight * 1000) : null;
}

function mapLineItems(lineItems: unknown[], warnings: NormalizedPlatformOrder["mappingWarnings"]): NormalizedPlatformItem[] {
  return lineItems.map((raw, index) => {
    const item = asRecord(raw);
    const quantity = Math.max(1, intOrNull(item.quantity) ?? 1);
    const weightGrams = wooItemWeightGrams(item);
    if (!weightGrams) {
      addWarning(warnings, "MISSING_ITEM_WEIGHT", `line_items.${index}.weight`, "WooCommerce line item is missing product weight.");
    }

    return {
      sku: firstNullableString(item.sku),
      name: firstString(item.name, "WooCommerce item"),
      quantity,
      unitPricePaise: parseAmountToPaise(Number(asString(item.total)) / quantity || item.price),
      weightGrams,
      requiresShipping: item.requires_shipping !== false
    };
  });
}

function isCodOrder(order: Record<string, unknown>) {
  const method = `${asString(order.payment_method)} ${asString(order.payment_method_title)}`.toLowerCase();
  return method === "cod" || /\bcod\b|cash on delivery/.test(method);
}

export const woocommerceAdapter: PlatformOrderMapper = {
  platform: StorePlatform.WOOCOMMERCE,
  mapOrder(payload, options = {}) {
    const order = asRecord(payload);
    const billingRecord = asRecord(order.billing);
    const shippingRecord = asRecord(order.shipping);
    const warnings: NormalizedPlatformOrder["mappingWarnings"] = [];
    const buyerName = firstString(
      `${asString(shippingRecord.first_name)} ${asString(shippingRecord.last_name)}`.trim(),
      `${asString(billingRecord.first_name)} ${asString(billingRecord.last_name)}`.trim(),
      "WooCommerce buyer"
    );
    const shippingAddress = wooAddress(Object.keys(shippingRecord).length ? shippingRecord : billingRecord, buyerName);
    const billingAddress = Object.keys(billingRecord).length ? wooAddress(billingRecord, buyerName) : null;
    const items = mapLineItems(asArray(order.line_items), warnings);
    const orderAmountPaise = parseAmountToPaise(order.total);
    const paymentMode = isCodOrder(order) ? "COD" : "PREPAID";
    const shippableWeights = items
      .filter((item) => item.requiresShipping)
      .map((item) => (item.weightGrams ?? 0) * item.quantity)
      .filter((weight) => weight > 0);

    if (!shippingAddress.phone && !asString(billingRecord.phone)) {
      addWarning(warnings, "MISSING_PHONE", "billing.phone", "WooCommerce order is missing a buyer phone.");
    }
    if (!shippingAddress.postalCode) {
      addWarning(warnings, "MISSING_POSTAL_CODE", "shipping.postcode", "WooCommerce shipping address is missing a postal code.");
    }
    if (!shippingAddress.line1) {
      addWarning(warnings, "MISSING_SHIPPING_ADDRESS", "shipping.address_1", "WooCommerce order is missing shipping address line 1.");
    }
    if (!items.length) {
      addWarning(warnings, "MISSING_ITEMS", "line_items", "WooCommerce order has no line items.");
    }

    return {
      platform: StorePlatform.WOOCOMMERCE,
      externalOrderId: firstString(order.id),
      externalOrderName: firstNullableString(order.number),
      orderCreatedAt: parseDate(order.date_created),
      buyerName,
      buyerEmail: firstNullableString(order.billing_email, billingRecord.email),
      buyerPhone: firstNullableString(shippingAddress.phone, billingRecord.phone),
      shippingAddress,
      billingAddress,
      paymentMode,
      currency: firstString(order.currency, "INR"),
      orderAmountPaise,
      codAmountPaise: paymentMode === "COD" ? orderAmountPaise : 0,
      items,
      deadWeightGrams: shippableWeights.length ? shippableWeights.reduce((sum, weight) => sum + weight, 0) : null,
      dimensions: null,
      tags: [],
      notes: asNullableString(order.customer_note),
      pickupLocationId: options.pickupLocationId ?? null,
      rawSourceSummary: {
        platform: "WOOCOMMERCE",
        external_order_id: firstString(order.id),
        external_order_name: firstString(order.number),
        payment_mode: paymentMode,
        item_count: items.length
      },
      mappingWarnings: warnings
    };
  }
};
