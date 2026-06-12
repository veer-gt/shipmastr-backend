import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { getCourierLiveProviderDefinition } from "../liveReadiness/courier-live-readiness.providers.js";
import { getCourierLiveReadinessSnapshot } from "../liveReadiness/courier-live-readiness.service.js";
import type {
  CourierLiveCredentialSummary,
  CourierLiveProviderKey
} from "../liveReadiness/courier-live-readiness.types.js";
import { getShiprocketPickupDiagnostics } from "../../shippingNetwork/shipping-shiprocket-pickup-alignment.service.js";
import {
  latestRateRefreshDiagnosticFromShipment,
  type LiveRateRefreshDiagnostic
} from "../../shippingNetwork/shipping-rates.service.js";
import {
  diagnoseCourierPickupServiceability
} from "../pickupServiceability/courier-pickup-serviceability.service.js";
import type { CourierPickupServiceabilityResult } from "../pickupServiceability/courier-pickup-serviceability.types.js";
import type {
  CourierCertificationBlocker,
  CourierCertificationDimension,
  CourierCertificationDimensionKey,
  CourierCertificationSnapshot,
  CourierCertificationStatus,
  CourierCertificationSummary
} from "./courier-certification.types.js";
import {
  serializeCourierCertificationSnapshot,
  serializeCourierCertificationSummary
} from "./courier-certification.serializer.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Source = Record<string, unknown>;

type RateRecord = {
  id: string;
  publicServiceCode?: string | null;
  publicServiceName?: string | null;
  rateBreakup?: unknown;
  createdAt?: Date | string;
};

type ProbeRecord = {
  providerKey: string;
  probeType: string;
  status: string;
  testedAt?: Date | string;
};

type CertificationOptions = {
  client?: Db;
  source?: Source;
  checkedAt?: string;
  includePickupProbe?: boolean;
  shipmentId?: string;
  pickupLocationId?: string;
  providerKey?: CourierLiveProviderKey;
  status?: CourierCertificationStatus;
  capability?: CourierCertificationDimensionKey;
  pickupDiagnostics?: Awaited<ReturnType<typeof getShiprocketPickupDiagnostics>>;
};

const PROVIDERS = ["BIGSHIP", "SHIPMOZO", "SHIPROCKET"] as const satisfies readonly CourierLiveProviderKey[];
const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function strictBool(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function isSmartRate(rate: RateRecord) {
  return rate.publicServiceCode === "shipmastr_smart" || rate.publicServiceName === "Shipmastr Smart";
}

function liveRateMetadata(rate: RateRecord | null) {
  const metadata = metadataObject(rate?.rateBreakup);
  const phase6 = metadataObject(metadata.phase6);
  const result = metadataObject(metadata.result);
  const providerCourierId = firstString(
    metadata.shiprocketCourierId,
    metadata.providerCourierId,
    metadata.courier_id,
    metadata.courierId,
    phase6.shiprocketCourierId,
    phase6.providerCourierId,
    phase6.courier_id,
    phase6.courierId,
    result.courier_id,
    result.courierId,
    result.providerCourierId
  );
  const mode = firstString(phase6.livePilotRatesMode, metadata.livePilotRatesMode);
  return {
    found: Boolean(rate),
    liveMode: mode === "LIVE",
    liveReady: phase6.livePilotRatesReady === true || metadata.livePilotRatesReady === true,
    pickupAvailable: strictBool(phase6.pickupAvailable),
    providerCourierIdPresent: Boolean(providerCourierId && /^[0-9]+$/.test(providerCourierId)),
    checkedAt: rate?.createdAt ?? null,
    latestRefresh: null as LiveRateRefreshDiagnostic | null
  };
}

async function latestSmartRate(merchantId: string, client: Db, shipmentId?: string): Promise<RateRecord | null> {
  const model = (client as Db & { shipmentRate?: { findMany?: Function } }).shipmentRate;
  if (!model?.findMany) return null;
  const rows = await model.findMany({
    where: {
      sellerId: merchantId,
      ...(shipmentId ? { shipmentId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 25
  }) as RateRecord[];
  return rows.find(isSmartRate) ?? rows[0] ?? null;
}

async function latestRateRefreshDiagnostic(
  merchantId: string,
  shipmentId: string | undefined,
  client: Db
) {
  if (!shipmentId) return null;
  const model = (client as Db & { shipment?: { findFirst?: Function } }).shipment;
  if (!model?.findFirst) return null;
  const shipment = await model.findFirst({
    where: {
      id: shipmentId,
      sellerId: merchantId
    }
  });
  return shipment ? latestRateRefreshDiagnosticFromShipment(shipment) : null;
}

async function latestProbe(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  probeTypes: string[],
  client: Db
): Promise<ProbeRecord | null> {
  const model = (client as Db & { courierProviderReadinessProbe?: { findMany?: Function } }).courierProviderReadinessProbe;
  if (!model?.findMany) return null;
  const rows = await model.findMany({
    where: {
      merchantId,
      providerKey
    },
    orderBy: { testedAt: "desc" },
    take: 20
  }) as ProbeRecord[];
  return rows.find((row) => probeTypes.includes(row.probeType)) ?? null;
}

function credentialDimension(credential: CourierLiveCredentialSummary | null): CourierCertificationDimension {
  const blockers: CourierCertificationBlocker[] = [];
  const warnings: string[] = [];
  if (!credential?.configured) blockers.push("PROVIDER_CREDENTIALS_MISSING");
  if (credential?.status === "REVOKED") warnings.push("Provider credential has been revoked.");
  if (credential && (!credential.last_tested_at || !credential.last_test_status)) blockers.push("PROVIDER_CREDENTIAL_TEST_NOT_RUN");
  if (credential?.last_test_status && credential.last_test_status !== "PASS") blockers.push("PROVIDER_CREDENTIAL_TEST_FAILED");
  return {
    key: "CREDENTIALS",
    status: credential?.live_ready ? "PASS" : blockers.length ? "FAIL" : "NOT_RUN",
    blockers,
    warnings,
    safe_summary: {
      configured: Boolean(credential?.configured),
      mode: credential?.mode ?? null,
      status: credential?.status ?? null,
      last_test_status: credential?.last_test_status ?? null,
      last_tested_at: credential?.last_tested_at ?? null,
      missing_field_count: credential?.missing_fields.length ?? null
    }
  };
}

function dryRunProviderDimensions(providerKey: CourierLiveProviderKey, credential: CourierLiveCredentialSummary | null): CourierCertificationDimension[] {
  return [
    credentialDimension(credential),
    {
      key: "RATES",
      status: "WARN",
      blockers: [],
      warnings: ["Provider is currently certified for dry-run routing only."],
      safe_summary: { dry_run_supported: true, live_rate_calls_allowed: false }
    },
    {
      key: "PUBLIC_SAFETY",
      status: "PASS",
      blockers: [],
      warnings: [],
      safe_summary: { public_network_name: PUBLIC_NETWORK_NAME, provider_details_public: false }
    },
    {
      key: "AWB",
      status: "NOT_RUN",
      blockers: ["PROVIDER_AWB_NOT_CERTIFIED"],
      warnings: ["Live AWB certification has not been completed."],
      safe_summary: { live_awb_certified: false, mutation_probe_allowed: false, provider_key: providerKey }
    }
  ];
}

function pickupDimension(diagnostics: Awaited<ReturnType<typeof getShiprocketPickupDiagnostics>> | null): CourierCertificationDimension {
  if (!diagnostics) {
    return {
      key: "PICKUPS",
      status: "NOT_RUN",
      blockers: ["PROVIDER_PICKUP_NOT_FOUND"],
      warnings: ["Pickup alignment probe has not been run for certification."],
      safe_summary: {
        shipmastr_pickup_count: null,
        provider_pickup_count: null,
        pincode_match: null
      }
    };
  }
  const blockers = diagnostics.blockers.map((blocker) => {
    if (blocker === "SHIPROCKET_PICKUP_PINCODE_MISMATCH") return "PROVIDER_PICKUP_PINCODE_MISMATCH";
    if (blocker === "SHIPROCKET_LIVE_PICKUP_UNAVAILABLE") return "PROVIDER_PICKUP_UNAVAILABLE";
    return "PROVIDER_PICKUP_NOT_FOUND";
  });
  return {
    key: "PICKUPS",
    status: blockers.length ? "FAIL" : diagnostics.warnings.length ? "WARN" : "PASS",
    blockers: unique(blockers),
    warnings: diagnostics.warnings,
    safe_summary: {
      selected_context: diagnostics.selectedContext,
      shipmastr_pickup_count: diagnostics.shipmastrPickupCount,
      provider_pickup_count: diagnostics.providerPickupCount,
      pincode_match: diagnostics.providerPickupPincodeMatch,
      any_usable_pickup: diagnostics.anyUsableProviderPickup,
      live_rate_pickup_available: diagnostics.liveRate.pickupAvailable
    }
  };
}

function serviceabilityDimension(input: {
  credential: CourierLiveCredentialSummary | null;
  serviceabilityProbe: ProbeRecord | null;
  rateMeta: ReturnType<typeof liveRateMetadata>;
}): CourierCertificationDimension {
  if (input.rateMeta.latestRefresh?.status === "PROVIDER_SERVICEABILITY_NO_CANDIDATES") {
    return {
      key: "SERVICEABILITY",
      status: "FAIL",
      blockers: ["PROVIDER_SERVICEABILITY_NO_CANDIDATES"],
      warnings: ["Latest live rate refresh returned no serviceable candidates for this pickup and delivery context."],
      safe_summary: {
        latest_refresh_status: input.rateMeta.latestRefresh.status,
        live_serviceability_returned_count: input.rateMeta.latestRefresh.live_serviceability_returned_count,
        checked_at: input.rateMeta.latestRefresh.checked_at
      }
    };
  }
  if (input.rateMeta.liveReady || input.serviceabilityProbe?.status === "PASS") {
    return {
      key: "SERVICEABILITY",
      status: "PASS",
      blockers: [],
      warnings: [],
      safe_summary: {
        live_rate_seen: input.rateMeta.liveReady,
        readiness_probe_status: input.serviceabilityProbe?.status ?? null,
        last_checked_at: input.rateMeta.checkedAt ?? input.serviceabilityProbe?.testedAt ?? null
      }
    };
  }
  if (input.credential?.live_ready) {
    return {
      key: "SERVICEABILITY",
      status: "WARN",
      blockers: ["PROVIDER_SERVICEABILITY_NOT_RUN"],
      warnings: ["Credential is ready, but a live serviceability or rate certification run has not been recorded."],
      safe_summary: { readiness_probe_status: input.serviceabilityProbe?.status ?? null }
    };
  }
  return {
    key: "SERVICEABILITY",
    status: "NOT_RUN",
    blockers: ["PROVIDER_SERVICEABILITY_NOT_RUN"],
    warnings: [],
    safe_summary: { readiness_probe_status: input.serviceabilityProbe?.status ?? null }
  };
}

function ratesDimension(
  rateMeta: ReturnType<typeof liveRateMetadata>,
  pickupServiceability: CourierPickupServiceabilityResult | null
): CourierCertificationDimension {
  const blockers: CourierCertificationBlocker[] = [];
  const latestNoEligible = rateMeta.latestRefresh
    && ["NO_ELIGIBLE_SHIPPING_RATES", "PROVIDER_SERVICEABILITY_NO_CANDIDATES"].includes(rateMeta.latestRefresh.status);
  if (latestNoEligible) blockers.push("PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES");
  if (!latestNoEligible && (!rateMeta.liveMode || !rateMeta.liveReady)) blockers.push("PROVIDER_RATES_NOT_LIVE");
  if (!latestNoEligible && !rateMeta.providerCourierIdPresent) blockers.push("PROVIDER_COURIER_ID_MISSING");
  if (
    rateMeta.pickupAvailable === false
    || rateMeta.latestRefresh?.provider_pickup_available_any === false
    || pickupServiceability?.status === "PICKUP_UNAVAILABLE"
  ) blockers.push("PROVIDER_PICKUP_UNAVAILABLE");
  return {
    key: "RATES",
    status: blockers.length ? "FAIL" : "PASS",
    blockers,
    warnings: latestNoEligible
      ? ["Latest live rate refresh returned no eligible Shipmastr shipping option for this pickup."]
      : rateMeta.found ? [] : ["No latest Shipmastr Smart rate was available for certification."],
    safe_summary: {
      latest_rate_found: rateMeta.found,
      latest_refresh_status: rateMeta.latestRefresh?.status ?? null,
      eligible_rate_count: rateMeta.latestRefresh?.eligible_rate_count ?? null,
      live_rate_candidates_count: rateMeta.latestRefresh?.live_rate_candidates_count ?? null,
      pickup_available_any: rateMeta.latestRefresh?.provider_pickup_available_any ?? null,
      stale_selected_rate_ignored: rateMeta.latestRefresh?.stale_selected_rate_ignored ?? false,
      pickup_serviceability_status: pickupServiceability?.status ?? null,
      pickup_available_count: pickupServiceability?.latest_rate_context.pickup_available_count ?? null,
      delivery_available_count: pickupServiceability?.latest_rate_context.delivery_available_count ?? null,
      numeric_courier_id_count: pickupServiceability?.latest_rate_context.numeric_courier_id_count ?? null,
      recommended_action: pickupServiceability?.recommended_action ?? null,
      pickup_learning_status: pickupServiceability?.learning_summary?.status ?? null,
      pickup_learning_availability_score: pickupServiceability?.learning_summary?.availability_score ?? null,
      pickup_learning_recommendation: pickupServiceability?.learning_summary?.recommendation ?? null,
      live_mode: rateMeta.liveMode,
      live_ready: rateMeta.liveReady,
      pickup_available: rateMeta.pickupAvailable,
      numeric_provider_courier_id_present: rateMeta.providerCourierIdPresent,
      checked_at: rateMeta.checkedAt
    }
  };
}

function providerCourierIdDimension(rateMeta: ReturnType<typeof liveRateMetadata>): CourierCertificationDimension {
  return {
    key: "COURIER_ID_MAPPING",
    status: rateMeta.providerCourierIdPresent ? "PASS" : "FAIL",
    blockers: rateMeta.providerCourierIdPresent ? [] : ["PROVIDER_COURIER_ID_MISSING"],
    warnings: [],
    safe_summary: { numeric_provider_courier_id_present: rateMeta.providerCourierIdPresent }
  };
}

function fixedDimension(input: {
  key: CourierCertificationDimension["key"];
  status: CourierCertificationDimension["status"];
  blocker?: CourierCertificationBlocker;
  warning?: string;
  summary: Record<string, unknown>;
}): CourierCertificationDimension {
  return {
    key: input.key,
    status: input.status,
    blockers: input.blocker ? [input.blocker] : [],
    warnings: input.warning ? [input.warning] : [],
    safe_summary: input.summary
  };
}

function nextActionsFor(blockers: string[], providerKey: CourierLiveProviderKey) {
  const actions: string[] = [];
  if (blockers.includes("PROVIDER_CREDENTIALS_MISSING")) actions.push("Attach and test a live credential reference.");
  if (blockers.includes("PROVIDER_CREDENTIAL_TEST_NOT_RUN")) actions.push("Run a non-destructive credential readiness probe.");
  if (blockers.includes("PROVIDER_CREDENTIAL_TEST_FAILED")) actions.push("Fix credential readiness before any live routing.");
  if (blockers.includes("PROVIDER_PICKUP_NOT_FOUND") || blockers.includes("PROVIDER_PICKUP_PINCODE_MISMATCH")) {
    actions.push("Align the Shipmastr pickup location with the certified provider pickup.");
  }
  if (blockers.includes("PROVIDER_PICKUP_UNAVAILABLE")) actions.push("Use another pickup or fix pickup availability before Ship Now.");
  if (blockers.includes("PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES")) {
    actions.push("Fix pickup/serviceability or try another pickup, then refresh live rates again.");
  }
  if (blockers.includes("PROVIDER_SERVICEABILITY_NO_CANDIDATES")) {
    actions.push("Confirm provider serviceability for the selected pickup and delivery pincodes, then refresh rates.");
  }
  if (blockers.includes("PROVIDER_RATES_NOT_LIVE")) actions.push("Run a pilot live rate fetch after pickup alignment.");
  if (blockers.includes("PROVIDER_COURIER_ID_MISSING")) actions.push("Confirm live rates return a numeric internal courier mapping.");
  if (blockers.includes("PROVIDER_AWB_NOT_CERTIFIED")) actions.push("Complete an explicit one-shot live AWB certification before live Ship Now.");
  if (!actions.length && providerKey !== "SHIPROCKET") actions.push("Keep this provider in dry-run until live adapter certification is complete.");
  return unique(actions);
}

function statusFor(input: {
  providerKey: CourierLiveProviderKey;
  credential: CourierLiveCredentialSummary | null;
  dimensions: CourierCertificationDimension[];
}) {
  if (input.credential?.status === "REVOKED") return "REVOKED" as const;
  const blockers = input.dimensions.flatMap((dimension) => dimension.blockers);
  const credentialsMissing = blockers.includes("PROVIDER_CREDENTIALS_MISSING");
  if (input.providerKey !== "SHIPROCKET" && !input.credential?.live_ready) return "READY_FOR_DRY_RUN" as const;
  if (credentialsMissing) return "NOT_CONFIGURED" as const;
  if (blockers.includes("PROVIDER_PICKUP_UNAVAILABLE")
    || blockers.includes("PROVIDER_PICKUP_NOT_FOUND")
    || blockers.includes("PROVIDER_PICKUP_PINCODE_MISMATCH")
    || blockers.includes("PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES")
    || blockers.includes("PROVIDER_SERVICEABILITY_NO_CANDIDATES")
    || blockers.includes("PROVIDER_CREDENTIAL_TEST_FAILED")) {
    return "BLOCKED" as const;
  }
  const ratesReady = !blockers.includes("PROVIDER_RATES_NOT_LIVE") && !blockers.includes("PROVIDER_COURIER_ID_MISSING");
  const awbCertified = !blockers.includes("PROVIDER_AWB_NOT_CERTIFIED") && !blockers.includes("PROVIDER_LABEL_NOT_CERTIFIED");
  if (input.credential?.live_ready && ratesReady && awbCertified) return "READY_FOR_LIVE" as const;
  if (input.credential?.live_ready && ratesReady) return "READY_FOR_PILOT" as const;
  if (input.credential?.live_ready) return "PARTIAL" as const;
  return "BLOCKED" as const;
}

function buildSnapshot(input: {
  providerKey: CourierLiveProviderKey;
  checkedAt: string;
  credential: CourierLiveCredentialSummary | null;
  dimensions: CourierCertificationDimension[];
}): CourierCertificationSnapshot {
  const blockers = unique(input.dimensions.flatMap((dimension) => dimension.blockers));
  const warnings = unique(input.dimensions.flatMap((dimension) => dimension.warnings));
  const status: CourierCertificationStatus = statusFor(input);
  const canUseForRates = input.providerKey === "SHIPROCKET"
    ? status === "READY_FOR_PILOT" || status === "READY_FOR_LIVE"
    : status === "READY_FOR_DRY_RUN";
  const canUseForAwb = status === "READY_FOR_LIVE";
  return serializeCourierCertificationSnapshot({
    provider_key: input.providerKey,
    provider_label_internal: getCourierLiveProviderDefinition(input.providerKey).label,
    public_network_name: PUBLIC_NETWORK_NAME,
    status,
    live_ready: status === "READY_FOR_LIVE",
    can_use_for_rates: canUseForRates,
    can_use_for_awb: canUseForAwb,
    can_use_for_label: canUseForAwb,
    can_use_for_tracking: false,
    dimensions: input.dimensions,
    blockers,
    warnings,
    next_actions: nextActionsFor(blockers, input.providerKey),
    checked_at: input.checkedAt
  });
}

async function shiprocketSnapshot(
  merchantId: string,
  credential: CourierLiveCredentialSummary | null,
  options: Required<Pick<CertificationOptions, "client" | "checkedAt">> & CertificationOptions
) {
  const [rate, serviceabilityProbe] = await Promise.all([
    latestSmartRate(merchantId, options.client, options.shipmentId),
    latestProbe(merchantId, "SHIPROCKET", ["RATE_SERVICEABILITY", "PINCODE_SERVICEABILITY"], options.client)
  ]);
  const rateMeta = {
    ...liveRateMetadata(rate),
    latestRefresh: await latestRateRefreshDiagnostic(merchantId, options.shipmentId, options.client)
  };
  const pickupDiagnostics = options.pickupDiagnostics ?? (options.includePickupProbe
    ? await getShiprocketPickupDiagnostics(merchantId, {
      client: options.client,
      includeProviderPickups: true,
      ...(options.shipmentId ? { shipmentId: options.shipmentId } : {}),
      ...(options.pickupLocationId ? { pickupLocationId: options.pickupLocationId } : {}),
      ...(options.source ? { source: options.source } : {})
    })
    : null);
  const pickupServiceability = options.shipmentId
    ? await diagnoseCourierPickupServiceability(merchantId, {
      providerKey: "SHIPROCKET",
      shipmentId: options.shipmentId,
      ...(options.pickupLocationId ? { pickupLocationId: options.pickupLocationId } : {})
    }, { client: options.client })
    : null;
  const dimensions = [
    credentialDimension(credential),
    pickupDimension(pickupDiagnostics),
    serviceabilityDimension({ credential, serviceabilityProbe, rateMeta }),
    ratesDimension(rateMeta, pickupServiceability),
    providerCourierIdDimension(rateMeta),
    fixedDimension({
      key: "AWB",
      status: "WARN",
      blocker: "PROVIDER_AWB_NOT_CERTIFIED",
      warning: "Live AWB one-shot certification has not been completed.",
      summary: { live_awb_certified: false, mutation_probe_allowed: false }
    }),
    fixedDimension({
      key: "LABEL",
      status: "WARN",
      blocker: "PROVIDER_LABEL_NOT_CERTIFIED",
      warning: "Live label certification has not been completed.",
      summary: { live_label_certified: false, mutation_probe_allowed: false }
    }),
    fixedDimension({
      key: "TRACKING",
      status: "NOT_RUN",
      blocker: "PROVIDER_TRACKING_NOT_CERTIFIED",
      summary: { live_tracking_certified: false }
    }),
    fixedDimension({
      key: "WEBHOOKS",
      status: "NOT_SUPPORTED",
      summary: { provider_webhook_certified: false, registration_performed: false }
    }),
    fixedDimension({
      key: "PUBLIC_SAFETY",
      status: "PASS",
      summary: { public_network_name: PUBLIC_NETWORK_NAME, provider_details_public: false }
    })
  ];
  return buildSnapshot({ providerKey: "SHIPROCKET", checkedAt: options.checkedAt, credential, dimensions });
}

async function providerSnapshot(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: Required<Pick<CertificationOptions, "client" | "checkedAt">> & CertificationOptions
) {
  const readiness = await getCourierLiveReadinessSnapshot(merchantId, options.client);
  const credential = readiness.providers.find((provider) => provider.provider_key === providerKey)?.credential ?? null;
  if (providerKey === "SHIPROCKET") return shiprocketSnapshot(merchantId, credential, options);
  return buildSnapshot({
    providerKey,
    checkedAt: options.checkedAt,
    credential,
    dimensions: dryRunProviderDimensions(providerKey, credential)
  });
}

export async function getCourierCertificationProvider(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: CertificationOptions = {}
) {
  const snapshot = await providerSnapshot(merchantId, providerKey, {
    ...options,
    client: options.client ?? prisma,
    checkedAt: options.checkedAt ?? new Date().toISOString()
  });
  return { provider: snapshot };
}

export async function listCourierCertificationProviders(
  merchantId: string,
  options: CertificationOptions = {}
) {
  const client = options.client ?? prisma;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const providerKeys = options.providerKey ? PROVIDERS.filter((providerKey) => providerKey === options.providerKey) : PROVIDERS;
  const snapshots = await Promise.all(providerKeys.map((providerKey) => providerSnapshot(merchantId, providerKey, {
    ...options,
    client,
    checkedAt
  })));
  const providers = snapshots.filter((provider) => {
    if (options.status && provider.status !== options.status) return false;
    if (options.capability && !provider.dimensions.some((dimension) => dimension.key === options.capability)) return false;
    return true;
  });
  return { providers };
}

export async function getCourierCertificationSummary(
  merchantId: string,
  options: CertificationOptions = {}
): Promise<CourierCertificationSummary> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const { providers } = await listCourierCertificationProviders(merchantId, {
    ...options,
    checkedAt
  });
  return serializeCourierCertificationSummary({
    merchant_id: merchantId,
    public_network_name: PUBLIC_NETWORK_NAME,
    checked_at: checkedAt,
    providers,
    counts: {
      total: providers.length,
      live_ready: providers.filter((provider) => provider.status === "READY_FOR_LIVE").length,
      pilot_ready: providers.filter((provider) => provider.status === "READY_FOR_PILOT").length,
      dry_run_ready: providers.filter((provider) => provider.status === "READY_FOR_DRY_RUN").length,
      blocked: providers.filter((provider) => provider.status === "BLOCKED").length,
      not_configured: providers.filter((provider) => provider.status === "NOT_CONFIGURED").length
    },
    blockers: unique(providers.flatMap((provider) => provider.blockers)),
    warnings: unique(providers.flatMap((provider) => provider.warnings)),
    next_actions: unique(providers.flatMap((provider) => provider.next_actions))
  });
}
