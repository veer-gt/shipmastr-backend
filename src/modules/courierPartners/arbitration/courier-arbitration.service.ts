import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import {
  getCourierCertificationProvider,
  listCourierCertificationProviders
} from "../certification/courier-certification.service.js";
import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import { getCourierCertificationDecision } from "../certification/courier-certification-decision.service.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import { diagnoseCourierPickupServiceability } from "../pickupServiceability/courier-pickup-serviceability.service.js";
import type { CourierPickupServiceabilityResult } from "../pickupServiceability/courier-pickup-serviceability.types.js";
import { createControlledCourierPickupTrial } from "../pickupTrial/courier-pickup-trial.service.js";
import type { CourierPickupTrialResult } from "../pickupTrial/courier-pickup-trial.types.js";
import type {
  CourierArbitrationCapability,
  CourierArbitrationDecision,
  CourierArbitrationEvaluatedOption,
  CourierArbitrationResult,
  CourierArbitrationSelectedOption
} from "./courier-arbitration.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

type PickupRecord = {
  id: string;
  sellerId?: string | null;
  pincode?: string | null;
  status?: string | null;
};

type ShipmentRecord = Awaited<ReturnType<typeof getSellerShipment>>;

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;
const PROVIDERS: CourierLiveProviderKey[] = ["SHIPROCKET", "BIGSHIP", "SHIPMOZO"];

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function selectedProvider(input?: CourierLiveProviderKey) {
  return input ?? "SHIPROCKET";
}

function capabilityReady(snapshot: CourierCertificationSnapshot, capability: CourierArbitrationCapability) {
  if (capability === "RATES") return snapshot.can_use_for_rates && snapshot.status !== "READY_FOR_DRY_RUN";
  if (capability === "AWB") return snapshot.can_use_for_awb;
  if (capability === "LABEL") return snapshot.can_use_for_label;
  return snapshot.can_use_for_tracking;
}

function capabilityBlockers(snapshot: CourierCertificationSnapshot, capability: CourierArbitrationCapability, existingAwb: boolean) {
  const blockers = [...snapshot.blockers];
  if (capability === "AWB" && existingAwb) blockers.push("SHIPMENT_AWB_ALREADY_EXISTS");
  if (capability === "AWB" && !snapshot.can_use_for_awb) blockers.push("PROVIDER_AWB_NOT_CERTIFIED");
  if (capability === "LABEL" && !snapshot.can_use_for_label) blockers.push("PROVIDER_LABEL_NOT_CERTIFIED");
  if (capability === "TRACKING" && !snapshot.can_use_for_tracking) blockers.push("PROVIDER_TRACKING_NOT_CERTIFIED");
  if (capability === "RATES" && !snapshot.can_use_for_rates) blockers.push("PROVIDER_RATES_NOT_LIVE");
  if (snapshot.status === "READY_FOR_DRY_RUN") blockers.push("PROVIDER_DRY_RUN_ONLY");
  return unique(blockers);
}

function selectedMessage(status: CourierArbitrationEvaluatedOption["status"]) {
  if (status === "READY") return "Shipmastr selected a safe shipping path for this shipment.";
  if (status === "DRY_RUN_ONLY") return "This shipping path is available for safe dry-run checks only.";
  if (status === "TRIAL_REQUIRED" || status === "NOT_CHECKED") return "Try another pickup location.";
  return "This shipment is not ready to ship yet.";
}

function decisionMessage(decision: CourierArbitrationDecision) {
  if (decision === "USE_SELECTED") return "Shipmastr selected a safe shipping path for this shipment.";
  if (decision === "TRY_ALTERNATE_PICKUP" || decision === "RUN_PICKUP_TRIAL") return "Try another pickup location.";
  if (decision === "TRY_ALTERNATE_PROVIDER") return "Shipmastr found another safe shipping path to review.";
  return "Shipmastr will keep this order in safe review.";
}

function nextActions(decision: CourierArbitrationDecision) {
  if (decision === "USE_SELECTED") return ["Continue controlled readiness checks for this shipment."];
  if (decision === "TRY_ALTERNATE_PICKUP") return ["Review the alternate pickup option before refreshing rates. Do not Ship Now until rates and certification are ready."];
  if (decision === "RUN_PICKUP_TRIAL") return ["Run a controlled alternate pickup trial. Do not Ship Now until the trial and certification pass."];
  if (decision === "TRY_ALTERNATE_PROVIDER") return ["Review the alternate provider path through certification before shipping."];
  return ["Keep this shipment in safe review."];
}

function publicOption(input: {
  providerKey: CourierLiveProviderKey;
  pickupLocationId?: string | null;
  pickupPincode?: string | null;
  publicServiceCode?: CourierArbitrationSelectedOption["public_service_code"];
}): CourierArbitrationSelectedOption {
  return {
    provider_key_internal: input.providerKey,
    pickup_location_id: input.pickupLocationId ?? null,
    pickup_pincode: input.pickupPincode ?? null,
    public_network_name: PUBLIC_NETWORK_NAME,
    ...(input.publicServiceCode ? { public_service_code: input.publicServiceCode } : {})
  };
}

function dimensionStatus(snapshot: CourierCertificationSnapshot, key: string) {
  return snapshot.dimensions.find((dimension) => dimension.key === key)?.status ?? "NOT_RUN";
}

async function activePickups(merchantId: string, client: Db): Promise<PickupRecord[]> {
  return client.pickupLocation.findMany({
    where: {
      sellerId: merchantId,
      status: "active"
    },
    orderBy: { createdAt: "asc" }
  }) as Promise<PickupRecord[]>;
}

function pickupById(pickups: PickupRecord[], pickupLocationId: string | null | undefined) {
  return pickups.find((pickup) => pickup.id === pickupLocationId) ?? null;
}

function selectedOptionStatus(input: {
  snapshot: CourierCertificationSnapshot;
  capability: CourierArbitrationCapability;
  serviceability: CourierPickupServiceabilityResult | null;
  existingAwb: boolean;
}) {
  if (input.snapshot.status === "READY_FOR_DRY_RUN") return "DRY_RUN_ONLY" as const;
  if (input.serviceability?.status === "PICKUP_UNAVAILABLE") return "BLOCKED" as const;
  if (input.serviceability && input.serviceability.status !== "PICKUP_AVAILABLE") return "BLOCKED" as const;
  if (capabilityReady(input.snapshot, input.capability) && !input.existingAwb) return "READY" as const;
  return "BLOCKED" as const;
}

async function selectedProviderOption(input: {
  merchantId: string;
  client: Db;
  shipment: ShipmentRecord;
  providerKey: CourierLiveProviderKey;
  pickupLocationId: string | null;
  requestedCapability: CourierArbitrationCapability;
  snapshot: CourierCertificationSnapshot;
  pickup: PickupRecord | null;
}) {
  const serviceability = input.providerKey === "SHIPROCKET"
    ? await diagnoseCourierPickupServiceability(input.merchantId, {
      providerKey: input.providerKey,
      shipmentId: input.shipment.id,
      ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {})
    }, { client: input.client })
    : null;
  const status = selectedOptionStatus({
    snapshot: input.snapshot,
    capability: input.requestedCapability,
    serviceability,
    existingAwb: Boolean(input.shipment.awbNumber)
  });
  const blockers = unique([
    ...capabilityBlockers(input.snapshot, input.requestedCapability, Boolean(input.shipment.awbNumber)),
    ...(serviceability?.blockers ?? [])
  ]);
  return {
    option: {
      provider_key_internal: input.providerKey,
      pickup_location_id: input.pickupLocationId,
      pickup_pincode: input.pickup?.pincode ?? input.shipment.fromPincode ?? null,
      status,
      blockers,
      warnings: unique([...(input.snapshot.warnings ?? []), ...(serviceability?.warnings ?? [])]),
      seller_safe_message: selectedMessage(status)
    } satisfies CourierArbitrationEvaluatedOption,
    serviceability
  };
}

function trialStatus(trial: CourierPickupTrialResult, snapshot: CourierCertificationSnapshot, capability: CourierArbitrationCapability) {
  if (trial.status === "DRY_RUN_ONLY") return "TRIAL_REQUIRED" as const;
  if (trial.status === "ELIGIBLE_RATES_FOUND") {
    return capability === "RATES" && snapshot.can_use_for_rates ? "READY" as const : "TRIAL_REQUIRED" as const;
  }
  if (trial.status === "NO_PROVIDER_CANDIDATES") return "NOT_CHECKED" as const;
  return "BLOCKED" as const;
}

async function alternatePickupOptions(input: {
  merchantId: string;
  client: Db;
  shipment: ShipmentRecord;
  providerKey: CourierLiveProviderKey;
  selectedPickupId: string | null;
  requestedCapability: CourierArbitrationCapability;
  snapshot: CourierCertificationSnapshot;
  pickups: PickupRecord[];
}) {
  if (input.providerKey !== "SHIPROCKET") return [];
  const alternates = input.pickups.filter((pickup) => pickup.id !== input.selectedPickupId);
  const rows: CourierArbitrationEvaluatedOption[] = [];
  for (const pickup of alternates) {
    const trial = await createControlledCourierPickupTrial(input.merchantId, {
      providerKey: input.providerKey,
      shipmentId: input.shipment.id,
      pickupLocationId: pickup.id,
      mode: "DRY_RUN"
    }, { client: input.client });
    const status = trialStatus(trial, input.snapshot, input.requestedCapability);
    rows.push({
      provider_key_internal: input.providerKey,
      pickup_location_id: pickup.id,
      pickup_pincode: pickup.pincode ?? null,
      status,
      blockers: unique([
        ...trial.blockers,
        ...capabilityBlockers(input.snapshot, input.requestedCapability, Boolean(input.shipment.awbNumber))
      ]),
      warnings: trial.warnings,
      seller_safe_message: status === "TRIAL_REQUIRED"
        ? "Try another pickup location."
        : trial.seller_safe_message
    });
  }
  return rows;
}

function alternateProviderOptions(input: {
  selectedProviderKey: CourierLiveProviderKey;
  selectedPickupId: string | null;
  selectedPickup: PickupRecord | null;
  requestedCapability: CourierArbitrationCapability;
  snapshots: CourierCertificationSnapshot[];
  existingAwb: boolean;
}) {
  return input.snapshots
    .filter((snapshot) => snapshot.provider_key !== input.selectedProviderKey)
    .map((snapshot): CourierArbitrationEvaluatedOption => {
      const ready = capabilityReady(snapshot, input.requestedCapability) && !input.existingAwb;
      const status = ready
        ? "READY"
        : snapshot.status === "READY_FOR_DRY_RUN"
          ? "DRY_RUN_ONLY"
          : "BLOCKED";
      return {
        provider_key_internal: snapshot.provider_key,
        pickup_location_id: input.selectedPickupId,
        pickup_pincode: input.selectedPickup?.pincode ?? null,
        status,
        blockers: capabilityBlockers(snapshot, input.requestedCapability, input.existingAwb),
        warnings: snapshot.warnings,
        seller_safe_message: selectedMessage(status)
      };
    });
}

function chooseDecision(input: {
  selected: CourierArbitrationEvaluatedOption;
  alternatePickups: CourierArbitrationEvaluatedOption[];
  alternateProviders: CourierArbitrationEvaluatedOption[];
}): { decision: CourierArbitrationDecision; selectedOption: CourierArbitrationEvaluatedOption | null } {
  if (input.selected.status === "READY") return { decision: "USE_SELECTED", selectedOption: input.selected };
  const readyPickup = input.alternatePickups.find((option) => option.status === "READY");
  if (readyPickup) return { decision: "TRY_ALTERNATE_PICKUP", selectedOption: readyPickup };
  const trialPickup = input.alternatePickups.find((option) => option.status === "TRIAL_REQUIRED" || option.status === "NOT_CHECKED");
  if (trialPickup) return { decision: "RUN_PICKUP_TRIAL", selectedOption: trialPickup };
  const readyProvider = input.alternateProviders.find((option) => option.status === "READY");
  if (readyProvider) return { decision: "TRY_ALTERNATE_PROVIDER", selectedOption: readyProvider };
  return { decision: "SAFE_REVIEW", selectedOption: null };
}

export async function arbitrateCourierPickup(
  merchantId: string,
  input: {
    shipmentId: string;
    requestedCapability: CourierArbitrationCapability;
    preferredProviderKey?: CourierLiveProviderKey;
    pickupLocationId?: string;
  },
  options: {
    client?: Db;
    certificationProvider?: (context: {
      merchantId: string;
      shipmentId: string;
      pickupLocationId: string | null;
    }) => Promise<{ providers: CourierCertificationSnapshot[] }>;
  } = {}
): Promise<CourierArbitrationResult> {
  const client = options.client ?? prisma;
  const providerKey = selectedProvider(input.preferredProviderKey);
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const pickupLocationId = input.pickupLocationId ?? shipment.pickupLocationId ?? null;
  const pickups = await activePickups(merchantId, client);
  const selectedPickup = pickupById(pickups, pickupLocationId);
  const { providers } = options.certificationProvider
    ? await options.certificationProvider({ merchantId, shipmentId: shipment.id, pickupLocationId })
    : await listCourierCertificationProviders(merchantId, {
      client,
      includePickupProbe: false,
      shipmentId: shipment.id,
      ...(pickupLocationId ? { pickupLocationId } : {})
    });
  const selectedSnapshot = providers.find((provider) => provider.provider_key === providerKey)
    ?? (await getCourierCertificationProvider(merchantId, providerKey, {
      client,
      includePickupProbe: false,
      shipmentId: shipment.id,
      ...(pickupLocationId ? { pickupLocationId } : {})
    })).provider;
  const certificationDecision = await getCourierCertificationDecision({
    merchantId,
    providerKey,
    requestedCapability: input.requestedCapability
  }, {
    certification: selectedSnapshot,
    oneShotPilotGatePassed: false,
    existingAwb: Boolean(shipment.awbNumber)
  });
  const selected = await selectedProviderOption({
    merchantId,
    client,
    shipment,
    providerKey,
    pickupLocationId,
    requestedCapability: input.requestedCapability,
    snapshot: selectedSnapshot,
    pickup: selectedPickup
  });
  if (certificationDecision.blockers.length) {
    selected.option.blockers = unique([...selected.option.blockers, ...certificationDecision.blockers]);
  }
  const alternatePickups = await alternatePickupOptions({
    merchantId,
    client,
    shipment,
    providerKey,
    selectedPickupId: pickupLocationId,
    requestedCapability: input.requestedCapability,
    snapshot: selectedSnapshot,
    pickups
  });
  const alternateProviders = alternateProviderOptions({
    selectedProviderKey: providerKey,
    selectedPickupId: pickupLocationId,
    selectedPickup,
    requestedCapability: input.requestedCapability,
    snapshots: providers.filter((provider) => PROVIDERS.includes(provider.provider_key)),
    existingAwb: Boolean(shipment.awbNumber)
  });
  const selection = chooseDecision({
    selected: selected.option,
    alternatePickups,
    alternateProviders
  });
  const evaluatedOptions = [selected.option, ...alternatePickups, ...alternateProviders];
  const blockers = unique(
    selection.decision === "SAFE_REVIEW"
      ? evaluatedOptions.flatMap((option) => option.blockers)
      : selection.selectedOption?.blockers ?? selected.option.blockers
  );
  const warnings = unique(evaluatedOptions.flatMap((option) => option.warnings));
  return {
    shipment_id: shipment.id,
    requested_capability: input.requestedCapability,
    decision: selection.decision,
    selected_option: selection.selectedOption
      ? publicOption({
        providerKey: selection.selectedOption.provider_key_internal,
        pickupLocationId: selection.selectedOption.pickup_location_id,
        pickupPincode: selection.selectedOption.pickup_pincode,
        publicServiceCode: "shipmastr_smart"
      })
      : null,
    evaluated_options: evaluatedOptions,
    blockers,
    warnings,
    seller_safe_message: decisionMessage(selection.decision),
    admin_next_actions: nextActions(selection.decision)
  };
}

export const __courierArbitrationInternals = {
  capabilityReady,
  dimensionStatus
};
