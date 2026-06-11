import {
  courierLiveProviderKeys,
  type CourierLiveProbeType,
  type CourierLiveProviderDefinition,
  type CourierLiveProviderKey
} from "./courier-live-readiness.types.js";

export const courierLiveProviderDefinitions: Record<CourierLiveProviderKey, CourierLiveProviderDefinition> = {
  BIGSHIP: {
    providerKey: "BIGSHIP",
    label: "Bigship",
    requiredFields: ["clientId", "clientSecret", "accessKey"],
    supportedProbeTypes: ["ACCOUNT_INFO", "PINCODE_SERVICEABILITY", "RATE_SERVICEABILITY", "WAREHOUSE_LIST"],
    supportsAwbLabelReadiness: true,
    defaultLiveBaseUrl: "https://api.bigship.direct/"
  },
  SHIPMOZO: {
    providerKey: "SHIPMOZO",
    label: "Shipmozo",
    requiredFields: ["publicKey", "privateKey"],
    supportedProbeTypes: ["WAREHOUSE_LIST", "PINCODE_SERVICEABILITY", "RATE_SERVICEABILITY"],
    supportsAwbLabelReadiness: true,
    defaultLiveBaseUrl: "https://shipping-api.com/"
  },
  SHIPROCKET: {
    providerKey: "SHIPROCKET",
    label: "Shiprocket",
    requiredFields: ["email", "password"],
    supportedProbeTypes: ["PICKUP_ADDRESS_LIST", "PINCODE_SERVICEABILITY", "RATE_SERVICEABILITY", "ACCOUNT_INFO"],
    supportsAwbLabelReadiness: true,
    defaultLiveBaseUrl: "https://apiv2.shiprocket.in/"
  }
};

export function normalizeCourierLiveProviderKey(value: string): CourierLiveProviderKey | null {
  const normalized = String(value || "").trim().toUpperCase();
  return courierLiveProviderKeys.includes(normalized as CourierLiveProviderKey)
    ? normalized as CourierLiveProviderKey
    : null;
}

export function getCourierLiveProviderDefinition(providerKey: CourierLiveProviderKey) {
  return courierLiveProviderDefinitions[providerKey];
}

export function providerSupportsProbe(providerKey: CourierLiveProviderKey, probeType: CourierLiveProbeType) {
  return getCourierLiveProviderDefinition(providerKey).supportedProbeTypes.includes(probeType);
}

