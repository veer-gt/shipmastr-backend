import { env } from "../../config/env.js";

type DbClient = Record<string, any>;

export const GOOGLE_GEOCODING_SERVICE_COUNTER = "GOOGLE_GEOCODING";
export const GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER = "GOOGLE_PLACES_AUTOCOMPLETE";
export const GOOGLE_PLACES_DETAILS_SERVICE_COUNTER = "GOOGLE_PLACES_DETAILS";

export type GoogleMapsQuotaServiceCounter =
  | typeof GOOGLE_GEOCODING_SERVICE_COUNTER
  | typeof GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER
  | typeof GOOGLE_PLACES_DETAILS_SERVICE_COUNTER;

function yearMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function capFromEnv(name: "GOOGLE_GEOCODING_MONTHLY_SOFT_CAP" | "GOOGLE_GEOCODING_MONTHLY_HARD_CAP") {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return name === "GOOGLE_GEOCODING_MONTHLY_SOFT_CAP"
    ? env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP
    : env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP;
}

export function googleGeocodingCaps() {
  const softCap = capFromEnv("GOOGLE_GEOCODING_MONTHLY_SOFT_CAP");
  const hardCap = capFromEnv("GOOGLE_GEOCODING_MONTHLY_HARD_CAP");
  return {
    softCap,
    hardCap
  };
}

function quotaErrorCode(service: GoogleMapsQuotaServiceCounter, limit: "SOFT" | "HARD") {
  if (service === GOOGLE_GEOCODING_SERVICE_COUNTER) return `GOOGLE_GEOCODE_QUOTA_${limit}_LIMIT`;
  if (service === GOOGLE_PLACES_AUTOCOMPLETE_SERVICE_COUNTER) return `GOOGLE_PLACES_AUTOCOMPLETE_QUOTA_${limit}_LIMIT`;
  return `GOOGLE_PLACES_DETAILS_QUOTA_${limit}_LIMIT`;
}

export async function reserveGoogleMapsQuota(
  client: DbClient,
  service: GoogleMapsQuotaServiceCounter,
  now = new Date()
) {
  const { softCap, hardCap } = googleGeocodingCaps();
  const counter = await client.googleMapsUsageCounter.upsert({
    where: {
      service_yearMonth: {
        service,
        yearMonth: yearMonth(now)
      }
    },
    create: {
      service,
      yearMonth: yearMonth(now),
      count: 1,
      softLimit: softCap,
      hardLimit: hardCap
    },
    update: {
      count: { increment: 1 },
      softLimit: softCap,
      hardLimit: hardCap
    }
  });

  if (counter.count >= hardCap) {
    return {
      allowed: false,
      warning: true,
      errorCode: quotaErrorCode(service, "HARD")
    };
  }

  if (counter.count >= softCap) {
    return {
      allowed: false,
      warning: true,
      errorCode: quotaErrorCode(service, "SOFT")
    };
  }

  return {
    allowed: true,
    warning: false,
    errorCode: null
  };
}

export function reserveGoogleGeocodeQuota(client: DbClient, now = new Date()) {
  return reserveGoogleMapsQuota(client, GOOGLE_GEOCODING_SERVICE_COUNTER, now);
}
