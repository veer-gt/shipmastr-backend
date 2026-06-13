import { Prisma } from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../providers/provider-adapter.types.js";
import { createShiprocketLiveAdapter } from "../providers/shiprocket/shiprocket-live.adapter.js";
import { toPrismaJson } from "../../shippingNetwork/shipping-public-serializers.js";
import {
  getLiveAwbLabelReadiness,
  type LiveAwbLabelReadiness
} from "../../shippingNetwork/shipping-live-ship-gate.service.js";
import { getSellerShipment } from "../../shippingNetwork/shipping-shipments.service.js";
import { getCourierCertificationProvider } from "../certification/courier-certification.service.js";
import type { CourierCertificationSnapshot } from "../certification/courier-certification.types.js";
import { getCourierLiveProviderDefinition } from "../liveReadiness/courier-live-readiness.providers.js";
import type { CourierLiveProviderKey } from "../liveReadiness/courier-live-readiness.types.js";
import type {
  CourierLabelCertificationBlocker,
  CourierLabelCertificationDryRunResult,
  CourierLabelCertificationLiveOneShotResult,
  CourierLabelCertificationProviderStatus,
  CourierLabelCertificationStatus
} from "./courier-label-certification.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type ShipmentRecord = Awaited<ReturnType<typeof getSellerShipment>>;

type ProviderRefRecord = {
  id: string;
  providerAwb?: string | null;
  providerOrderId?: string | null;
  providerShipmentId?: string | null;
  providerPickupId?: string | null;
  metadata?: unknown;
};
type Source = Record<string, unknown>;

const PUBLIC_NETWORK_NAME = "Shipmastr Courier Network" as const;

function unique<T extends string>(values: Array<T | null | undefined>) {
  return [...new Set(values.filter((value): value is T => Boolean(value)))];
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function phase6Metadata(shipment: ShipmentRecord) {
  return metadataObject(metadataObject(shipment.metadata).phase6);
}

function phase42pMetadata(shipment: ShipmentRecord) {
  return metadataObject(metadataObject(shipment.metadata).phase42p);
}

function phase42qMetadata(shipment: ShipmentRecord) {
  return metadataObject(metadataObject(shipment.metadata).phase42q);
}

function rawProviderLabelSafe(shipment: ShipmentRecord) {
  const labelUrl = stringValue(phase6Metadata(shipment).labelUrl);
  if (!labelUrl) return true;
  return !/shiprocket|shipmozo|bigship|provider|raw|token|secret|authorization|bearer/i.test(labelUrl);
}

function publicSafetyReady(snapshot: CourierCertificationSnapshot, shipment: ShipmentRecord) {
  const dimension = snapshot.dimensions.find((item) => item.key === "PUBLIC_SAFETY");
  return dimension?.status === "PASS" && rawProviderLabelSafe(shipment);
}

function providerRefReady(providerRef: ProviderRefRecord | null) {
  return Boolean(providerRef && (providerRef.providerOrderId || providerRef.providerShipmentId));
}

async function latestProviderRef(client: Db, shipmentId: string): Promise<ProviderRefRecord | null> {
  const model = (client as Db & { shipmentProviderRef?: { findFirst?: Function } }).shipmentProviderRef;
  if (!model?.findFirst) return null;
  return model.findFirst({
    where: { shipmentId },
    orderBy: { createdAt: "desc" }
  }) as Promise<ProviderRefRecord | null>;
}

function sellerMessage(input: { dryRunReady: boolean; liveOneShotReady: boolean; awbReady: boolean }) {
  if (!input.awbReady) return "Shipping label is not ready yet.";
  if (input.liveOneShotReady) return "Shipping setup is ready for a controlled label approval check.";
  if (input.dryRunReady) return "Shipping setup is still being verified.";
  return "Shipmastr will keep this shipment in review.";
}

function statusFor(input: {
  awbReady: boolean;
  providerRefsReady: boolean;
  dryRunReady: boolean;
  liveOneShotReady: boolean;
}): CourierLabelCertificationStatus {
  if (!input.awbReady) return "MISSING_AWB";
  if (!input.providerRefsReady) return "MISSING_PROVIDER_REFS";
  if (input.liveOneShotReady) return "READY_FOR_ONE_SHOT";
  if (input.dryRunReady) return "DRY_RUN_ONLY";
  return "BLOCKED";
}

function liveGateBlockers(readiness: LiveAwbLabelReadiness): CourierLabelCertificationBlocker[] {
  const blockers: CourierLabelCertificationBlocker[] = [];
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE") blockers.push("LABEL_CERTIFICATION_LIVE_MODE_DISABLED");
  if (!readiness.shiprocket.oneShotEnabled || !readiness.shiprocket.oneShotApprovalPresent) blockers.push("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  if (!readiness.shiprocket.allowedMerchantMatched) blockers.push("LABEL_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) blockers.push("LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  return blockers;
}

function boolValue(source: Source | undefined, key: string, fallback = false) {
  const value = source?.[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled", "live"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "disabled", ""].includes(normalized)) return false;
  }
  return fallback;
}

function sourceString(source: Source | undefined, key: string) {
  const value = source?.[key];
  return value === undefined || value === null ? "" : String(value).trim();
}

function sourceWithEnv(source?: Source) {
  return {
    ...env,
    ...(source ?? {})
  };
}

function labelApprovalPresent(source?: Source) {
  const token = sourceString(source, "SHIPMASTR_LIVE_SHIPROCKET_LABEL_ONE_SHOT_TOKEN");
  const header = sourceString(source, "SHIPMASTR_LIVE_SHIPROCKET_LABEL_ONE_SHOT_HEADER")
    || sourceString(source, "x-shipmastr-live-label-approval");
  return Boolean(token && header && token === header);
}

function labelLiveGateBlockers(readiness: LiveAwbLabelReadiness, source?: Source): CourierLabelCertificationBlocker[] {
  const blockers: CourierLabelCertificationBlocker[] = [];
  const labelEnabled = boolValue(source, "SHIPMASTR_ENABLE_LIVE_SHIPROCKET_LABEL", false);
  if (!readiness.runtime.enabled || readiness.runtime.mode !== "LIVE" || !labelEnabled) blockers.push("LABEL_CERTIFICATION_LIVE_MODE_DISABLED");
  if (!labelApprovalPresent(source)) blockers.push("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED");
  if (!readiness.shiprocket.allowedMerchantMatched) blockers.push("LABEL_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH");
  if (!readiness.shiprocket.allowedShipmentMatched) blockers.push("LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH");
  if (!readiness.shiprocket.credentialId || !readiness.shiprocket.credentialRefConfigured || !readiness.shiprocket.credentialResolved) {
    blockers.push("LABEL_CERTIFICATION_CREDENTIALS_NOT_READY");
  }
  return blockers;
}

function adminNextActions(blockers: CourierLabelCertificationBlocker[]) {
  const actions: string[] = [];
  if (blockers.includes("LABEL_CERTIFICATION_AWB_MISSING")) actions.push("Complete AWB certification before attempting label certification.");
  if (blockers.includes("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING")) actions.push("Confirm the shipment has safe internal provider references from AWB creation.");
  if (blockers.includes("LABEL_CERTIFICATION_CREDENTIALS_NOT_READY")) actions.push("Resolve live credential readiness before attempting label certification.");
  if (blockers.includes("LABEL_CERTIFICATION_ADAPTER_MISSING")) actions.push("Keep label certification blocked until the provider label adapter is ready.");
  if (blockers.includes("LABEL_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED")) actions.push("Provide explicit one-shot approval only after label dry-run readiness passes.");
  if (blockers.includes("LABEL_CERTIFICATION_ALLOWED_MERCHANT_MISMATCH")) actions.push("Align the pilot merchant allowlist before label certification.");
  if (blockers.includes("LABEL_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH")) actions.push("Align the pilot shipment allowlist before label certification.");
  if (blockers.includes("LABEL_CERTIFICATION_LIVE_MODE_DISABLED")) actions.push("Keep label certification in dry-run review until live label mode is explicitly enabled.");
  if (blockers.includes("LABEL_CERTIFICATION_PROVIDER_CALL_FAILED")) actions.push("Review the safe failure summary, fix the cause, then rerun the label one-shot only with explicit approval.");
  if (blockers.includes("LABEL_CERTIFICATION_PROVIDER_RESPONSE_INVALID")) actions.push("Keep label certification blocked until the provider label response mapper is fixed.");
  if (!actions.length) actions.push("Proceed only through the existing explicit Ship Now one-shot gate; this sandbox does not generate labels.");
  return unique(actions);
}

function providerLabelAdapterReady(providerKey: CourierLiveProviderKey, override?: boolean) {
  if (typeof override === "boolean") return override;
  return providerKey === "SHIPROCKET" && getCourierLiveProviderDefinition(providerKey).supportsAwbLabelReadiness;
}

function safeLabelRef(shipmentId: string) {
  const suffix = shipmentId.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase();
  return `SMLABEL-${suffix || "SHIPMENT"}`;
}

function existingLabelCertified(shipment: ShipmentRecord) {
  return Boolean(phase42qMetadata(shipment).labelCertified === true && stringValue(phase42qMetadata(shipment).labelRef));
}

function liveOneShotAdapter(input: {
  readiness: LiveAwbLabelReadiness;
  source?: Source;
  adapter?: InternalCourierProviderAdapter;
}) {
  if (input.adapter) return input.adapter;
  if (!input.readiness.shiprocket.credentialRef) throw new HttpError(409, "LABEL_CERTIFICATION_CREDENTIALS_NOT_READY");
  return createShiprocketLiveAdapter({
    credentialRef: input.readiness.shiprocket.credentialRef,
    source: input.source ?? {}
  });
}

function blockedResult(input: {
  providerKey: CourierLiveProviderKey;
  shipmentId: string;
  blockers: CourierLabelCertificationBlocker[];
  warnings?: string[];
  alreadyCertified?: boolean;
  labelRef?: string | null;
}): CourierLabelCertificationLiveOneShotResult {
  return {
    success: false,
    provider_key: input.providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: input.shipmentId,
    label_status: input.alreadyCertified ? "ALREADY_CERTIFIED" : "BLOCKED",
    public_label_status: input.alreadyCertified ? "READY" : "NOT_READY",
    shipmastr_label_ref: input.labelRef ?? null,
    tracking_ready: false,
    certification_status: input.alreadyCertified ? "ALREADY_CERTIFIED" : "BLOCKED",
    blockers: unique(input.blockers),
    warnings: unique(input.warnings ?? []),
    seller_safe_message: input.alreadyCertified ? "Shipping label will be available after shipment creation is certified." : "Shipping label is not ready yet.",
    admin_next_actions: adminNextActions(input.blockers)
  };
}

export async function getCourierLabelCertificationProviderStatus(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  options: { client?: Db } = {}
): Promise<CourierLabelCertificationProviderStatus> {
  const client = options.client ?? prisma;
  const { provider } = await getCourierCertificationProvider(merchantId, providerKey, {
    client,
    includePickupProbe: false
  });
  const labelDimension = provider.dimensions.find((dimension) => dimension.key === "LABEL");
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    sandbox_available: providerKey === "SHIPROCKET",
    status: providerKey === "SHIPROCKET" ? "READY_FOR_DRY_RUN" : "UNSUPPORTED",
    label_dimension_status: labelDimension?.status ?? "NOT_RUN",
    can_use_for_label: provider.can_use_for_label,
    blockers: providerKey === "SHIPROCKET" ? provider.blockers : ["LABEL_CERTIFICATION_ADAPTER_MISSING"],
    warnings: provider.warnings,
    next_actions: providerKey === "SHIPROCKET"
      ? ["Run the label certification sandbox after AWB exists and before any explicit label attempt."]
      : ["Keep this provider in safe review until label sandbox support is added."]
  };
}

export async function runCourierLabelCertificationDryRun(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: {
    shipmentId: string;
    pickupLocationId?: string;
  },
  options: {
    client?: Db;
    liveReadinessProvider?: () => Promise<LiveAwbLabelReadiness>;
    certificationProvider?: () => Promise<CourierCertificationSnapshot>;
    labelAdapterReady?: boolean;
  } = {}
): Promise<CourierLabelCertificationDryRunResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "LABEL_CERTIFICATION_PROVIDER_UNSUPPORTED");
  const client = options.client ?? prisma;
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const pickupLocationId = input.pickupLocationId ?? shipment.pickupLocationId ?? null;
  const [providerRef, readiness, snapshot] = await Promise.all([
    latestProviderRef(client, shipment.id),
    options.liveReadinessProvider
      ? options.liveReadinessProvider()
      : getLiveAwbLabelReadiness(merchantId, {
        client,
        shipmentId: shipment.id,
        includePickupAlignment: false
      }),
    options.certificationProvider
      ? options.certificationProvider()
      : getCourierCertificationProvider(merchantId, providerKey, {
        client,
        includePickupProbe: false,
        shipmentId: shipment.id,
        ...(pickupLocationId ? { pickupLocationId } : {})
      }).then((result) => result.provider)
  ]);

  const payloadReadiness = {
    awb_ready: Boolean(shipment.awbNumber),
    provider_refs_ready: providerRefReady(providerRef),
    label_adapter_ready: providerLabelAdapterReady(providerKey, options.labelAdapterReady),
    label_public_safety_ready: publicSafetyReady(snapshot, shipment),
    no_raw_provider_label_leak: rawProviderLabelSafe(shipment)
  };
  const blockers: CourierLabelCertificationBlocker[] = [];
  if (!payloadReadiness.awb_ready) blockers.push("LABEL_CERTIFICATION_AWB_MISSING");
  if (!payloadReadiness.provider_refs_ready) blockers.push("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING");
  if (!payloadReadiness.label_adapter_ready) blockers.push("LABEL_CERTIFICATION_ADAPTER_MISSING");
  if (!payloadReadiness.label_public_safety_ready) blockers.push("LABEL_CERTIFICATION_PUBLIC_SAFETY_NOT_READY");
  if (!payloadReadiness.no_raw_provider_label_leak) blockers.push("LABEL_CERTIFICATION_RAW_PROVIDER_URL_BLOCKED");
  const payloadBlockerCount = blockers.length;
  blockers.push(...liveGateBlockers(readiness));

  const dryRunReady = payloadBlockerCount === 0;
  const liveOneShotReady = dryRunReady && readiness.ready;
  const finalBlockers = unique(blockers);
  return {
    provider_key: providerKey,
    public_network_name: PUBLIC_NETWORK_NAME,
    shipment_id: shipment.id,
    pickup_location_id: pickupLocationId,
    dry_run_ready: dryRunReady,
    live_one_shot_ready: liveOneShotReady,
    status: statusFor({
      awbReady: payloadReadiness.awb_ready,
      providerRefsReady: payloadReadiness.provider_refs_ready,
      dryRunReady,
      liveOneShotReady
    }),
    payload_readiness: payloadReadiness,
    live_gate_readiness: {
      label_live_enabled: readiness.runtime.enabled,
      live_mode: readiness.runtime.mode === "LIVE",
      pilot_only: readiness.runtime.pilotOnly,
      allowed_merchant_matched: readiness.shiprocket.allowedMerchantMatched,
      allowed_shipment_matched: readiness.shiprocket.allowedShipmentMatched,
      approval_present: readiness.shiprocket.oneShotApprovalPresent,
      one_shot_ready: liveOneShotReady
    },
    blockers: finalBlockers,
    warnings: unique([
      ...readiness.warnings,
      "Label certification sandbox is read-only and does not generate labels."
    ]),
    seller_safe_message: sellerMessage({
      dryRunReady,
      liveOneShotReady,
      awbReady: payloadReadiness.awb_ready
    }),
    admin_next_actions: adminNextActions(finalBlockers)
  };
}

export async function runCourierLabelCertificationLiveOneShot(
  merchantId: string,
  providerKey: CourierLiveProviderKey,
  input: {
    shipmentId: string;
    operatorNote?: string | null;
  },
  options: {
    client?: Db;
    source?: Source;
    adapter?: InternalCourierProviderAdapter;
    liveReadinessProvider?: () => Promise<LiveAwbLabelReadiness>;
    certificationProvider?: () => Promise<CourierCertificationSnapshot>;
    labelAdapterReady?: boolean;
  } = {}
): Promise<CourierLabelCertificationLiveOneShotResult> {
  if (providerKey !== "SHIPROCKET") throw new HttpError(400, "LABEL_CERTIFICATION_PROVIDER_UNSUPPORTED");
  const client = options.client ?? prisma;
  const source = sourceWithEnv(options.source);
  const shipment = await getSellerShipment(merchantId, input.shipmentId, client);
  const existingLabelRef = stringValue(phase42qMetadata(shipment).labelRef);
  if (existingLabelCertified(shipment)) {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["LABEL_CERTIFICATION_EXISTING_LABEL_READY"],
      warnings: ["Existing label certification was found; no provider call was made."],
      alreadyCertified: true,
      labelRef: existingLabelRef
    });
  }

  const readinessProvider = options.liveReadinessProvider
    ? options.liveReadinessProvider
    : () => getLiveAwbLabelReadiness(merchantId, {
      client,
      shipmentId: shipment.id,
      includePickupAlignment: false,
      source
    });
  const dryRun = await runCourierLabelCertificationDryRun(merchantId, providerKey, {
    shipmentId: shipment.id
  }, {
    client,
    liveReadinessProvider: readinessProvider,
    ...(options.certificationProvider ? { certificationProvider: options.certificationProvider } : {}),
    ...(options.labelAdapterReady === undefined ? {} : { labelAdapterReady: options.labelAdapterReady })
  });
  const readiness = await readinessProvider();
  const payloadBlockers: CourierLabelCertificationBlocker[] = [];
  if (!dryRun.payload_readiness.awb_ready) payloadBlockers.push("LABEL_CERTIFICATION_AWB_MISSING");
  if (!dryRun.payload_readiness.provider_refs_ready) payloadBlockers.push("LABEL_CERTIFICATION_PROVIDER_REFS_MISSING");
  if (!dryRun.payload_readiness.label_adapter_ready) payloadBlockers.push("LABEL_CERTIFICATION_ADAPTER_MISSING");
  if (!dryRun.payload_readiness.label_public_safety_ready) payloadBlockers.push("LABEL_CERTIFICATION_PUBLIC_SAFETY_NOT_READY");
  if (!dryRun.payload_readiness.no_raw_provider_label_leak) payloadBlockers.push("LABEL_CERTIFICATION_RAW_PROVIDER_URL_BLOCKED");
  const blockers = unique([
    ...payloadBlockers,
    ...labelLiveGateBlockers(readiness, source)
  ]);
  if (blockers.length) {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers,
      warnings: dryRun.warnings
    });
  }

  const providerRef = await latestProviderRef(client, shipment.id);
  if (!providerRef?.providerOrderId && !providerRef?.providerShipmentId) {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["LABEL_CERTIFICATION_PROVIDER_REFS_MISSING"],
      warnings: ["Internal provider references are missing; no provider label call was made."]
    });
  }

  const adapter = liveOneShotAdapter({
    readiness,
    source,
    ...(options.adapter ? { adapter: options.adapter } : {})
  });

  try {
    const label = await adapter.getLabel({
      sellerId: merchantId,
      shipmentId: shipment.id,
      awb: shipment.awbNumber,
      trackingNumber: shipment.awbNumber,
      providerOrderId: providerRef.providerOrderId ?? null,
      providerShipmentId: providerRef.providerShipmentId ?? null
    });
    if (!label.labelUrl || /token|secret|authorization|bearer|raw/i.test(label.labelUrl)) {
      return blockedResult({
        providerKey,
        shipmentId: shipment.id,
        blockers: ["LABEL_CERTIFICATION_PROVIDER_RESPONSE_INVALID"],
        warnings: ["Provider label response was not safe to certify."]
      });
    }

    const labelRef = safeLabelRef(shipment.id);
    const metadata = metadataObject(shipment.metadata);
    await client.shipment.update({
      where: { id: shipment.id },
      data: {
        metadata: toPrismaJson({
          ...metadata,
          phase42p: phase42pMetadata(shipment),
          phase42q: {
            ...phase42qMetadata(shipment),
            labelCertified: true,
            labelCertifiedAt: new Date().toISOString(),
            labelRef,
            publicLabelReady: true,
            trackingCertified: false,
            operatorNote: input.operatorNote ?? null,
            rawProviderUrlStored: false,
            rawProviderResponseStored: false
          }
        })
      }
    });

    return {
      success: true,
      provider_key: providerKey,
      public_network_name: PUBLIC_NETWORK_NAME,
      shipment_id: shipment.id,
      label_status: "CERTIFIED",
      public_label_status: "READY",
      shipmastr_label_ref: labelRef,
      tracking_ready: false,
      certification_status: "LABEL_CERTIFIED",
      blockers: [],
      warnings: ["Label certification succeeded. Tracking certification remains separate."],
      seller_safe_message: "Shipping label will be available after shipment creation is certified.",
      admin_next_actions: ["Run tracking certification next; tracking remains blocked until its own certification passes."]
    };
  } catch {
    return blockedResult({
      providerKey,
      shipmentId: shipment.id,
      blockers: ["LABEL_CERTIFICATION_PROVIDER_CALL_FAILED"],
      warnings: ["Provider label call failed safely. No public label ready state was stored."]
    });
  }
}
