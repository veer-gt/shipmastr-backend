import {
  CourierPartnerStatus,
  PartnerType,
  Prisma,
  SellerCourierPartnerStatus,
  ShipmentSegment
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  DEFAULT_SYSTEM_COURIER_PARTNER,
  SHIPMASTR_PUBLIC_COURIER_NETWORK
} from "./courier-partners.config.js";

type Db = Prisma.TransactionClient | typeof prisma;

type CourierPartnerRecord = {
  id: string;
  code: string;
  name: string;
  isSystemManaged?: boolean | null;
};

export type SellerCourierPartnerRecord = {
  id: string;
  sellerId: string;
  courierPartnerId: string;
  status: SellerCourierPartnerStatus | string;
  partnerType: PartnerType | string;
  credentialsRequiredFromSeller: boolean;
  country: string;
  enabledSegments?: ShipmentSegment[] | string[];
  displayCode?: string | null;
  displayName?: string | null;
  courierPartner?: CourierPartnerRecord | null;
};

export type AutoEnableCourierPartnersInput = {
  sellerId: string;
  country: string;
  segments: string[];
};

export type AutoEnableCourierPartnersResult = {
  enabled: SellerCourierPartnerRecord[];
  skipped: Array<{
    reason: "already_enabled";
    mapping: SellerCourierPartnerRecord;
  }>;
};

export type PublicCourierPartnerSummary = {
  partner_code: string;
  partner_name: string;
  status: string;
  partner_type: string;
};

const shipmentSegmentValues = new Set<string>(Object.values(ShipmentSegment));

function normalizeCountry(country: string) {
  return country.trim().toUpperCase();
}

function normalizeSegments(segments: string[]) {
  const normalized: ShipmentSegment[] = [];

  for (const segment of segments) {
    const candidate = segment.trim().toLowerCase();
    if (shipmentSegmentValues.has(candidate) && !normalized.includes(candidate as ShipmentSegment)) {
      normalized.push(candidate as ShipmentSegment);
    }
  }

  return normalized;
}

function segmentIntersection(left: readonly ShipmentSegment[], right: readonly ShipmentSegment[]) {
  return left.filter((segment) => right.includes(segment));
}

export function getInternalCourierPartnerCode(mapping: {
  courierPartner?: { code?: string | null } | null;
}) {
  return mapping.courierPartner?.code ?? null;
}

export function serializePublicCourierPartnerMapping(
  mapping: SellerCourierPartnerRecord
): PublicCourierPartnerSummary {
  return {
    partner_code: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerCode,
    partner_name: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerName,
    status: String(mapping.status),
    partner_type: String(mapping.partnerType)
  };
}

export function serializePublicAutoEnableResult(result: AutoEnableCourierPartnersResult) {
  return {
    enabled: result.enabled.map(serializePublicCourierPartnerMapping),
    skipped: result.skipped.map((entry) => ({
      ...serializePublicCourierPartnerMapping(entry.mapping),
      reason: entry.reason
    }))
  };
}

export function autoEnableCourierPartnersMessage(result: AutoEnableCourierPartnersResult) {
  if (result.enabled.length === 0 && result.skipped.length === 0) {
    return "No eligible courier partners found.";
  }

  return "Courier partners enabled successfully.";
}

export async function autoEnableCourierPartners(
  input: AutoEnableCourierPartnersInput,
  client: Db = prisma
): Promise<AutoEnableCourierPartnersResult> {
  const sellerId = input.sellerId.trim();
  const country = normalizeCountry(input.country);
  const segments = normalizeSegments(input.segments);

  if (!sellerId || !country || segments.length === 0) {
    return { enabled: [], skipped: [] };
  }

  const partners = await client.courierPartner.findMany({
    where: {
      active: true,
      status: CourierPartnerStatus.active,
      isSystemManaged: true,
      defaultForNewSellers: true,
      credentialsRequiredFromSeller: false,
      country,
      supportedSegments: {
        hasSome: segments
      }
    },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" }
    ]
  });

  const enabled: SellerCourierPartnerRecord[] = [];
  const skipped: AutoEnableCourierPartnersResult["skipped"] = [];

  for (const partner of partners) {
    const existing = await client.sellerCourierPartner.findUnique({
      where: {
        sellerId_courierPartnerId: {
          sellerId,
          courierPartnerId: partner.id
        }
      },
      include: {
        courierPartner: true
      }
    });

    if (existing) {
      skipped.push({
        reason: "already_enabled",
        mapping: existing as SellerCourierPartnerRecord
      });
      continue;
    }

    const enabledSegments = segmentIntersection(partner.supportedSegments, segments);
    const mapping = await client.sellerCourierPartner.create({
      data: {
        sellerId,
        courierPartnerId: partner.id,
        status: SellerCourierPartnerStatus.active,
        partnerType: PartnerType.system_managed,
        credentialsRequiredFromSeller: false,
        enabledSegments,
        country,
        displayCode: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerCode,
        displayName: SHIPMASTR_PUBLIC_COURIER_NETWORK.partnerName
      },
      include: {
        courierPartner: true
      }
    });

    enabled.push(mapping as SellerCourierPartnerRecord);
  }

  return { enabled, skipped };
}

export function defaultSystemCourierPartnerSeed() {
  return DEFAULT_SYSTEM_COURIER_PARTNER;
}
