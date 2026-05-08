import {
  MerchantAdminStatus,
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  type Merchant,
  type Prisma
} from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
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
  adminStatus?: MerchantAdminStatus;
  adminNotes?: string | null;
  onboardingNotes?: string | null;
};

function cleanOptional(value?: string | null) {
  const next = value?.trim();
  return next ? next : null;
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
  if (input.patch.adminStatus !== undefined) data.adminStatus = input.patch.adminStatus;
  if (input.patch.adminNotes !== undefined) data.adminNotes = cleanOptional(input.patch.adminNotes);
  if (input.patch.onboardingNotes !== undefined) data.onboardingNotes = cleanOptional(input.patch.onboardingNotes);

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
        adminNotes: existing.adminNotes,
        onboardingNotes: existing.onboardingNotes
      },
      after: {
        adminStatus: merchant.adminStatus,
        adminNotes: merchant.adminNotes,
        onboardingNotes: merchant.onboardingNotes
      }
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return sellerDetail(merchant);
}
