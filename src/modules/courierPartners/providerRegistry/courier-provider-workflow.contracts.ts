import type {
  CourierProviderCapability,
  CourierProviderInternalShipmentStatus,
  CourierProviderLaneCode,
  CourierProviderRuntimeMode
} from "./courier-provider-registry.types.js";

export type CourierProviderWorkflowContext = {
  merchantId: string;
  shipmentId?: string;
  laneCode: CourierProviderLaneCode;
  requestedMode: CourierProviderRuntimeMode;
  idempotencyKey?: string;
};

export type CourierProviderAddress = {
  name: string;
  phone?: string | null;
  email?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  country: string;
  pincode: string;
};

export type CourierProviderPackage = {
  deadWeightKg: number;
  lengthCm?: number | null;
  breadthCm?: number | null;
  heightCm?: number | null;
  declaredValuePaise?: number | null;
};

export type CourierProviderWorkflowResult<TSafeData extends Record<string, unknown> = Record<string, unknown>> = {
  capability: CourierProviderCapability;
  mode: CourierProviderRuntimeMode;
  lane_code: CourierProviderLaneCode;
  safe_status: "DRY_RUN" | "STAGED" | "READY" | "BLOCKED" | "FAILED";
  safe_data: TSafeData;
  warnings: string[];
  provider_raw_response_stored: false;
  provider_headers_stored: false;
  credential_values_exposed: false;
};

export type CourierProviderRateRequest = CourierProviderWorkflowContext & {
  pickupPincode: string;
  deliveryPincode: string;
  paymentMode: "PREPAID" | "COD";
  collectableAmountPaise?: number | null;
  invoiceAmountPaise?: number | null;
  package: CourierProviderPackage;
};

export type CourierProviderAwbRequest = CourierProviderWorkflowContext & {
  pickup: CourierProviderAddress;
  delivery: CourierProviderAddress;
  paymentMode: "PREPAID" | "COD";
  collectableAmountPaise?: number | null;
  package: CourierProviderPackage;
  invoiceNumber?: string | null;
  lineItems?: Array<{
    sku?: string | null;
    name: string;
    quantity: number;
    unitPricePaise: number;
  }>;
};

export type CourierProviderLabelRequest = CourierProviderWorkflowContext & {
  awbNumber?: string | null;
  providerShipmentRef?: string | null;
};

export type CourierProviderCancelRequest = CourierProviderWorkflowContext & {
  awbNumber?: string | null;
  providerShipmentRef?: string | null;
  reason?: string | null;
};

export type CourierProviderPickupRequest = CourierProviderWorkflowContext & {
  pickupLocationId: string;
  expectedPackageCount?: number | null;
  pickupDate?: string | null;
  pickupWindowStart?: string | null;
  pickupWindowEnd?: string | null;
};

export type CourierProviderTrackingRequest = CourierProviderWorkflowContext & {
  awbNumber?: string | null;
  providerShipmentRef?: string | null;
};

export type CourierProviderStatusMappingRequest = {
  laneCode: CourierProviderLaneCode;
  rawStatus: string;
};

export type CourierProviderNdrRequest = CourierProviderWorkflowContext & {
  awbNumber?: string | null;
  action: "REATTEMPT" | "RETURN_TO_ORIGIN" | "CONTACT_CUSTOMER" | "ADDRESS_CORRECTION";
  reattemptDate?: string | null;
  safeRemarks?: string | null;
};

export type CourierProviderWeightDisputeRequest = CourierProviderWorkflowContext & {
  awbNumber?: string | null;
  chargedWeightKg: number;
  expectedWeightKg: number;
  safeEvidenceRefs?: string[];
};

export type CourierProviderCodRemittanceRequest = CourierProviderWorkflowContext & {
  remittanceReference?: string | null;
  amountPaise: number;
  safePeriodLabel?: string | null;
};

export interface CourierProviderWorkflowAdapter {
  laneCode: CourierProviderLaneCode;
  calculateRates(input: CourierProviderRateRequest): Promise<CourierProviderWorkflowResult>;
  createAwb(input: CourierProviderAwbRequest): Promise<CourierProviderWorkflowResult>;
  fetchLabel(input: CourierProviderLabelRequest): Promise<CourierProviderWorkflowResult>;
  cancelShipment(input: CourierProviderCancelRequest): Promise<CourierProviderWorkflowResult>;
  requestPickup(input: CourierProviderPickupRequest): Promise<CourierProviderWorkflowResult>;
  trackShipment(input: CourierProviderTrackingRequest): Promise<CourierProviderWorkflowResult<{
    status: CourierProviderInternalShipmentStatus;
    public_message: string;
  }>>;
  mapRawStatus(input: CourierProviderStatusMappingRequest): CourierProviderInternalShipmentStatus;
  submitNdrAction(input: CourierProviderNdrRequest): Promise<CourierProviderWorkflowResult>;
  submitWeightDispute(input: CourierProviderWeightDisputeRequest): Promise<CourierProviderWorkflowResult>;
  reconcileCodRemittance(input: CourierProviderCodRemittanceRequest): Promise<CourierProviderWorkflowResult>;
}
