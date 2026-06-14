import type { CourierCertificationDimension, CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import {
  getCourierCertificationProvider,
  getCourierCertificationSummary
} from "../certification/courier-certification.service.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import {
  serializeCourierOnboardingChecklist,
  serializeCourierOnboardingSummary
} from "./courier-onboarding.serializer.js";
import type {
  CourierOnboardingChecklist,
  CourierOnboardingStep,
  CourierOnboardingStepKey,
  CourierOnboardingStepStatus,
  CourierOnboardingSummary
} from "./courier-onboarding.types.js";

type OnboardingOptions = {
  includePickupProbe?: boolean;
  shipmentId?: string;
  pickupLocationId?: string;
  certification?: CourierCertificationSnapshot;
  certifications?: CourierCertificationSnapshot[];
};

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

const labels: Record<CourierOnboardingStepKey, string> = {
  CONNECT_CREDENTIALS: "Connect credentials",
  TEST_CREDENTIALS: "Test credentials",
  SYNC_PICKUPS: "Sync pickups",
  ALIGN_PICKUP: "Align pickup",
  RUN_SERVICEABILITY_PROBE: "Run serviceability probe",
  FETCH_LIVE_RATES: "Fetch live rates",
  VERIFY_COURIER_ID_MAPPING: "Verify courier id mapping",
  CERTIFY_AWB_ONE_SHOT: "Certify AWB one-shot",
  CERTIFY_LABEL: "Certify label",
  CERTIFY_TRACKING: "Certify tracking",
  CERTIFY_WEBHOOKS: "Certify webhooks",
  CERTIFY_PUBLIC_SAFETY: "Certify public safety",
  ENABLE_PILOT: "Enable pilot",
  ENABLE_LIVE: "Enable live"
};

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function dimension(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"]) {
  return snapshot.dimensions.find((item) => item.key === key) ?? null;
}

function certificationOptions(options: OnboardingOptions) {
  return {
    ...(options.includePickupProbe !== undefined ? { includePickupProbe: options.includePickupProbe } : {}),
    ...(options.shipmentId ? { shipmentId: options.shipmentId } : {}),
    ...(options.pickupLocationId ? { pickupLocationId: options.pickupLocationId } : {})
  };
}

function statusFromDimension(input: {
  dim: CourierCertificationDimension | null;
  dryRunOnly?: boolean;
  notSupportedOk?: boolean;
}): CourierOnboardingStepStatus {
  if (!input.dim) return input.dryRunOnly ? "TODO" : "BLOCKED";
  if (input.dim.status === "PASS") return "DONE";
  if (input.dim.status === "NOT_SUPPORTED") return input.notSupportedOk ? "NOT_SUPPORTED" : "TODO";
  if (input.dryRunOnly && input.dim.blockers.includes("PROVIDER_CREDENTIALS_MISSING")) return "TODO";
  if (input.dim.blockers.length) return "BLOCKED";
  if (input.dim.status === "WARN") return "READY";
  return "TODO";
}

function step(input: {
  key: CourierOnboardingStepKey;
  status: CourierOnboardingStepStatus;
  blockers?: string[];
  warnings?: string[];
  nextAction: string;
  safeSummary?: Record<string, unknown>;
}): CourierOnboardingStep {
  return {
    key: input.key,
    label_internal: labels[input.key],
    status: input.status,
    blockers: unique(input.blockers ?? []),
    warnings: unique(input.warnings ?? []),
    next_action: input.nextAction,
    safe_summary: input.safeSummary ?? {}
  };
}

function stepForDimension(input: {
  key: CourierOnboardingStepKey;
  dim: CourierCertificationDimension | null;
  dryRunOnly: boolean;
  nextAction: string;
  notSupportedOk?: boolean;
}): CourierOnboardingStep {
  return step({
    key: input.key,
    status: statusFromDimension({
      dim: input.dim,
      dryRunOnly: input.dryRunOnly,
      ...(input.notSupportedOk !== undefined ? { notSupportedOk: input.notSupportedOk } : {})
    }),
    blockers: input.dim?.blockers ?? [],
    warnings: input.dim?.warnings ?? [],
    nextAction: input.nextAction,
    safeSummary: input.dim?.safe_summary ?? {}
  });
}

export function buildCourierOnboardingChecklist(snapshot: CourierCertificationSnapshot): CourierOnboardingChecklist {
  const dryRunOnly = snapshot.status === "READY_FOR_DRY_RUN";
  const credentials = dimension(snapshot, "CREDENTIALS");
  const pickups = dimension(snapshot, "PICKUPS");
  const serviceability = dimension(snapshot, "SERVICEABILITY");
  const rates = dimension(snapshot, "RATES");
  const courierId = dimension(snapshot, "COURIER_ID_MAPPING");
  const awb = dimension(snapshot, "AWB");
  const label = dimension(snapshot, "LABEL");
  const tracking = dimension(snapshot, "TRACKING");
  const webhooks = dimension(snapshot, "WEBHOOKS");
  const publicSafety = dimension(snapshot, "PUBLIC_SAFETY");
  const steps: CourierOnboardingStep[] = [
    stepForDimension({
      key: "CONNECT_CREDENTIALS",
      dim: credentials,
      dryRunOnly,
      nextAction: dryRunOnly ? "Add live credential references when this provider enters pilot certification." : "Attach credential references."
    }),
    stepForDimension({
      key: "TEST_CREDENTIALS",
      dim: credentials,
      dryRunOnly,
      nextAction: "Run a non-destructive credential readiness probe."
    }),
    stepForDimension({
      key: "SYNC_PICKUPS",
      dim: pickups,
      dryRunOnly,
      nextAction: "Run an explicit pickup diagnostics check for the intended shipment or pickup."
    }),
    stepForDimension({
      key: "ALIGN_PICKUP",
      dim: pickups,
      dryRunOnly,
      nextAction: "Align the selected Shipmastr pickup with the provider pickup."
    }),
    stepForDimension({
      key: "RUN_SERVICEABILITY_PROBE",
      dim: serviceability,
      dryRunOnly,
      nextAction: "Run a safe serviceability probe or pilot live rate fetch."
    }),
    stepForDimension({
      key: "FETCH_LIVE_RATES",
      dim: rates,
      dryRunOnly,
      nextAction: "Fetch pilot live rates after pickup alignment passes."
    }),
    stepForDimension({
      key: "VERIFY_COURIER_ID_MAPPING",
      dim: courierId,
      dryRunOnly,
      nextAction: "Verify live rates produce a numeric internal courier mapping."
    }),
    stepForDimension({
      key: "CERTIFY_AWB_ONE_SHOT",
      dim: awb,
      dryRunOnly,
      nextAction: "Complete explicit one-shot AWB certification after pickup and rates pass."
    }),
    stepForDimension({
      key: "CERTIFY_LABEL",
      dim: label,
      dryRunOnly,
      nextAction: "Certify label retrieval with the one-shot live shipment path."
    }),
    stepForDimension({
      key: "CERTIFY_TRACKING",
      dim: tracking,
      dryRunOnly,
      nextAction: "Certify tracking sync/readiness before live tracking automation."
    }),
    stepForDimension({
      key: "CERTIFY_WEBHOOKS",
      dim: webhooks,
      dryRunOnly,
      nextAction: "Certify webhook readiness if the provider supports it.",
      notSupportedOk: true
    }),
    stepForDimension({
      key: "CERTIFY_PUBLIC_SAFETY",
      dim: publicSafety,
      dryRunOnly,
      nextAction: "Keep provider names, ids, and payloads out of seller responses."
    }),
    step({
      key: "ENABLE_PILOT",
      status: snapshot.status === "READY_FOR_PILOT" || snapshot.status === "READY_FOR_LIVE"
        ? "READY"
        : dryRunOnly ? "TODO" : "BLOCKED",
      blockers: snapshot.status === "READY_FOR_PILOT" || snapshot.status === "READY_FOR_LIVE" ? [] : snapshot.blockers,
      warnings: snapshot.warnings,
      nextAction: "Enable pilot only after credentials, pickup, rates, and courier id mapping pass.",
      safeSummary: { certification_status: snapshot.status }
    }),
    step({
      key: "ENABLE_LIVE",
      status: snapshot.status === "READY_FOR_LIVE" ? "READY" : "BLOCKED",
      blockers: snapshot.status === "READY_FOR_LIVE" ? [] : snapshot.blockers,
      warnings: snapshot.warnings,
      nextAction: "Enable live only after AWB, label, tracking, and public safety certification pass.",
      safeSummary: { certification_status: snapshot.status }
    })
  ];
  return serializeCourierOnboardingChecklist({
    provider_key: snapshot.provider_key,
    provider_label_internal: snapshot.provider_label_internal,
    public_network_name: PUBLIC_NETWORK_NAME,
    certification_status: snapshot.status,
    steps,
    blockers: snapshot.blockers,
    warnings: snapshot.warnings,
    next_actions: unique(steps.map((item) => item.status === "DONE" || item.status === "NOT_SUPPORTED" ? null : item.next_action)),
    checked_at: snapshot.checked_at
  });
}

export async function getCourierOnboardingProvider(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: OnboardingOptions = {}
) {
  const snapshot = options.certification ?? (await getCourierCertificationProvider(
    merchantId,
    providerKey,
    certificationOptions(options)
  )).provider;
  return { provider: buildCourierOnboardingChecklist(snapshot) };
}

export async function listCourierOnboardingProviders(
  merchantId: string,
  options: OnboardingOptions = {}
) {
  const snapshots = options.certifications ?? (await getCourierCertificationSummary(
    merchantId,
    certificationOptions(options)
  )).providers;
  return {
    providers: snapshots.map(buildCourierOnboardingChecklist)
  };
}

export async function getCourierOnboardingSummary(
  merchantId: string,
  options: OnboardingOptions = {}
): Promise<CourierOnboardingSummary> {
  const { providers } = await listCourierOnboardingProviders(merchantId, options);
  const checkedAt = providers[0]?.checked_at ?? new Date().toISOString();
  return serializeCourierOnboardingSummary({
    merchant_id: merchantId,
    public_network_name: PUBLIC_NETWORK_NAME,
    checked_at: checkedAt,
    providers,
    counts: {
      total_providers: providers.length,
      ready_for_pilot: providers.filter((provider) => provider.certification_status === "READY_FOR_PILOT").length,
      ready_for_live: providers.filter((provider) => provider.certification_status === "READY_FOR_LIVE").length,
      blocked: providers.filter((provider) => provider.certification_status === "BLOCKED").length,
      dry_run_only: providers.filter((provider) => provider.certification_status === "READY_FOR_DRY_RUN").length
    },
    blockers: unique(providers.flatMap((provider) => provider.blockers)),
    warnings: unique(providers.flatMap((provider) => provider.warnings)),
    next_actions: unique(providers.flatMap((provider) => provider.next_actions))
  });
}
