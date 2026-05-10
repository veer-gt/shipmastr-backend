import {
  MerchantAdminStatus,
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  SellerKycStatus,
  type Merchant,
  type Prisma
} from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { normalizeOptionalGstin } from "../../../lib/gstin.js";
import { HttpError } from "../../../lib/httpError.js";
import { redactPanText } from "../../../lib/pan.js";
import { audit } from "../../audit/audit.service.js";
import { buildMerchantOnboardingProjection } from "../../onboarding/onboarding.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

const sellerInclude = {
  users: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      userType: true,
      createdAt: true,
      updatedAt: true
    }
  },
  leads: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      businessName: true,
      phone: true,
      email: true,
      monthlyShipments: true,
      currentProvider: true,
      biggestIssue: true,
      notes: true,
      status: true,
      createdAt: true,
      updatedAt: true
    }
  },
  firstShipmentRequests: {
    orderBy: { createdAt: "desc" },
    include: {
      requester: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  }
} satisfies Prisma.MerchantInclude;

type SellerMerchant = Prisma.MerchantGetPayload<{ include: typeof sellerInclude }>;

export type AdminSellerPatch = {
  gstin?: string | null;
  adminStatus?: MerchantAdminStatus;
  adminNotes?: string | null;
  onboardingNotes?: string | null;
  sellerKycStatus?: SellerKycStatus;
  sellerKycChecklist?: unknown;
  sellerKycNotes?: string | null;
};

const sellerKycChecklistStatuses = new Set(["PENDING", "IN_PROGRESS", "COMPLETED", "BLOCKED"]);

export const sellerKycChecklistDefinitions = [
  { key: "gstinPan", label: "GSTIN/PAN" },
  { key: "pickupAddress", label: "Pickup address" },
  { key: "contact", label: "Contact" },
  { key: "bankRemittance", label: "Bank/remittance" },
  { key: "businessProof", label: "Business proof" },
  { key: "riskNotes", label: "Risk notes" }
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanOptional(value?: string | null) {
  return redactPanText(value);
}

function cleanChecklistText(value: unknown) {
  if (typeof value !== "string") return null;
  return redactPanText(value);
}

function cleanChecklistStatus(value: unknown, fallback = "PENDING") {
  if (typeof value !== "string") return fallback;
  return sellerKycChecklistStatuses.has(value) ? value : fallback;
}

export function normalizeSellerKycChecklist(value: unknown) {
  const source = isRecord(value) ? value : {};

  return sellerKycChecklistDefinitions.map((definition) => {
    const rawEntry = source[definition.key];
    const entry: Record<string, unknown> = isRecord(rawEntry) ? rawEntry : {};

    return {
      key: definition.key,
      label: definition.label,
      status: cleanChecklistStatus(entry.status),
      owner: cleanChecklistText(entry.owner),
      notes: cleanChecklistText(entry.notes),
      evidenceUrl: cleanChecklistText(entry.evidenceUrl),
      verifiedAt: cleanChecklistText(entry.verifiedAt),
      verifiedBy: cleanChecklistText(entry.verifiedBy)
    };
  });
}

function serializeSellerKycChecklist(entries: ReturnType<typeof normalizeSellerKycChecklist>) {
  return Object.fromEntries(entries.map(({ key, label: _label, ...entry }) => [key, entry])) as Prisma.InputJsonObject;
}

function mergeSellerKycChecklist(existing: unknown, patch: unknown) {
  const current = normalizeSellerKycChecklist(existing);
  if (!isRecord(patch)) return serializeSellerKycChecklist(current);

  const merged = current.map((entry) => {
    const patchEntry = patch[entry.key];
    if (!isRecord(patchEntry)) return entry;

    return {
      ...entry,
      status: cleanChecklistStatus(patchEntry.status, entry.status),
      owner: "owner" in patchEntry ? cleanChecklistText(patchEntry.owner) : entry.owner,
      notes: "notes" in patchEntry ? cleanChecklistText(patchEntry.notes) : entry.notes,
      evidenceUrl: "evidenceUrl" in patchEntry ? cleanChecklistText(patchEntry.evidenceUrl) : entry.evidenceUrl,
      verifiedAt: "verifiedAt" in patchEntry ? cleanChecklistText(patchEntry.verifiedAt) : entry.verifiedAt,
      verifiedBy: "verifiedBy" in patchEntry ? cleanChecklistText(patchEntry.verifiedBy) : entry.verifiedBy
    };
  });

  return serializeSellerKycChecklist(merged);
}

export function deriveSellerBadgeStatus(merchant: Pick<
  Merchant,
  | "adminStatus"
  | "onboardingStatus"
  | "pickupAddressStatus"
  | "kycStatus"
  | "bankStatus"
  | "firstShipmentStatus"
>) {
  if (merchant.adminStatus === MerchantAdminStatus.BLOCKED) return MerchantAdminStatus.BLOCKED;
  if (merchant.adminStatus === MerchantAdminStatus.READY_TO_SHIP) return MerchantAdminStatus.READY_TO_SHIP;

  const hasBlockedStep = [
    merchant.pickupAddressStatus,
    merchant.kycStatus,
    merchant.bankStatus,
    merchant.firstShipmentStatus
  ].includes(MerchantOnboardingStepStatus.BLOCKED);

  if (hasBlockedStep) return MerchantAdminStatus.BLOCKED;
  if (merchant.onboardingStatus === MerchantOnboardingStatus.READY_TO_SHIP) return MerchantAdminStatus.READY_TO_SHIP;
  if (merchant.adminStatus === MerchantAdminStatus.ONBOARDING) return MerchantAdminStatus.ONBOARDING;
  if (merchant.onboardingStatus === MerchantOnboardingStatus.IN_PROGRESS) return MerchantAdminStatus.ONBOARDING;

  return MerchantAdminStatus.NEW;
}

function sellerStatusForMerchant(merchant: SellerMerchant, sourceLead: SellerMerchant["leads"][number] | null) {
  const derivedStatus = deriveSellerBadgeStatus(merchant);
  if (derivedStatus === MerchantAdminStatus.NEW && sourceLead?.status === "CONVERTED") {
    return MerchantAdminStatus.ONBOARDING;
  }

  return derivedStatus;
}

function sellerSummary(merchant: SellerMerchant) {
  const sourceLead = merchant.leads[0] ?? null;
  const latestFirstShipmentRequest = merchant.firstShipmentRequests[0] ?? null;
  const sellerStatus = sellerStatusForMerchant(merchant, sourceLead);

  return {
    id: merchant.id,
    name: merchant.name,
    email: merchant.email,
    phone: merchant.phone,
    gstin: merchant.gstin,
    panMasked: merchant.panMasked,
    sellerKycStatus: merchant.sellerKycStatus,
    adminStatus: merchant.adminStatus,
    sellerStatus,
    adminNotes: merchant.adminNotes,
    onboardingStatus: merchant.onboardingStatus,
    onboardingNotes: merchant.onboardingNotes,
    firstShipmentStatus: merchant.firstShipmentStatus,
    userCount: merchant.users.length,
    sourceLead,
    latestFirstShipmentRequest,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt
  };
}

function sellerDetail(merchant: SellerMerchant) {
  const sourceLead = merchant.leads[0] ?? null;
  const sellerStatus = sellerStatusForMerchant(merchant, sourceLead);

  return {
    seller: sellerSummary(merchant),
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      phone: merchant.phone,
      gstin: merchant.gstin,
      panMasked: merchant.panMasked,
      sellerKycStatus: merchant.sellerKycStatus,
      sellerKycChecklist: normalizeSellerKycChecklist(merchant.sellerKycChecklist),
      sellerKycNotes: merchant.sellerKycNotes,
      sellerKycReviewedAt: merchant.sellerKycReviewedAt,
      sellerKycReviewedBy: merchant.sellerKycReviewedBy,
      adminStatus: merchant.adminStatus,
      sellerStatus,
      adminNotes: merchant.adminNotes,
      onboardingNotes: merchant.onboardingNotes,
      createdAt: merchant.createdAt,
      updatedAt: merchant.updatedAt
    },
    users: merchant.users,
    sourceLead,
    leads: merchant.leads,
    onboarding: buildMerchantOnboardingProjection(merchant).onboarding,
    kycReview: {
      status: merchant.sellerKycStatus,
      checklist: normalizeSellerKycChecklist(merchant.sellerKycChecklist),
      notes: merchant.sellerKycNotes,
      reviewedAt: merchant.sellerKycReviewedAt,
      reviewedBy: merchant.sellerKycReviewedBy,
      taxIdPresent: Boolean(merchant.gstin || merchant.panMasked)
    },
    firstShipmentRequests: merchant.firstShipmentRequests
  };
}

export async function listAdminSellers(client: Db = prisma) {
  const merchants = await client.merchant.findMany({
    include: sellerInclude,
    orderBy: { createdAt: "desc" }
  });

  return { sellers: merchants.map(sellerSummary) };
}

export async function getAdminSellerDetail(merchantId: string, client: Db = prisma) {
  const merchant = await client.merchant.findUnique({
    where: { id: merchantId },
    include: sellerInclude
  });

  if (!merchant) return null;
  return sellerDetail(merchant);
}

export async function updateAdminSeller(input: {
  merchantId: string;
  patch: AdminSellerPatch;
  actorId?: string;
}, client: Db = prisma) {
  const existing = await client.merchant.findUnique({
    where: { id: input.merchantId },
    include: sellerInclude
  });

  if (!existing) return null;

  const data: Prisma.MerchantUpdateInput = {};
  const nextGstin = input.patch.gstin !== undefined ? normalizeOptionalGstin(input.patch.gstin) : existing.gstin;
  if (input.patch.gstin !== undefined) data.gstin = nextGstin;
  if (input.patch.adminStatus !== undefined) data.adminStatus = input.patch.adminStatus;
  if (input.patch.adminNotes !== undefined) data.adminNotes = cleanOptional(input.patch.adminNotes);
  if (input.patch.onboardingNotes !== undefined) data.onboardingNotes = cleanOptional(input.patch.onboardingNotes);
  if (input.patch.sellerKycChecklist !== undefined) {
    data.sellerKycChecklist = mergeSellerKycChecklist(existing.sellerKycChecklist, input.patch.sellerKycChecklist);
  }
  if (input.patch.sellerKycNotes !== undefined) data.sellerKycNotes = cleanOptional(input.patch.sellerKycNotes);
  if (input.patch.sellerKycStatus !== undefined) {
    if (input.patch.sellerKycStatus === SellerKycStatus.VERIFIED && !nextGstin && !existing.panMasked) {
      throw new HttpError(400, "SELLER_KYC_TAX_ID_REQUIRED");
    }

    data.sellerKycStatus = input.patch.sellerKycStatus;
    data.sellerKycReviewedAt = new Date();
    if (input.actorId) data.sellerKycReviewedBy = input.actorId;
  }

  const merchant = await client.merchant.update({
    where: { id: input.merchantId },
    data,
    include: sellerInclude
  });

  const auditInput: Parameters<typeof audit>[0] = {
    merchantId: merchant.id,
    action: "ADMIN_SELLER_UPDATED",
    entityType: "merchant",
    entityId: merchant.id,
    metadata: {
      before: {
        adminStatus: existing.adminStatus,
        gstin: existing.gstin,
        panMasked: existing.panMasked,
        sellerKycStatus: existing.sellerKycStatus,
        sellerKycChecklist: normalizeSellerKycChecklist(existing.sellerKycChecklist),
        sellerKycNotes: existing.sellerKycNotes,
        adminNotes: existing.adminNotes,
        onboardingNotes: existing.onboardingNotes
      },
      after: {
        adminStatus: merchant.adminStatus,
        gstin: merchant.gstin,
        panMasked: merchant.panMasked,
        sellerKycStatus: merchant.sellerKycStatus,
        sellerKycChecklist: normalizeSellerKycChecklist(merchant.sellerKycChecklist),
        sellerKycNotes: merchant.sellerKycNotes,
        adminNotes: merchant.adminNotes,
        onboardingNotes: merchant.onboardingNotes
      }
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return sellerDetail(merchant);
}
