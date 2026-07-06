export function checkoutTelemetrySessionIdForOrder(orderId: string) {
  return `checkout-order:${orderId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function checkoutTelemetryContactFromCustomer(value: unknown) {
  const customer = asRecord(value);
  return {
    email: optionalString(customer?.email),
    phone: optionalString(customer?.phone)
  };
}

export function checkoutTelemetryCartSize(value: unknown) {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const item of value) {
    const record = asRecord(item);
    const quantity = record?.quantity;
    if (typeof quantity === "number" && globalThis.Number.isSafeInteger(quantity) && quantity > 0) {
      total += quantity;
    } else {
      total += 1;
    }
  }
  return total;
}

export function checkoutTelemetryPaymentMethod(payment: { purpose?: string | null | undefined }) {
  return payment.purpose === "advance" ? "partial_cod_advance" : "prepaid";
}

export function checkoutTelemetryGateway(payment: { gateway?: string | null | undefined }) {
  return optionalString(payment.gateway);
}
