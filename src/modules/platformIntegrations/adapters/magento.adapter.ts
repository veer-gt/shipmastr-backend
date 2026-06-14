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

function magentoAddress(record: Record<string, unknown>, fallbackName: string): NormalizedPlatformAddress {
  const street = asArray(record.street).map(asString).filter(Boolean);
  const firstName = asString(record.firstname);
  const lastName = asString(record.lastname);

  return {
    name: firstString(`${firstName} ${lastName}`.trim(), fallbackName) || null,
    phone: firstNullableString(record.telephone, record.phone),
    line1: firstString(street[0], record.street),
    line2: firstNullableString(street.slice(1).join(", ")),
    city: firstString(record.city),
    state: firstString(record.region, record.region_code),
    postalCode: firstString(record.postcode, record.postal_code),
    country: normalizeCountry(record.country_id)
  };
}

function firstShippingAssignment(order: Record<string, unknown>) {
  const extension = asRecord(order.extension_attributes);
  return asRecord(asArray(extension.shipping_assignments)[0]);
}

function magentoItemWeightGrams(item: Record<string, unknown>) {
  const weight = Number(asString(item.weight));
  if (!Number.isFinite(weight) || weight <= 0) return null;
  return weight > 100 ? Math.round(weight) : Math.round(weight * 1000);
}

function mapLineItems(lineItems: unknown[], warnings: NormalizedPlatformOrder["mappingWarnings"]): NormalizedPlatformItem[] {
  return lineItems
    .map((raw, index) => {
      const item = asRecord(raw);
      const quantity = Math.max(1, intOrNull(item.qty_ordered ?? item.qty) ?? 1);
      const weightGrams = magentoItemWeightGrams(item);
      const requiresShipping = item.is_virtual !== 1 && item.product_type !== "virtual" && item.product_type !== "downloadable";
      if (!weightGrams) {
        addWarning(warnings, "MISSING_ITEM_WEIGHT", `items.${index}.weight`, "Magento item is missing product weight.");
      }
      if (!requiresShipping) {
        addWarning(warnings, "VIRTUAL_NON_SHIPPABLE_ITEM", `items.${index}`, "Magento item is virtual, downloadable, or non-shippable.", "info");
      }

      return {
        sku: firstNullableString(item.sku),
        name: firstString(item.name, "Magento item"),
        quantity,
        unitPricePaise: parseAmountToPaise(firstString(item.price, item.base_price)),
        weightGrams,
        requiresShipping
      };
    })
    .filter((item) => item.quantity > 0);
}

function isCodOrder(order: Record<string, unknown>) {
  const payment = asRecord(order.payment);
  const method = asString(payment.method).toLowerCase();
  return method === "cashondelivery" || method === "cod";
}

export const magentoAdapter: PlatformOrderMapper = {
  platform: StorePlatform.MAGENTO,
  mapOrder(payload, options = {}) {
    const order = asRecord(payload);
    const shippingAssignment = firstShippingAssignment(order);
    const shipping = asRecord(asRecord(shippingAssignment.shipping).address);
    const billing = asRecord(order.billing_address);
    const assignmentItems = asArray(shippingAssignment.items);
    const warnings: NormalizedPlatformOrder["mappingWarnings"] = [];
    const buyerName = firstString(
      `${asString(shipping.firstname)} ${asString(shipping.lastname)}`.trim(),
      `${asString(billing.firstname)} ${asString(billing.lastname)}`.trim(),
      "Magento buyer"
    );
    const shippingAddress = magentoAddress(Object.keys(shipping).length ? shipping : billing, buyerName);
    const billingAddress = Object.keys(billing).length ? magentoAddress(billing, buyerName) : null;
    const items = mapLineItems(assignmentItems.length ? assignmentItems : asArray(order.items), warnings);
    const orderAmountPaise = parseAmountToPaise(order.grand_total);
    const paymentMode = isCodOrder(order) ? "COD" : "PREPAID";
    const shippableWeights = items
      .filter((item) => item.requiresShipping)
      .map((item) => (item.weightGrams ?? 0) * item.quantity)
      .filter((weight) => weight > 0);

    if (!Object.keys(shippingAssignment).length || !Object.keys(shipping).length) {
      addWarning(warnings, "MISSING_SHIPPING_ASSIGNMENT", "extension_attributes.shipping_assignments", "Magento order is missing a shipping assignment.");
    }
    if (!shippingAddress.phone) {
      addWarning(warnings, "MISSING_PHONE", "shipping.telephone", "Magento order is missing a buyer phone.");
    }
    if (!shippingAddress.postalCode) {
      addWarning(warnings, "MISSING_POSTAL_CODE", "shipping.postcode", "Magento shipping address is missing a postal code.");
    }
    if (!shippingAddress.line1) {
      addWarning(warnings, "MISSING_SHIPPING_ADDRESS", "shipping.street", "Magento order is missing shipping street.");
    }
    if (!items.length) {
      addWarning(warnings, "MISSING_ITEMS", "items", "Magento order has no shippable items.");
    }
    if (items.length && !items.some((item) => item.requiresShipping)) {
      addWarning(warnings, "NO_SHIPPABLE_ITEMS", "items", "Magento order contains only virtual or non-shippable items.");
    }
    if (["canceled", "cancelled", "closed"].includes(asString(order.status).toLowerCase())) {
      addWarning(warnings, "ORDER_CANCELLED_OR_CLOSED", "status", "Magento order is cancelled or closed.");
    }
    if (!firstNullableString(order.store_name, order.store_code, order.store_id)) {
      addWarning(warnings, "STORE_VIEW_UNMAPPED", "store", "Magento store view could not be mapped.", "info");
    }

    return {
      platform: StorePlatform.MAGENTO,
      externalOrderId: firstString(order.entity_id),
      externalOrderName: firstNullableString(order.increment_id),
      orderCreatedAt: parseDate(order.created_at),
      buyerName,
      buyerEmail: firstNullableString(order.customer_email, billing.email),
      buyerPhone: firstNullableString(shippingAddress.phone, billing.telephone),
      shippingAddress,
      billingAddress,
      paymentMode,
      currency: firstString(order.order_currency_code, "INR"),
      orderAmountPaise,
      codAmountPaise: paymentMode === "COD" ? orderAmountPaise : 0,
      items,
      deadWeightGrams: shippableWeights.length ? shippableWeights.reduce((sum, weight) => sum + weight, 0) : null,
      dimensions: null,
      tags: [firstString(order.status)].filter(Boolean),
      notes: asNullableString(order.customer_note),
      pickupLocationId: options.pickupLocationId ?? null,
      rawSourceSummary: {
        platform: "MAGENTO",
        external_order_id: firstString(order.entity_id),
        external_order_name: firstString(order.increment_id),
        payment_mode: paymentMode,
        item_count: items.length
      },
      mappingWarnings: warnings
    };
  }
};
