import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getCourierLiveReadinessSnapshot } from "../courierPartners/liveReadiness/courier-live-readiness.service.js";
import { canResolveShiprocketLiveCredentials } from "../courierPartners/providers/shiprocket/shiprocket-live-credentials.js";
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
  providerReadiness: {
    hasActiveProvider: boolean;
    activeProviderCount: number;
  };
  shiprocket: {
    credentialId: string | null;
    credentialRef?: string | null;
    credentialRefConfigured: boolean;
    credentialResolved: boolean;
  };
  blockers: string[];
  warnings: string[];
  message: string;
};

type Source = Record<string, unknown>;

type CourierProviderCredentialLookup = {
  courierProviderCredential?: {
    findMany?: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
      take: number;
    }) => Promise<Array<{
      id: string;
      credentialRef: string | null;
    }>>;
  };
};

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

function sourceWithEnv(source?: Source) {
  return {
    ...env,
    ...(source ?? {})
  };
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
  const source = sourceWithEnv(options.source);
  const runtime = getLiveCourierRatesRuntime(source);
  const client = options.client ?? prisma;
  const pilot = await getLivePilotReadinessSnapshot(merchantId, client);
  const providerReadiness = await getCourierLiveReadinessSnapshot(merchantId, client);
  const credentialLookup = client as Db & CourierProviderCredentialLookup;
  const shiprocketRecord = credentialLookup.courierProviderCredential?.findMany
    ? await credentialLookup.courierProviderCredential.findMany({
      where: {
        merchantId,
        providerKey: "SHIPROCKET",
        mode: "LIVE",
        status: "ACTIVE",
        credentialRef: { not: null },
        lastTestStatus: "PASS",
        lastTestedAt: { not: null }
      },
      orderBy: { lastTestedAt: "desc" },
      take: 1
    }).then((rows) => rows[0] ?? null)
    : null;
  const credentialResolution = canResolveShiprocketLiveCredentials(shiprocketRecord?.credentialRef, source);
  const shiprocket = {
    credentialId: shiprocketRecord?.id ?? null,
    credentialRef: shiprocketRecord?.credentialRef ?? null,
    credentialRefConfigured: Boolean(shiprocketRecord?.credentialRef),
    credentialResolved: credentialResolution.ok
  };
  const capabilityEnabled = pilot.enabledCapabilities.includes("LIVE_COURIER_RATES");
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!runtime.enabled) {
    warnings.push("Live shipping rates are disabled. Shipmastr will continue using safe mock or dry-run rates.");
  } else {
    if (!runtime.pilotOnly) blockers.push("LIVE_COURIER_RATES_NOT_PILOT_ONLY");
    if (runtime.mode === "LIVE" && !pilot.allowlisted) blockers.push("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
    if (runtime.mode === "LIVE" && !capabilityEnabled) blockers.push("LIVE_COURIER_RATES_CAPABILITY_REQUIRED");
    if (runtime.mode === "LIVE" && !providerReadiness.has_active_provider) blockers.push("LIVE_PROVIDER_CREDENTIALS_MISSING");
    if (runtime.mode === "LIVE" && !shiprocketRecord) blockers.push("LIVE_SHIPPING_PROVIDER_NOT_READY");
    if (runtime.mode === "LIVE" && shiprocketRecord && !shiprocket.credentialRefConfigured) blockers.push("LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
    if (runtime.mode === "LIVE" && shiprocketRecord && !credentialResolution.ok) blockers.push(credentialResolution.code);
    if (runtime.mode === "DRY_RUN") warnings.push("Live shipping rates are in dry-run mode; no live shipping network call is allowed.");
  }

  const ready = runtime.enabled
    && runtime.pilotOnly
    && runtime.mode === "LIVE"
    && pilot.allowlisted
    && capabilityEnabled
    && providerReadiness.has_active_provider
    && Boolean(shiprocketRecord)
    && shiprocket.credentialRefConfigured
    && shiprocket.credentialResolved;
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
    providerReadiness: {
      hasActiveProvider: providerReadiness.has_active_provider,
      activeProviderCount: providerReadiness.active_provider_count
    },
    shiprocket,
    blockers: [...new Set(blockers)],
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
  if (!readiness.providerReadiness.hasActiveProvider) throw new HttpError(409, "LIVE_PROVIDER_CREDENTIALS_MISSING");
  if (!readiness.shiprocket.credentialId) throw new HttpError(409, "LIVE_SHIPPING_PROVIDER_NOT_READY");
  if (!readiness.shiprocket.credentialRefConfigured || !readiness.shiprocket.credentialResolved) {
    throw new HttpError(409, "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED");
  }
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
    shipping_network_readiness: {
      has_active_live_credential: readiness.providerReadiness.hasActiveProvider,
      active_live_credential_count: readiness.providerReadiness.activeProviderCount
    },
    live_rates_provider: {
      credential_configured: readiness.shiprocket.credentialRefConfigured,
      credential_resolved: readiness.shiprocket.credentialResolved
    },
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    message: readiness.message
  };
}
