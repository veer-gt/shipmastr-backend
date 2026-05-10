import { HttpError } from "./httpError.js";

export const COURIER_SERVICE_CODE_TYPE = "SAC";
export const DEFAULT_COURIER_SERVICE_CODE = "996812";
export const DEFAULT_COURIER_GST_RATE = 18;

export const COURIER_SERVICE_CODE_OPTIONS = {
  "996811": "Postal services",
  "996812": "Courier services",
  "996813": "Local delivery services",
  "996819": "Other delivery services n.e.c."
} as const;

export type CourierServiceCode = keyof typeof COURIER_SERVICE_CODE_OPTIONS;

export type CourierServiceTaxClassification = {
  serviceCodeType: typeof COURIER_SERVICE_CODE_TYPE;
  serviceCode: CourierServiceCode;
  serviceDescription: string;
  gstRate: number;
};

type CourierServiceTaxInput = {
  serviceCodeType?: unknown;
  serviceCode?: unknown;
  serviceDescription?: unknown;
  gstRate?: unknown;
};

function normalizeServiceCode(value: unknown): CourierServiceCode {
  const serviceCode = String(value || DEFAULT_COURIER_SERVICE_CODE).trim();
  if (!(serviceCode in COURIER_SERVICE_CODE_OPTIONS)) {
    throw new HttpError(400, "COURIER_SERVICE_CODE_INVALID");
  }

  return serviceCode as CourierServiceCode;
}

function normalizeGstRate(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_COURIER_GST_RATE;
  }

  const gstRate = Number(value);
  if (!Number.isFinite(gstRate) || gstRate !== DEFAULT_COURIER_GST_RATE) {
    throw new HttpError(400, "COURIER_GST_RATE_INVALID");
  }

  return gstRate;
}

export function normalizeCourierServiceTaxClassification(
  input: CourierServiceTaxInput = {}
): CourierServiceTaxClassification {
  const serviceCodeType = String(input.serviceCodeType || COURIER_SERVICE_CODE_TYPE).trim().toUpperCase();
  if (serviceCodeType !== COURIER_SERVICE_CODE_TYPE) {
    throw new HttpError(400, "COURIER_SERVICE_CODE_TYPE_INVALID");
  }

  const serviceCode = normalizeServiceCode(input.serviceCode);

  return {
    serviceCodeType: COURIER_SERVICE_CODE_TYPE,
    serviceCode,
    serviceDescription: COURIER_SERVICE_CODE_OPTIONS[serviceCode],
    gstRate: normalizeGstRate(input.gstRate)
  };
}
