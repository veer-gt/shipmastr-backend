export type InternalCourierProviderCode = "bigship" | "shiprocket";

export type ProviderShipmentStatus =
  | "draft"
  | "rates_fetched"
  | "manifested"
  | "pickup_scheduled"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delivery_failed"
  | "rto_initiated"
  | "rto_in_transit"
  | "rto_delivered"
  | "cancelled"
  | "lost"
  | "damaged"
  | "exception";

export type ProviderPaymentMode = "prepaid" | "cod";

export type ProviderShipmentSegment = "domestic_b2c" | "domestic_b2b" | "hyperlocal";

export type TokenResult = {
  token: string;
  expiresAt: Date;
};

export type ProviderAddressInput = {
  name: string;
  phone: string;
  email?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  country: string;
  pincode: string;
};

export type ProviderDimensionsInput = {
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
};

export type ProviderPickupLocationInput = ProviderAddressInput & {
  sellerId: string;
  pickupLocationId: string;
  contactPerson: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type ProviderPickupLocationResult = {
  providerPickupId: string;
  status: "active" | "pending" | "failed";
  message: string;
  providerMetadata: Record<string, unknown>;
};

export type ProviderDraftOrderInput = {
  sellerId: string;
  shipmentId: string;
  sellerOrderId: string;
  segment: ProviderShipmentSegment;
  paymentMode: ProviderPaymentMode;
  pickupLocationProviderId: string;
  returnLocationProviderId?: string | null;
  invoiceNumber?: string | null;
  invoiceAmount: number;
  collectableAmount?: number | null;
  deadWeightKg: number;
  dimensions: ProviderDimensionsInput;
  buyer: ProviderAddressInput;
  products?: Array<{
    name: string;
    sku?: string | null;
    quantity: number;
    unitPrice: number;
  }>;
};

export type ProviderDraftOrderResult = {
  providerOrderId: string;
  providerReferenceNumber: string;
  status: ProviderShipmentStatus;
  message: string;
  providerMetadata: Record<string, unknown>;
};

export type ProviderRateInput = {
  sellerId: string;
  shipmentId: string;
  providerOrderId?: string | null;
  pickupPincode: string;
  deliveryPincode: string;
  paymentMode: ProviderPaymentMode;
  collectableAmount?: number | null;
  deadWeightKg: number;
  dimensions: ProviderDimensionsInput;
};

export type ProviderRateResult = {
  rateId: string;
  serviceLevel: "Shipmastr Smart" | "Shipmastr Economy" | "Shipmastr Express";
  courierNetwork: "Shipmastr Courier Network";
  totalCharge: number;
  currency: "INR";
  tatDays: number;
  chargedWeightKg: number;
  codSupported?: boolean;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  reliabilityScore?: number;
  providerCourierId?: string;
  providerMetadata: Record<string, unknown>;
};

export type ProviderManifestInput = {
  sellerId: string;
  shipmentId: string;
  providerOrderId: string;
  providerCourierId: string;
  selectedRateId?: string | null;
};

export type ProviderManifestResult = {
  awb: string;
  trackingNumber: string;
  status: ProviderShipmentStatus;
  providerReferenceNumber: string;
  providerAwb?: string;
  labelUrl?: string | null;
  trackingUrl?: string | null;
  message: string;
  providerMetadata: Record<string, unknown>;
};

export type ProviderLabelInput = {
  sellerId: string;
  shipmentId: string;
  awb?: string | null;
  trackingNumber?: string | null;
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
};

export type ProviderLabelResult = {
  labelUrl: string | null;
  trackingUrl?: string | null;
  status: ProviderShipmentStatus;
  message: string;
  providerMetadata: Record<string, unknown>;
};

export type ProviderTrackingInput = {
  awb?: string | null;
  trackingNumber?: string | null;
  providerOrderId?: string | null;
};

export type ProviderTrackingEvent = {
  status: ProviderShipmentStatus;
  publicStatus: string;
  location?: string | null;
  message: string;
  checkpointTime: Date;
};

export type ProviderTrackingResult = {
  awb: string | null;
  trackingNumber: string | null;
  status: ProviderShipmentStatus;
  publicStatus: string;
  latestEvent: string | null;
  events: ProviderTrackingEvent[];
  providerMetadata: Record<string, unknown>;
};

export type ProviderCancelInput = {
  awb?: string | null;
  trackingNumber?: string | null;
  providerOrderId?: string | null;
  reason?: string | null;
};

export type ProviderCancelResult = {
  cancelled: boolean;
  status: ProviderShipmentStatus;
  message: string;
  providerMetadata: Record<string, unknown>;
};

export interface InternalCourierProviderAdapter {
  code: InternalCourierProviderCode;
  login(): Promise<TokenResult>;
  ensureToken(): Promise<TokenResult>;
  createPickupLocation(input: ProviderPickupLocationInput): Promise<ProviderPickupLocationResult>;
  createDraftOrder(input: ProviderDraftOrderInput): Promise<ProviderDraftOrderResult>;
  getRates(input: ProviderRateInput): Promise<ProviderRateResult[]>;
  manifestOrder(input: ProviderManifestInput): Promise<ProviderManifestResult>;
  getLabel(input: ProviderLabelInput): Promise<ProviderLabelResult>;
  trackOrder(input: ProviderTrackingInput): Promise<ProviderTrackingResult>;
  cancelOrder(input: ProviderCancelInput): Promise<ProviderCancelResult>;
}
