import type { StorePlatform } from "@prisma/client";

export type PlatformPaymentMode = "COD" | "PREPAID" | "UNKNOWN";
export type PlatformWarningLevel = "info" | "warning";

export type PlatformMappingWarning = {
  code: string;
  field: string;
  message: string;
  level: PlatformWarningLevel;
};

export type NormalizedPlatformAddress = {
  name: string | null;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

export type NormalizedPlatformItem = {
  sku: string | null;
  name: string;
  quantity: number;
  unitPricePaise: number;
  weightGrams: number | null;
  requiresShipping: boolean;
};

export type NormalizedPlatformDimensions = {
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
};

export type NormalizedPlatformOrder = {
  platform: StorePlatform;
  externalOrderId: string;
  externalOrderName: string | null;
  orderCreatedAt: string | null;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  shippingAddress: NormalizedPlatformAddress;
  billingAddress: NormalizedPlatformAddress | null;
  paymentMode: PlatformPaymentMode;
  currency: string;
  orderAmountPaise: number;
  codAmountPaise: number;
  items: NormalizedPlatformItem[];
  deadWeightGrams: number | null;
  dimensions: NormalizedPlatformDimensions | null;
  tags: string[];
  notes: string | null;
  pickupLocationId: string | null;
  rawSourceSummary: Record<string, unknown>;
  mappingWarnings: PlatformMappingWarning[];
};

export type PlatformOrderMapper = {
  platform: StorePlatform;
  mapOrder(payload: unknown, options?: { pickupLocationId?: string | null }): NormalizedPlatformOrder;
};

export type PlatformOrderPreview = {
  normalizedOrder: NormalizedPlatformOrder;
};
