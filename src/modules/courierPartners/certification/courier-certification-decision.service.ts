import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import {
  getCourierCertificationProvider
} from "./courier-certification.service.js";
import type {
  CourierCertificationDimension,
  CourierCertificationSnapshot
} from "./courier-certification.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const courierCertificationDecisionCapabilities = ["RATES", "AWB", "LABEL", "TRACKING", "WEBHOOKS"] as const;
export type CourierCertificationDecisionCapability = typeof courierCertificationDecisionCapabilities[number];

export type CourierCertificationDecision = {
  allowed: boolean;
  decision: "ALLOW" | "BLOCK" | "FALLBACK" | "DRY_RUN_ONLY";
  provider_key_internal: CourierLiveProviderKey;
  public_network_name: "Shipmastr Courier Network";
  requested_capability: CourierCertificationDecisionCapability;
  blockers: string[];
  warnings: string[];
  seller_safe_message: string;
  admin_next_actions: string[];
};

type DecisionOptions = {
  client?: Db;
  certification?: CourierCertificationSnapshot;
  includePickupProbe?: boolean;
  shipmentId?: string;
  pickupLocationId?: string;
  existingAwb?: boolean;
  oneShotPilotGatePassed?: boolean;
};

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function dimension(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"]) {
  return snapshot.dimensions.find((item) => item.key === key) ?? null;
}

function dimensionPass(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"]) {
  return dimension(snapshot, key)?.status === "PASS";
}

function dimensionBlockers(snapshot: CourierCertificationSnapshot, key: CourierCertificationDimension["key"]) {
  return dimension(snapshot, key)?.blockers ?? [];
}

function capabilityBlockers(
  snapshot: CourierCertificationSnapshot,
  requestedCapability: CourierCertificationDecisionCapability,
  options: { oneShotPilotGatePassed?: boolean } = {}
) {
  if (snapshot.status === "NOT_CONFIGURED") return ["PROVIDER_CREDENTIALS_MISSING"];

  if (requestedCapability === "RATES") {
    return unique([
      ...dimensionBlockers(snapshot, "PICKUPS"),
      ...dimensionBlockers(snapshot, "RATES"),
      ...dimensionBlockers(snapshot, "COURIER_ID_MAPPING"),
      ...(!dimensionPass(snapshot, "PICKUPS") ? ["PROVIDER_PICKUP_NOT_FOUND"] : []),
      ...(!snapshot.can_use_for_rates ? ["PROVIDER_RATES_NOT_LIVE"] : [])
    ]);
  }

  if (requestedCapability === "AWB") {
    const awbCertifiedOrOneShot = snapshot.can_use_for_awb || options.oneShotPilotGatePassed === true;
    return unique([
      ...dimensionBlockers(snapshot, "CREDENTIALS"),
      ...dimensionBlockers(snapshot, "PICKUPS"),
      ...dimensionBlockers(snapshot, "RATES"),
      ...dimensionBlockers(snapshot, "COURIER_ID_MAPPING"),
      ...(!dimensionPass(snapshot, "CREDENTIALS") ? ["PROVIDER_CREDENTIALS_MISSING"] : []),
      ...(!dimensionPass(snapshot, "PICKUPS") ? ["PROVIDER_PICKUP_NOT_FOUND"] : []),
      ...(!dimensionPass(snapshot, "RATES") ? ["PROVIDER_RATES_NOT_LIVE"] : []),
      ...(!dimensionPass(snapshot, "COURIER_ID_MAPPING") ? ["PROVIDER_COURIER_ID_MISSING"] : []),
      ...(!awbCertifiedOrOneShot ? ["PROVIDER_AWB_NOT_CERTIFIED", "PROVIDER_LIVE_ONE_SHOT_REQUIRED"] : [])
    ]);
  }

  if (requestedCapability === "LABEL") {
    return unique([
      ...dimensionBlockers(snapshot, "LABEL"),
      ...(!snapshot.can_use_for_label ? ["PROVIDER_LABEL_NOT_CERTIFIED"] : [])
    ]);
  }

  if (requestedCapability === "TRACKING") {
    return unique([
      ...dimensionBlockers(snapshot, "TRACKING"),
      ...(!snapshot.can_use_for_tracking ? ["PROVIDER_TRACKING_NOT_CERTIFIED"] : [])
    ]);
  }

  const webhook = dimension(snapshot, "WEBHOOKS");
  if (webhook?.status === "PASS") return [];
  if (webhook?.status === "NOT_SUPPORTED") return ["PROVIDER_WEBHOOKS_NOT_SUPPORTED"];
  return ["PROVIDER_WEBHOOKS_NOT_CERTIFIED"];
}

function adminNextActions(snapshot: CourierCertificationSnapshot, blockers: string[]) {
  return unique([
    ...snapshot.next_actions,
    ...blockers.map((blocker) => {
      if (blocker === "SHIPMENT_ALREADY_HAS_AWB") return "Use the existing shipment AWB instead of creating another.";
      if (blocker.includes("PICKUP")) return "Align the selected Shipmastr pickup with the provider pickup.";
      if (blocker.includes("RATES")) return "Fetch and certify pilot live rates for the selected pickup.";
      if (blocker.includes("COURIER_ID")) return "Verify live rates provide the internal courier id mapping.";
      if (blocker.includes("AWB")) return "Complete explicit one-shot AWB certification before live Ship Now.";
      if (blocker.includes("LABEL")) return "Certify label retrieval after AWB certification.";
      if (blocker.includes("TRACKING")) return "Certify tracking readiness before tracking automation.";
      return "Review courier certification blockers.";
    })
  ]);
}

function sellerSafeMessage(decision: CourierCertificationDecision["decision"]) {
  if (decision === "ALLOW") {
    return "This shipping option is ready for the requested Shipmastr action.";
  }
  if (decision === "DRY_RUN_ONLY") {
    return "This shipping option is available for safe dry-run checks only.";
  }
  if (decision === "FALLBACK") {
    return "Shipmastr will evaluate another safe shipping path for this order.";
  }
  return "This shipping option is not ready yet. Shipmastr will keep the order in a safe review state.";
}

export async function getCourierCertificationDecision(input: {
  merchantId: string;
  providerKey: CourierLiveProviderKey;
  requestedCapability: CourierCertificationDecisionCapability;
  shipmentId?: string;
  pickupLocationId?: string;
}, options: DecisionOptions = {}): Promise<CourierCertificationDecision> {
  const client = options.client ?? prisma;
  const snapshot = options.certification ?? (await getCourierCertificationProvider(input.merchantId, input.providerKey, {
    client,
    ...(options.includePickupProbe !== undefined ? { includePickupProbe: options.includePickupProbe } : {}),
    ...(input.shipmentId ? { shipmentId: input.shipmentId } : {}),
    ...(input.pickupLocationId ? { pickupLocationId: input.pickupLocationId } : {})
  })).provider;

  let existingAwb = options.existingAwb ?? false;
  if (input.shipmentId && options.existingAwb === undefined && ["AWB", "LABEL"].includes(input.requestedCapability)) {
    const shipment = await getSellerShipment(input.merchantId, input.shipmentId, client);
    existingAwb = Boolean(shipment.awbNumber);
  }

  const blockers = unique([
    ...capabilityBlockers(snapshot, input.requestedCapability, {
      ...(options.oneShotPilotGatePassed !== undefined ? { oneShotPilotGatePassed: options.oneShotPilotGatePassed } : {})
    }),
    ...(input.requestedCapability === "AWB" && existingAwb ? ["SHIPMENT_ALREADY_HAS_AWB"] : [])
  ]);

  let decision: CourierCertificationDecision["decision"] = "BLOCK";
  let allowed = false;
  if (snapshot.status === "READY_FOR_DRY_RUN") {
    decision = "DRY_RUN_ONLY";
  } else if (!blockers.length) {
    decision = "ALLOW";
    allowed = true;
  } else if (input.requestedCapability === "RATES") {
    decision = "FALLBACK";
  }

  return {
    allowed,
    decision,
    provider_key_internal: input.providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    requested_capability: input.requestedCapability,
    blockers,
    warnings: unique(snapshot.warnings),
    seller_safe_message: sellerSafeMessage(decision),
    admin_next_actions: adminNextActions(snapshot, blockers)
  };
}

export function serializeCourierCertificationDecision(decision: CourierCertificationDecision) {
  return {
    allowed: decision.allowed,
    decision: decision.decision,
    provider_key_internal: decision.provider_key_internal,
    public_network_name: PUBLIC_NETWORK_NAME,
    requested_capability: decision.requested_capability,
    blockers: decision.blockers,
    warnings: decision.warnings,
    seller_safe_message: decision.seller_safe_message,
    admin_next_actions: decision.admin_next_actions
  };
}

export function sellerSafeCourierCertificationDecision(decision: CourierCertificationDecision) {
  return {
    allowed: decision.allowed,
    decision: decision.decision,
    public_network_name: PUBLIC_NETWORK_NAME,
    requested_capability: decision.requested_capability,
    seller_safe_message: decision.seller_safe_message
  };
}
