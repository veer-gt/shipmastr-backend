import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type LiveCourierRatesMode = "DRY_RUN" | "LIVE";

export type LiveCourierRatesRuntime = {
  enabled: boolean;
  mode: LiveCourierRatesMode;
  pilotOnly: boolean;
};

export type LiveCourierRatesReadiness = {
  status: "DISABLED" | "READY" | "BLOCKED" | "DRY_RUN";
  ready: boolean;
  runtime: LiveCourierRatesRuntime;
  pilot: {
    merchantId: string;
    allowlisted: boolean;
    capabilityEnabled: boolean;
  };
  blockers: string[];
  warnings: string[];
  message: string;
};

type Source = Record<string, unknown>;

function boolValue(source: Source, key: string, fallback = false) {
  const value = source[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled", "live"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function stringValue(source: Source, key: string, fallback = "") {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

export function getLiveCourierRatesRuntime(source: Source = env): LiveCourierRatesRuntime {
  const mode = stringValue(source, "SHIPMASTR_LIVE_COURIER_RATES_MODE", "DRY_RUN").toUpperCase() === "LIVE"
    ? "LIVE"
    : "DRY_RUN";
  return {
    enabled: boolValue(source, "SHIPMASTR_LIVE_COURIER_RATES_ENABLED", false),
    mode,
    pilotOnly: boolValue(source, "SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY", true)
  };
}

export async function getLiveCourierRatesReadiness(
  merchantId: string,
  options: {
    client?: Db;
    source?: Source;
  } = {}
): Promise<LiveCourierRatesReadiness> {
  const runtime = getLiveCourierRatesRuntime(options.source ?? env);
  const pilot = await getLivePilotReadinessSnapshot(merchantId, options.client ?? prisma);
  const capabilityEnabled = pilot.enabledCapabilities.includes("LIVE_COURIER_RATES");
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!runtime.enabled) {
    warnings.push("Live shipping rates are disabled. Shipmastr will continue using safe mock or dry-run rates.");
  } else {
    if (!runtime.pilotOnly) blockers.push("LIVE_COURIER_RATES_NOT_PILOT_ONLY");
    if (runtime.mode === "LIVE" && !pilot.allowlisted) blockers.push("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
    if (runtime.mode === "LIVE" && !capabilityEnabled) blockers.push("LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
    if (runtime.mode === "DRY_RUN") warnings.push("Live shipping rates are in dry-run mode; no live shipping network call is allowed.");
  }

  const ready = runtime.enabled
    && runtime.pilotOnly
    && runtime.mode === "LIVE"
    && pilot.allowlisted
    && capabilityEnabled;
  const status = !runtime.enabled
    ? "DISABLED"
    : blockers.length
      ? "BLOCKED"
      : runtime.mode === "DRY_RUN"
        ? "DRY_RUN"
        : "READY";

  return {
    status,
    ready,
    runtime,
    pilot: {
      merchantId,
      allowlisted: pilot.allowlisted,
      capabilityEnabled
    },
    blockers,
    warnings,
    message: ready
      ? "Pilot live shipping rates are available for this merchant. Public responses remain Shipmastr Smart, Economy, and Express only."
      : "Pilot live shipping rates are not available. Safe mock or dry-run rates remain active."
  };
}

export async function assertLiveCourierRatesAllowed(
  merchantId: string,
  options: {
    client?: Db;
    source?: Source;
  } = {}
) {
  const readiness = await getLiveCourierRatesReadiness(merchantId, options);
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE") {
    return readiness;
  }
  if (!readiness.runtime.pilotOnly) throw new HttpError(409, "LIVE_COURIER_RATES_NOT_PILOT_ONLY");
  if (!readiness.pilot.allowlisted) throw new HttpError(409, "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
  if (!readiness.pilot.capabilityEnabled) throw new HttpError(409, "LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
  return readiness;
}

export function serializeLiveCourierRatesReadiness(readiness: LiveCourierRatesReadiness) {
  return {
    status: readiness.status,
    ready: readiness.ready,
    runtime: {
      enabled: readiness.runtime.enabled,
      mode: readiness.runtime.mode,
      pilot_only: readiness.runtime.pilotOnly
    },
    pilot: {
      merchant_id: readiness.pilot.merchantId,
      allowlisted: readiness.pilot.allowlisted,
      capability_enabled: readiness.pilot.capabilityEnabled
    },
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    message: readiness.message
  };
}
