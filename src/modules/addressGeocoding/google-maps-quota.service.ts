import { env } from "../../config/env.js";

type DbClient = Record<string, any>;

export const GOOGLE_GEOCODING_SERVICE_COUNTER = "GOOGLE_GEOCODING";

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

export async function reserveGoogleGeocodeQuota(client: DbClient, now = new Date()) {
  const { softCap, hardCap } = googleGeocodingCaps();
  const counter = await client.googleMapsUsageCounter.upsert({
    where: {
      service_yearMonth: {
        service: GOOGLE_GEOCODING_SERVICE_COUNTER,
        yearMonth: yearMonth(now)
      }
    },
    create: {
      service: GOOGLE_GEOCODING_SERVICE_COUNTER,
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
      errorCode: "GOOGLE_GEOCODE_QUOTA_HARD_LIMIT"
    };
  }

  if (counter.count >= softCap) {
    return {
      allowed: false,
      warning: true,
      errorCode: "GOOGLE_GEOCODE_QUOTA_SOFT_LIMIT"
    };
  }

  return {
    allowed: true,
    warning: false,
    errorCode: null
  };
}
