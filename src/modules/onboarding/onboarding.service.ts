import {
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  SellerKycStatus,
  type Merchant,
  type Prisma
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { normalizeOptionalGstin } from "../../lib/gstin.js";
import { encryptPan, normalizeOptionalPan, redactPanText } from "../../lib/pan.js";
import { audit } from "../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type MerchantOnboardingMerchant = Pick<
  Merchant,
  | "id"
  | "name"
  | "email"
  | "phone"
  | "gstin"
  | "panMasked"
  | "onboardingStatus"
  | "pickupAddressStatus"
  | "kycStatus"
  | "bankStatus"
  | "firstShipmentStatus"
  | "onboardingNotes"
  | "sellerKycStatus"
  | "updatedAt"
>;

export type MerchantOnboardingPatch = {
  gstin?: string | null;
  pan?: string | null;
  pickupAddressStatus?: MerchantOnboardingStepStatus;
  kycStatus?: MerchantOnboardingStepStatus;
  bankStatus?: MerchantOnboardingStepStatus;
  firstShipmentStatus?: MerchantOnboardingStepStatus;
  onboardingNotes?: string | null;
};

const checklistDefinitions = [
  {
    key: "companyProfile",
    label: "Company profile",
    field: null
  },
  {
    key: "pickupAddress",
    label: "Pickup address",
    field: "pickupAddressStatus"
  },
  {
    key: "bankCodDetails",
    label: "Bank/COD details",
    field: "bankStatus"
  },
  {
    key: "kycDocuments",
    label: "KYC documents",
    field: "kycStatus"
  },
  {
    key: "firstShipmentRequest",
    label: "First shipment request",
    field: "firstShipmentStatus"
  }
] as const;

function cleanNotes(value?: string | null) {
  return redactPanText(value);
}

function hasCompanyProfile(merchant: Pick<MerchantOnboardingMerchant, "name" | "email" | "phone">) {
  return Boolean(merchant.name?.trim() && merchant.email?.trim() && merchant.phone?.trim());
}

export function deriveMerchantOnboardingStatus(merchant: Pick<
  MerchantOnboardingMerchant,
  "name" | "email" | "phone" | "pickupAddressStatus" | "kycStatus" | "bankStatus" | "firstShipmentStatus" | "onboardingNotes"
>) {
  const companyReady = hasCompanyProfile(merchant);
  const operationalStatuses = [
    merchant.pickupAddressStatus,
    merchant.bankStatus,
    merchant.kycStatus,
    merchant.firstShipmentStatus
  ];

  const allReady = companyReady && operationalStatuses.every((status) => status === MerchantOnboardingStepStatus.COMPLETED);
  if (allReady) return MerchantOnboardingStatus.READY_TO_SHIP;

  const hasStarted = operationalStatuses.some((status) => status !== MerchantOnboardingStepStatus.PENDING) || Boolean(merchant.onboardingNotes?.trim());
  if (hasStarted) return MerchantOnboardingStatus.IN_PROGRESS;

  return MerchantOnboardingStatus.PENDING;
}

export function buildMerchantOnboardingProjection(merchant: MerchantOnboardingMerchant) {
  const checklist = checklistDefinitions.map((item) => {
    const status = item.field
      ? merchant[item.field]
      : hasCompanyProfile(merchant)
        ? MerchantOnboardingStepStatus.COMPLETED
        : MerchantOnboardingStepStatus.PENDING;

    return {
      key: item.key,
      label: item.label,
      status
    };
  });
  const completedCount = checklist.filter((item) => item.status === MerchantOnboardingStepStatus.COMPLETED).length;

  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      phone: merchant.phone,
      gstin: merchant.gstin,
      panMasked: merchant.panMasked
    },
    onboarding: {
      onboardingStatus: merchant.onboardingStatus,
      pickupAddressStatus: merchant.pickupAddressStatus,
      kycStatus: merchant.kycStatus,
      bankStatus: merchant.bankStatus,
      firstShipmentStatus: merchant.firstShipmentStatus,
      sellerKycStatus: merchant.sellerKycStatus,
      onboardingNotes: merchant.onboardingNotes,
      progressPercent: Math.round((completedCount / checklist.length) * 100),
      checklist,
      updatedAt: merchant.updatedAt
    }
  };
}

export async function getMerchantOnboarding(merchantId: string, client: Db = prisma) {
  const merchant = await client.merchant.findUnique({
    where: { id: merchantId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gstin: true,
      panMasked: true,
      onboardingStatus: true,
      pickupAddressStatus: true,
      kycStatus: true,
      bankStatus: true,
      firstShipmentStatus: true,
      onboardingNotes: true,
      sellerKycStatus: true,
      updatedAt: true
    }
  });

  if (!merchant) return null;
  return buildMerchantOnboardingProjection(merchant);
}

export async function updateMerchantOnboarding(input: {
  merchantId: string;
  patch: MerchantOnboardingPatch;
  actorId?: string;
}, client: Db = prisma) {
  const existing = await client.merchant.findUnique({
    where: { id: input.merchantId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gstin: true,
      panMasked: true,
      panEncrypted: true,
      panIv: true,
      panAuthTag: true,
      onboardingStatus: true,
      pickupAddressStatus: true,
      kycStatus: true,
      bankStatus: true,
      firstShipmentStatus: true,
      onboardingNotes: true,
      sellerKycStatus: true,
      updatedAt: true
    }
  });

  if (!existing) return null;

  const normalizedGstin = input.patch.gstin !== undefined ? normalizeOptionalGstin(input.patch.gstin) : existing.gstin;
  const normalizedPan = input.patch.pan !== undefined ? normalizeOptionalPan(input.patch.pan) : undefined;
  const next = {
    ...existing,
    gstin: normalizedGstin,
    pickupAddressStatus: input.patch.pickupAddressStatus ?? existing.pickupAddressStatus,
    kycStatus: input.patch.kycStatus ?? existing.kycStatus,
    bankStatus: input.patch.bankStatus ?? existing.bankStatus,
    firstShipmentStatus: input.patch.firstShipmentStatus ?? existing.firstShipmentStatus,
    onboardingNotes: input.patch.onboardingNotes !== undefined ? cleanNotes(input.patch.onboardingNotes) : existing.onboardingNotes
  };
  const data: Prisma.MerchantUpdateInput = {
    onboardingStatus: deriveMerchantOnboardingStatus(next)
  };

  if (input.patch.pickupAddressStatus !== undefined) data.pickupAddressStatus = input.patch.pickupAddressStatus;
  if (input.patch.gstin !== undefined) data.gstin = next.gstin;
  if (input.patch.pan !== undefined) {
    if (normalizedPan) {
      Object.assign(data, encryptPan(normalizedPan));
    } else {
      data.panEncrypted = null;
      data.panIv = null;
      data.panAuthTag = null;
      data.panMasked = null;
    }
  }
  if (input.patch.kycStatus !== undefined) data.kycStatus = input.patch.kycStatus;
  if (input.patch.bankStatus !== undefined) data.bankStatus = input.patch.bankStatus;
  if (input.patch.firstShipmentStatus !== undefined) data.firstShipmentStatus = input.patch.firstShipmentStatus;
  if (input.patch.onboardingNotes !== undefined) data.onboardingNotes = next.onboardingNotes;
  if (
    (existing.sellerKycStatus === SellerKycStatus.NOT_STARTED || existing.sellerKycStatus === SellerKycStatus.REOPENED) &&
    (
      Boolean(normalizedGstin) ||
      Boolean(normalizedPan) ||
      next.kycStatus === MerchantOnboardingStepStatus.IN_PROGRESS ||
      next.kycStatus === MerchantOnboardingStepStatus.COMPLETED
    )
  ) {
    data.sellerKycStatus = SellerKycStatus.DETAILS_SUBMITTED;
  }

  const merchant = await client.merchant.update({
    where: { id: input.merchantId },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      gstin: true,
      panMasked: true,
      onboardingStatus: true,
      pickupAddressStatus: true,
      kycStatus: true,
      bankStatus: true,
      firstShipmentStatus: true,
      onboardingNotes: true,
      sellerKycStatus: true,
      updatedAt: true
    }
  });

  const auditInput: Parameters<typeof audit>[0] = {
    merchantId: merchant.id,
    action: "MERCHANT_ONBOARDING_UPDATED",
    entityType: "merchant",
    entityId: merchant.id,
    metadata: {
      before: {
        onboardingStatus: existing.onboardingStatus,
        pickupAddressStatus: existing.pickupAddressStatus,
        kycStatus: existing.kycStatus,
        bankStatus: existing.bankStatus,
        firstShipmentStatus: existing.firstShipmentStatus,
        gstin: existing.gstin,
        panMasked: existing.panMasked,
        sellerKycStatus: existing.sellerKycStatus
      },
      after: {
        onboardingStatus: merchant.onboardingStatus,
        pickupAddressStatus: merchant.pickupAddressStatus,
        kycStatus: merchant.kycStatus,
        bankStatus: merchant.bankStatus,
        firstShipmentStatus: merchant.firstShipmentStatus,
        gstin: merchant.gstin,
        panMasked: merchant.panMasked,
        sellerKycStatus: merchant.sellerKycStatus
      },
      panChanged: input.patch.pan !== undefined
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return buildMerchantOnboardingProjection(merchant);
}
