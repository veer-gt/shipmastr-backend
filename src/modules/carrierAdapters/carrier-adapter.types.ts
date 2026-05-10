export type CarrierAdapterMode = "manual" | "mock";

export type CarrierTrackingStatus =
  | "pickup_scheduled"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "ndr"
  | "rto_initiated"
  | "rto_delivered"
  | "lost"
  | "damaged"
  | "cancelled";

export type CarrierManualFallbackStatus =
  | "MANUAL_QUOTE_REQUIRED"
  | "MANUAL_BOOKING_REQUIRED"
  | "MANUAL_CANCEL_REQUIRED"
  | "MANUAL_TRACKING_REQUIRED";

export type CarrierMoney = {
  currency: "INR";
  valuePaise: number;
};

export type CarrierQuoteRequest = {
  merchantId?: string;
  orderId?: string;
  pickupPincode: string;
  deliveryPincode: string;
  weightGrams: number;
  paymentMode: "PREPAID" | "COD";
  codAmountPaise?: number;
  courierPreference?: string | null;
};

export type CarrierQuoteResult = {
  adapter: string;
  mode: CarrierAdapterMode;
  serviceable: boolean;
  manualFallback: boolean;
  manualFallbackStatus: CarrierManualFallbackStatus;
  amount: CarrierMoney | null;
  etaDays: number | null;
  message: string;
  metadata: Record<string, unknown>;
};

export type CarrierShipmentRequest = CarrierQuoteRequest & {
  buyerName?: string | null;
  buyerPhone?: string | null;
  buyerAddress?: string | null;
  packageDescription?: string | null;
  requestedAt?: Date;
};

export type CarrierShipmentResult = {
  adapter: string;
  mode: CarrierAdapterMode;
  status: "READY_TO_BOOK" | "BOOKED_MANUALLY" | "AWB_ADDED";
  manualFallback: boolean;
  manualFallbackStatus: CarrierManualFallbackStatus;
  awb: string | null;
  trackingNumber: string | null;
  carrierReference: string | null;
  labelUrl: string | null;
  message: string;
  metadata: Record<string, unknown>;
};

export type CarrierCancelRequest = {
  awb?: string | null;
  trackingNumber?: string | null;
  carrierReference?: string | null;
  reason?: string | null;
};

export type CarrierCancelResult = {
  adapter: string;
  mode: CarrierAdapterMode;
  cancelled: boolean;
  manualFallback: boolean;
  manualFallbackStatus: CarrierManualFallbackStatus;
  message: string;
  metadata: Record<string, unknown>;
};

export type CarrierTrackRequest = {
  awb?: string | null;
  trackingNumber?: string | null;
  orderId?: string | null;
};

export type CarrierTrackingEvent = {
  status: CarrierTrackingStatus;
  eventType: string;
  location: string | null;
  description: string;
  timestamp: Date;
};

export type CarrierTrackResult = {
  adapter: string;
  mode: CarrierAdapterMode;
  found: boolean;
  manualFallback: boolean;
  manualFallbackStatus: CarrierManualFallbackStatus;
  awb: string | null;
  trackingNumber: string | null;
  status: CarrierTrackingStatus | null;
  latestEvent: string | null;
  events: CarrierTrackingEvent[];
  message: string;
  metadata: Record<string, unknown>;
};

export type CarrierWebhookContext = {
  headers?: Record<string, string | undefined>;
  receivedAt?: Date;
};

export type NormalizedCarrierWebhook = {
  externalId: string;
  eventType: string;
  status: CarrierTrackingStatus;
  merchantId?: string;
  orderId?: string;
  externalOrderId?: string;
  awbNumber?: string;
  trackingNumber?: string;
  courierId?: string;
  courierCode?: string;
  latestEvent?: string;
  description?: string;
  location?: string;
  receivedAt: string;
  rawPayload: Record<string, unknown>;
};

export interface CarrierAdapter {
  name: string;
  mode: CarrierAdapterMode;
  supportsLiveBooking: false;
  quote(request: CarrierQuoteRequest): Promise<CarrierQuoteResult>;
  createShipment(request: CarrierShipmentRequest): Promise<CarrierShipmentResult>;
  cancelShipment(request: CarrierCancelRequest): Promise<CarrierCancelResult>;
  trackShipment(request: CarrierTrackRequest): Promise<CarrierTrackResult>;
  parseWebhook(payload: unknown, context?: CarrierWebhookContext): Promise<NormalizedCarrierWebhook>;
}
