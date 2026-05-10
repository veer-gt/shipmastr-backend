import type {
  CarrierAdapter,
  CarrierCancelRequest,
  CarrierCancelResult,
  CarrierQuoteRequest,
  CarrierQuoteResult,
  CarrierShipmentRequest,
  CarrierShipmentResult,
  CarrierTrackRequest,
  CarrierTrackResult,
  CarrierTrackingStatus,
  CarrierWebhookContext,
  NormalizedCarrierWebhook
} from "./carrier-adapter.types.js";

const MANUAL_ADAPTER_NAME = "manual-courier";
const MOCK_ADAPTER_NAME = "mock-qa-courier";

function recordFromPayload(payload: unknown) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  throw new Error("CARRIER_WEBHOOK_PAYLOAD_MUST_BE_OBJECT");
}

function stringValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return undefined;
}

function numberValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }

  return undefined;
}

function isoDate(value: Date | undefined) {
  return (value ?? new Date()).toISOString();
}

function normalizeTrackingStatus(value: string | undefined): CarrierTrackingStatus {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");

  if (normalized.includes("delivered") && normalized.includes("rto")) return "rto_delivered";
  if (normalized.includes("delivered")) return "delivered";
  if (normalized.includes("out_for_delivery") || normalized.includes("ofd")) return "out_for_delivery";
  if (normalized.includes("picked_up") || normalized.includes("pickup_done")) return "picked_up";
  if (normalized.includes("pickup")) return "pickup_scheduled";
  if (normalized.includes("ndr")) return "ndr";
  if (normalized.includes("rto")) return "rto_initiated";
  if (normalized.includes("lost")) return "lost";
  if (normalized.includes("damage")) return "damaged";
  if (normalized.includes("cancel")) return "cancelled";
  return "in_transit";
}

function eventTypeForStatus(status: CarrierTrackingStatus) {
  if (status === "delivered") return "shipment.delivered";
  if (status === "ndr") return "shipment.ndr";
  if (status === "rto_initiated" || status === "rto_delivered") return "shipment.rto";
  if (status === "cancelled" || status === "lost" || status === "damaged") return "shipment.cancelled";
  if (status === "picked_up" || status === "pickup_scheduled") return "shipment.shipped";
  return "shipment.in_transit";
}

function genericWebhookFromPayload(
  payload: unknown,
  context: CarrierWebhookContext = {}
): NormalizedCarrierWebhook {
  const record = recordFromPayload(payload);
  const status = normalizeTrackingStatus(stringValue(record, ["status", "shipmentStatus", "eventType", "latestEvent"]));
  const eventType = stringValue(record, ["eventType", "event", "type"]) ?? eventTypeForStatus(status);
  const externalId = stringValue(record, ["externalId", "eventId", "webhookId", "awbNumber", "awb", "trackingNumber"]);

  if (!externalId) {
    throw new Error("CARRIER_WEBHOOK_EXTERNAL_ID_REQUIRED");
  }

  const normalized: NormalizedCarrierWebhook = {
    externalId,
    eventType,
    status,
    receivedAt: isoDate(context.receivedAt),
    rawPayload: record
  };

  const merchantId = stringValue(record, ["merchantId"]);
  const orderId = stringValue(record, ["orderId"]);
  const externalOrderId = stringValue(record, ["externalOrderId"]);
  const awbNumber = stringValue(record, ["awbNumber", "awb"]);
  const trackingNumber = stringValue(record, ["trackingNumber"]);
  const courierId = stringValue(record, ["courierId"]);
  const courierCode = stringValue(record, ["courierCode", "carrier", "carrierCode"]);
  const latestEvent = stringValue(record, ["latestEvent", "remarks", "message"]);
  const description = stringValue(record, ["description", "remarks", "message"]);
  const location = stringValue(record, ["location", "city", "hub"]);

  if (merchantId) normalized.merchantId = merchantId;
  if (orderId) normalized.orderId = orderId;
  if (externalOrderId) normalized.externalOrderId = externalOrderId;
  if (awbNumber) normalized.awbNumber = awbNumber;
  if (trackingNumber) normalized.trackingNumber = trackingNumber;
  if (courierId) normalized.courierId = courierId;
  if (courierCode) normalized.courierCode = courierCode;
  if (latestEvent) normalized.latestEvent = latestEvent;
  if (description) normalized.description = description;
  if (location) normalized.location = location;

  return normalized;
}

function manualQuote(request: CarrierQuoteRequest): CarrierQuoteResult {
  return {
    adapter: MANUAL_ADAPTER_NAME,
    mode: "manual",
    serviceable: false,
    manualFallback: true,
    manualFallbackStatus: "MANUAL_QUOTE_REQUIRED",
    amount: null,
    etaDays: null,
    message: "Manual courier mode active. Quote must be verified by ops before sharing.",
    metadata: {
      pickupPincode: request.pickupPincode,
      deliveryPincode: request.deliveryPincode,
      weightGrams: request.weightGrams,
      paymentMode: request.paymentMode,
      courierPreference: request.courierPreference ?? null
    }
  };
}

function manualShipmentResult(request: CarrierShipmentRequest): CarrierShipmentResult {
  return {
    adapter: MANUAL_ADAPTER_NAME,
    mode: "manual",
    status: "READY_TO_BOOK",
    manualFallback: true,
    manualFallbackStatus: "MANUAL_BOOKING_REQUIRED",
    awb: null,
    trackingNumber: null,
    carrierReference: null,
    labelUrl: null,
    message: "Manual courier mode active. Ops must book with the courier and enter AWB/tracking manually.",
    metadata: {
      orderId: request.orderId ?? null,
      pickupPincode: request.pickupPincode,
      deliveryPincode: request.deliveryPincode,
      paymentMode: request.paymentMode,
      codAmountPaise: request.codAmountPaise ?? 0,
      courierPreference: request.courierPreference ?? null
    }
  };
}

function mockAwb(request: CarrierShipmentRequest) {
  const basis = String(request.orderId || request.merchantId || "QA")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 12) || "QA";

  return `QA-MOCK-AWB-${basis}`;
}

export const manualCarrierAdapter: CarrierAdapter = {
  name: MANUAL_ADAPTER_NAME,
  mode: "manual",
  supportsLiveBooking: false,
  quote: async (request) => manualQuote(request),
  createShipment: async (request) => manualShipmentResult(request),
  cancelShipment: async (request: CarrierCancelRequest): Promise<CarrierCancelResult> => ({
    adapter: MANUAL_ADAPTER_NAME,
    mode: "manual",
    cancelled: false,
    manualFallback: true,
    manualFallbackStatus: "MANUAL_CANCEL_REQUIRED",
    message: "Manual courier mode active. Ops must cancel with the courier manually.",
    metadata: {
      awb: request.awb ?? null,
      trackingNumber: request.trackingNumber ?? null,
      carrierReference: request.carrierReference ?? null,
      reason: request.reason ?? null
    }
  }),
  trackShipment: async (request: CarrierTrackRequest): Promise<CarrierTrackResult> => ({
    adapter: MANUAL_ADAPTER_NAME,
    mode: "manual",
    found: false,
    manualFallback: true,
    manualFallbackStatus: "MANUAL_TRACKING_REQUIRED",
    awb: request.awb ?? null,
    trackingNumber: request.trackingNumber ?? null,
    status: null,
    latestEvent: null,
    events: [],
    message: "Manual courier mode active. Tracking must be checked in the courier dashboard and updated manually.",
    metadata: {
      orderId: request.orderId ?? null
    }
  }),
  parseWebhook: async (payload, context) => genericWebhookFromPayload(payload, context)
};

export const mockQaCarrierAdapter: CarrierAdapter = {
  ...manualCarrierAdapter,
  name: MOCK_ADAPTER_NAME,
  mode: "mock",
  quote: async (request): Promise<CarrierQuoteResult> => ({
    ...manualQuote(request),
    adapter: MOCK_ADAPTER_NAME,
    mode: "mock",
    serviceable: true,
    amount: {
      currency: "INR",
      valuePaise: 0
    },
    etaDays: 5,
    message: "QA mock quote only. Do not show as a real courier quote."
  }),
  createShipment: async (request): Promise<CarrierShipmentResult> => {
    const awb = mockAwb(request);
    return {
      ...manualShipmentResult(request),
      adapter: MOCK_ADAPTER_NAME,
      mode: "mock",
      status: "BOOKED_MANUALLY",
      awb,
      trackingNumber: awb,
      carrierReference: `QA-MOCK-REF-${awb.slice(-12)}`,
      message: "QA mock booking only. No real courier API was called.",
      metadata: {
        orderId: request.orderId ?? null,
        mockOnly: true,
        weightGrams: request.weightGrams,
        paymentMode: request.paymentMode,
        codAmountPaise: request.codAmountPaise ?? 0
      }
    };
  },
  trackShipment: async (request): Promise<CarrierTrackResult> => {
    const now = new Date("2026-05-09T00:00:00.000Z");
    const awb = request.awb ?? request.trackingNumber ?? "QA-MOCK-AWB";
    return {
      adapter: MOCK_ADAPTER_NAME,
      mode: "mock",
      found: true,
      manualFallback: true,
      manualFallbackStatus: "MANUAL_TRACKING_REQUIRED",
      awb,
      trackingNumber: request.trackingNumber ?? awb,
      status: "in_transit",
      latestEvent: "QA mock tracking update",
      events: [{
        status: "in_transit",
        eventType: "shipment.in_transit",
        location: "QA hub",
        description: "QA mock tracking update",
        timestamp: now
      }],
      message: "QA mock tracking only. No real courier API was called.",
      metadata: {
        orderId: request.orderId ?? null,
        mockOnly: true
      }
    };
  }
};

export const carrierAdapterTestHelpers = {
  normalizeTrackingStatus,
  numberValue
};
