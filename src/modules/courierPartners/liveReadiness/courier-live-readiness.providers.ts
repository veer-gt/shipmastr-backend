import {
  courierLiveProviderKeys,
  type CourierProviderRequiredFields,
  type CourierLiveProbeType,
  type CourierLiveProviderDefinition,
  type CourierLiveProviderKey
} from "./courier-live-readiness.types.js";

export const COURIER_READINESS_PROBE_CONSTANTS = {
  BIGSHIP_PROBE_PICKUP_PINCODE: "110001",
  SHIPMOZO_PROBE_PICKUP_PINCODE: "110001",
  SHIPROCKET_PROBE_PICKUP_PINCODE: "110001",
  PROBE_DELIVERY_PINCODE: "400001",
  PROBE_WEIGHT_GRAMS: 500,
  PROBE_COD: false
} as const;

function fields(fields: CourierProviderRequiredFields["fields"]): CourierProviderRequiredFields {
  return { fields };
}

export const courierLiveProviderDefinitions: Record<CourierLiveProviderKey, CourierLiveProviderDefinition> = {
  BIGSHIP: {
    providerKey: "BIGSHIP",
    label: "Bigship",
    requiredFields: fields([
      { name: "clientId", label: "Client ID", sensitive: true, required: true, format: "vault_ref_only" },
      { name: "clientSecret", label: "Client secret", sensitive: true, required: true, format: "vault_ref_only" },
      { name: "accessKey", label: "Access key", sensitive: true, required: true, format: "vault_ref_only" }
    ]),
    supportedProbeTypes: ["ACCOUNT_INFO", "PINCODE_SERVICEABILITY", "RATE_SERVICEABILITY", "WAREHOUSE_LIST"],
    supportsAwbLabelReadiness: true,
    defaultLiveBaseUrl: "https://api.bigship.direct/"
  },
  SHIPMOZO: {
    providerKey: "SHIPMOZO",
    label: "Shipmozo",
    // TODO: Confirm Shipmozo API credential field names from official docs before live credential use.
    requiredFields: fields([
      { name: "publicKey", label: "Public key", sensitive: true, required: true, format: "vault_ref_only", provisional: true },
      { name: "privateKey", label: "Private key", sensitive: true, required: true, format: "vault_ref_only", provisional: true }
    ]),
    supportedProbeTypes: ["WAREHOUSE_LIST", "PINCODE_SERVICEABILITY", "RATE_SERVICEABILITY"],
    supportsAwbLabelReadiness: true,
    defaultLiveBaseUrl: "https://shipping-api.com/"
  },
  SHIPROCKET: {
    providerKey: "SHIPROCKET",
    label: "Shiprocket",
    requiredFields: fields([
      { name: "email", label: "Account email", sensitive: true, required: true, format: "vault_ref_only" },
      { name: "password", label: "Account password", sensitive: true, required: true, format: "vault_ref_only" }
    ]),
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

export function requiredFieldNames(requiredFields: CourierProviderRequiredFields) {
  return requiredFields.fields.filter((field) => field.required).map((field) => field.name);
}

export function assertRequiredFieldsSchema(value: unknown): asserts value is CourierProviderRequiredFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("COURIER_PROVIDER_REQUIRED_FIELDS_SCHEMA_INVALID");
  }
  const fieldsValue = (value as CourierProviderRequiredFields).fields;
  if (!Array.isArray(fieldsValue) || !fieldsValue.length) {
    throw new Error("COURIER_PROVIDER_REQUIRED_FIELDS_SCHEMA_INVALID");
  }
  for (const field of fieldsValue) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new Error("COURIER_PROVIDER_REQUIRED_FIELDS_SCHEMA_INVALID");
    }
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(field.name)
      || typeof field.label !== "string"
      || field.label.trim().length < 1
      || typeof field.sensitive !== "boolean"
      || typeof field.required !== "boolean") {
      throw new Error("COURIER_PROVIDER_REQUIRED_FIELDS_SCHEMA_INVALID");
    }
  }
}

export function providerSupportsProbe(providerKey: CourierLiveProviderKey, probeType: CourierLiveProbeType) {
  return getCourierLiveProviderDefinition(providerKey).supportedProbeTypes.includes(probeType);
}
