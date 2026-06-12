import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  resolveShiprocketLiveCredentials,
  ShiprocketCredentialResolutionError,
  type ShiprocketLiveCredentials
} from "../courierPartners/providers/shiprocket/shiprocket-live-credentials.js";
import {
  ShiprocketLiveClient,
  ShiprocketLiveProviderError,
  shiprocketLiveClientConfigFromEnv
} from "../courierPartners/providers/shiprocket/shiprocket-live.client.js";
import {
  mapShiprocketPickupListToSafePickups,
  type SafeShiprocketPickup
} from "../courierPartners/providers/shiprocket/shiprocket-live.mapper.js";
import { normalizeStateName } from "./shipping-indian-states.js";
import { getSellerShipment } from "./shipping-shipments.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ShiprocketPickupAlignmentStatus =
  | "SHIPROCKET_PICKUP_NOT_FOUND"
  | "SHIPROCKET_PICKUP_PINCODE_MISMATCH"
  | "SHIPROCKET_PICKUP_NOT_ACTIVE"
  | "SHIPROCKET_LIVE_PICKUP_UNAVAILABLE"
  | "SHIPROCKET_PICKUP_ALIGNED_BUT_UNAVAILABLE"
  | "SHIPROCKET_PICKUP_ALIGNED_READY";

type ShiprocketPickupClient = {
  login(credentials: ShiprocketLiveCredentials): Promise<{ token?: string; expires_in?: number; expiresIn?: number }>;
  listPickupLocations(token: string): Promise<Record<string, unknown>>;
};

type Source = Record<string, unknown>;

type ShipmastrPickupSummary = {
  pickupLocationId: string;
  name: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  active: boolean;
};

export type ShiprocketPickupSelectedContext =
  | "explicit_pickup"
  | "shipment_pickup"
  | "merchant_default_pickup"
  | "fallback_active_pickup";

type LiveRatePickupSummary = {
  found: boolean;
  pickupAvailable: boolean | null;
};

function sourceWithEnv(source?: Source) {
  return {
    ...env,
    ...(source ?? {})
  };
}

function metadataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isDefaultPickup(value: unknown) {
  return metadataObject(value).isDefault === true;
}

function strictBoolMetadata(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function isSmartRate(rate: { publicServiceCode?: string | null; publicServiceName?: string | null }) {
  return rate.publicServiceCode === "shipmastr_smart" || rate.publicServiceName === "Shipmastr Smart";
}

function pickupSummary(row: {
  id: string;
  label?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  status?: string | null;
  metadata?: unknown;
}): ShipmastrPickupSummary {
  return {
    pickupLocationId: row.id,
    name: row.label ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    pincode: row.pincode ?? null,
    active: row.status === "active"
  };
}

function normalizedText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function pincodeMatches(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left === right);
}

function cityStateMatch(shipmastr: ShipmastrPickupSummary, provider: SafeShiprocketPickup) {
  const cityMatches = !shipmastr.city || !provider.city || normalizedText(shipmastr.city) === normalizedText(provider.city);
  const providerState = provider.state ? normalizeStateName(provider.state) : null;
  const stateMatches = !shipmastr.state || !providerState || normalizeStateName(shipmastr.state) === providerState;
  return cityMatches && stateMatches;
}

function selectedRatePickupSummary(rate: { rateBreakup?: unknown } | null): LiveRatePickupSummary {
  if (!rate) {
    return { found: false, pickupAvailable: null };
  }
  const phase6 = metadataObject(metadataObject(rate.rateBreakup).phase6);
  return {
    found: true,
    pickupAvailable: strictBoolMetadata(phase6.pickupAvailable)
  };
}

function fallbackPickup(activePickups: Array<{
  id: string;
  label?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  status?: string | null;
  metadata?: unknown;
}>) {
  const defaultPickup = activePickups.find((pickup) => isDefaultPickup(pickup.metadata));
  return defaultPickup
    ? { selectedPickup: pickupSummary(defaultPickup), selectedContext: "merchant_default_pickup" as const }
    : {
      selectedPickup: activePickups[0] ? pickupSummary(activePickups[0]) : null,
      selectedContext: "fallback_active_pickup" as const
    };
}

async function getActiveShiprocketCredential(merchantId: string, client: Db) {
  const rows = await client.courierProviderCredential.findMany({
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
  });
  return rows[0] ?? null;
}

async function listProviderPickups(input: {
  merchantId: string;
  client: Db;
  source: Source;
  shiprocketClient?: ShiprocketPickupClient;
}) {
  const warnings: string[] = [];
  const credential = await getActiveShiprocketCredential(input.merchantId, input.client);
  if (!credential?.credentialRef) {
    return {
      credentialReady: false,
      pickups: [] as SafeShiprocketPickup[],
      warnings: ["LIVE_SHIPPING_PROVIDER_NOT_READY"]
    };
  }

  const shiprocketClient = input.shiprocketClient
    ?? new ShiprocketLiveClient(shiprocketLiveClientConfigFromEnv(input.source));

  try {
    const credentials = resolveShiprocketLiveCredentials(credential.credentialRef, input.source);
    const login = await shiprocketClient.login(credentials);
    if (!login.token) {
      return {
        credentialReady: true,
        pickups: [] as SafeShiprocketPickup[],
        warnings: ["SHIPROCKET_AUTH_FAILED"]
      };
    }
    const response = await shiprocketClient.listPickupLocations(login.token);
    return {
      credentialReady: true,
      pickups: mapShiprocketPickupListToSafePickups(response),
      warnings
    };
  } catch (error) {
    const code = error instanceof ShiprocketCredentialResolutionError
      ? error.code
      : error instanceof ShiprocketLiveProviderError
        ? error.code
        : "SHIPROCKET_PICKUP_LIST_FAILED";
    return {
      credentialReady: false,
      pickups: [] as SafeShiprocketPickup[],
      warnings: [code]
    };
  }
}

function alignmentFrom(input: {
  selectedPickup: ShipmastrPickupSummary | null;
  providerPickups: SafeShiprocketPickup[];
  liveRate: LiveRatePickupSummary;
}) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const selectedPickup = input.selectedPickup;
  const pincodeMatch = selectedPickup
    ? input.providerPickups.find((pickup) => pincodeMatches(selectedPickup.pincode, pickup.pincode) && cityStateMatch(selectedPickup, pickup)) ?? null
    : null;
  const pincodeOnlyMatch = selectedPickup
    ? input.providerPickups.find((pickup) => pincodeMatches(selectedPickup.pincode, pickup.pincode)) ?? null
    : null;

  if (!selectedPickup || !input.providerPickups.length) {
    blockers.push("SHIPROCKET_PICKUP_NOT_FOUND");
    return {
      status: "SHIPROCKET_PICKUP_NOT_FOUND" as const,
      matchedProviderPickup: null,
      providerPickupPincodeMatch: false,
      blockers,
      warnings
    };
  }

  if (!pincodeOnlyMatch) {
    blockers.push("SHIPROCKET_PICKUP_PINCODE_MISMATCH");
    return {
      status: "SHIPROCKET_PICKUP_PINCODE_MISMATCH" as const,
      matchedProviderPickup: null,
      providerPickupPincodeMatch: false,
      blockers,
      warnings
    };
  }

  if (!pincodeMatch) {
    warnings.push("SHIPROCKET_PICKUP_CITY_STATE_REVIEW_RECOMMENDED");
  }

  const matchedProviderPickup = pincodeMatch ?? pincodeOnlyMatch;
  if (matchedProviderPickup.active === false) {
    blockers.push("SHIPROCKET_PICKUP_NOT_ACTIVE");
    return {
      status: "SHIPROCKET_PICKUP_NOT_ACTIVE" as const,
      matchedProviderPickup,
      providerPickupPincodeMatch: true,
      blockers,
      warnings
    };
  }

  if (matchedProviderPickup.verified === false) {
    warnings.push("SHIPROCKET_PICKUP_VERIFICATION_PENDING_OR_UNKNOWN");
  }

  if (input.liveRate.found && input.liveRate.pickupAvailable !== true) {
    blockers.push("SHIPROCKET_LIVE_PICKUP_UNAVAILABLE");
    return {
      status: "SHIPROCKET_PICKUP_ALIGNED_BUT_UNAVAILABLE" as const,
      matchedProviderPickup,
      providerPickupPincodeMatch: true,
      blockers,
      warnings
    };
  }

  return {
    status: "SHIPROCKET_PICKUP_ALIGNED_READY" as const,
    matchedProviderPickup,
    providerPickupPincodeMatch: true,
    blockers,
    warnings
  };
}

export async function getShiprocketPickupDiagnostics(
  merchantId: string,
  options: {
    client?: Db;
    source?: Source;
    shipmentId?: string;
    pickupLocationId?: string;
    shiprocketClient?: ShiprocketPickupClient;
    includeProviderPickups?: boolean;
  } = {}
) {
  const client = options.client ?? prisma;
  const source = sourceWithEnv(options.source);
  const activePickups = await client.pickupLocation.findMany({
    where: {
      sellerId: merchantId,
      status: "active"
    },
    orderBy: { createdAt: "asc" }
  });
  let selectedPickup: ShipmastrPickupSummary | null = null;
  let selectedContext: ShiprocketPickupSelectedContext = "fallback_active_pickup";
  let liveRate: LiveRatePickupSummary = { found: false, pickupAvailable: null };

  if (options.pickupLocationId) {
    const pickup = await client.pickupLocation.findFirst({
      where: {
        id: options.pickupLocationId,
        sellerId: merchantId
      }
    });
    selectedPickup = pickup ? pickupSummary(pickup) : null;
    selectedContext = "explicit_pickup";
  } else if (options.shipmentId) {
    const shipment = await getSellerShipment(merchantId, options.shipmentId, client);
    if (shipment.pickupLocationId) {
      const pickup = await client.pickupLocation.findFirst({
        where: {
          id: shipment.pickupLocationId,
          sellerId: merchantId
        }
      });
      selectedPickup = pickup ? pickupSummary(pickup) : null;
      selectedContext = "shipment_pickup";
    }
    const rates = await client.shipmentRate.findMany({
      where: {
        shipmentId: shipment.id,
        sellerId: merchantId
      },
      orderBy: { createdAt: "desc" }
    });
    liveRate = selectedRatePickupSummary(rates.find(isSmartRate) ?? null);
    if (!selectedPickup) {
      const fallback = fallbackPickup(activePickups);
      selectedPickup = fallback.selectedPickup;
      selectedContext = fallback.selectedContext;
    }
  } else {
    const fallback = fallbackPickup(activePickups);
    selectedPickup = fallback.selectedPickup;
    selectedContext = fallback.selectedContext;
  }

  const provider = options.includeProviderPickups === false
    ? {
      credentialReady: false,
      pickups: [] as SafeShiprocketPickup[],
      warnings: ["SHIPROCKET_PICKUP_LIST_NOT_REQUESTED"]
    }
    : await listProviderPickups({
      merchantId,
      client,
      source,
      ...(options.shiprocketClient ? { shiprocketClient: options.shiprocketClient } : {})
    });

  const alignment = alignmentFrom({
    selectedPickup,
    providerPickups: provider.pickups,
    liveRate
  });

  return {
    merchantId,
    checkedAt: new Date().toISOString(),
    credentialReady: provider.credentialReady,
    shipmastrPickupCount: activePickups.length,
    providerPickupCount: provider.pickups.length,
    selectedContext,
    selectedPickup,
    liveRate,
    matchedProviderPickup: alignment.matchedProviderPickup,
    providerPickupPincodeMatch: alignment.providerPickupPincodeMatch,
    status: alignment.status as ShiprocketPickupAlignmentStatus,
    anyUsableProviderPickup: provider.pickups.some((pickup) => pickup.active !== false && pickup.pincode),
    blockers: [...new Set(alignment.blockers)],
    warnings: [...new Set([...provider.warnings, ...alignment.warnings])],
    pickups: provider.pickups
  };
}

export function serializeShiprocketPickupDiagnostics(
  diagnostics: Awaited<ReturnType<typeof getShiprocketPickupDiagnostics>>,
  options: { includePickups?: boolean } = {}
) {
  return {
    checked_at: diagnostics.checkedAt,
    credential_ready: diagnostics.credentialReady,
    count: diagnostics.providerPickupCount,
    shipmastr_pickup_count: diagnostics.shipmastrPickupCount,
    any_usable_pickup: diagnostics.anyUsableProviderPickup,
    status: diagnostics.status,
    selected_context: diagnostics.selectedContext,
    selected_shipmastr_pickup: diagnostics.selectedPickup ? {
      pickup_location_id: diagnostics.selectedPickup.pickupLocationId,
      name: diagnostics.selectedPickup.name,
      city: diagnostics.selectedPickup.city,
      state: diagnostics.selectedPickup.state,
      pincode: diagnostics.selectedPickup.pincode,
      active: diagnostics.selectedPickup.active
    } : null,
    provider_pickup_pincode_match: diagnostics.providerPickupPincodeMatch,
    live_rate_pickup_available: diagnostics.liveRate.pickupAvailable,
    blockers: diagnostics.blockers,
    warnings: diagnostics.warnings,
    ...(options.includePickups ? {
      pickups: diagnostics.pickups.map((pickup) => ({
        provider_pickup_id_present: pickup.providerPickupIdPresent,
        provider_pickup_id_suffix: pickup.providerPickupIdSuffix,
        pickup_name: pickup.pickupName,
        city: pickup.city,
        state: pickup.state,
        pincode: pickup.pincode,
        active: pickup.active,
        verified: pickup.verified,
        status_flags: pickup.statusFlags
      }))
    } : {})
  };
}
