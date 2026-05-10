import {
  FirstShipmentRequestStatus,
  LeadStatus,
  MerchantAdminStatus,
  MerchantOnboardingStatus,
  type Prisma
} from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

const leadStatuses = Object.values(LeadStatus);
const merchantAdminStatuses = Object.values(MerchantAdminStatus);
const merchantOnboardingStatuses = Object.values(MerchantOnboardingStatus);
const firstShipmentStatuses = Object.values(FirstShipmentRequestStatus);

const latestLeadSelect = {
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
  merchantId: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.LeadSelect;

const sellerSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  adminStatus: true,
  onboardingStatus: true,
  firstShipmentStatus: true,
  adminNotes: true,
  onboardingNotes: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.MerchantSelect;

const firstShipmentSelect = {
  id: true,
  merchantId: true,
  pickupName: true,
  pickupPhone: true,
  pickupPincode: true,
  deliveryCity: true,
  deliveryPincode: true,
  buyerName: true,
  buyerPhone: true,
  packageDescription: true,
  packageWeight: true,
  paymentMode: true,
  codAmount: true,
  courierPreference: true,
  awb: true,
  trackingNumber: true,
  notes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  merchant: {
    select: {
      id: true,
      name: true,
      email: true
    }
  },
  requester: {
    select: {
      id: true,
      name: true,
      email: true
    }
  }
} satisfies Prisma.FirstShipmentRequestSelect;

async function countByValues<T extends string>(
  values: readonly T[],
  countFor: (value: T) => Promise<number>
) {
  const entries = await Promise.all(values.map(async (value) => [value, await countFor(value)] as const));
  return Object.fromEntries(entries) as Record<T, number>;
}

function percent(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export async function buildAdminOpsDashboard(client: Db = prisma) {
  const [
    leadsByStatus,
    sellersByAdminStatus,
    sellersByOnboardingStatus,
    firstShipmentsByStatus,
    latestLeads,
    latestSellers,
    latestFirstShipmentRequests,
    urgentLeads,
    sellersNeedingAction,
    firstShipmentsNeedingReview
  ] = await Promise.all([
    countByValues(leadStatuses, (status) => client.lead.count({ where: { status } })),
    countByValues(merchantAdminStatuses, (status) => client.merchant.count({ where: { adminStatus: status } })),
    countByValues(merchantOnboardingStatuses, (status) => client.merchant.count({ where: { onboardingStatus: status } })),
    countByValues(firstShipmentStatuses, (status) => client.firstShipmentRequest.count({ where: { status } })),
    client.lead.findMany({
      select: latestLeadSelect,
      take: 5,
      orderBy: { createdAt: "desc" }
    }),
    client.merchant.findMany({
      select: sellerSelect,
      take: 5,
      orderBy: { createdAt: "desc" }
    }),
    client.firstShipmentRequest.findMany({
      select: firstShipmentSelect,
      take: 5,
      orderBy: { createdAt: "desc" }
    }),
    client.lead.findMany({
      select: latestLeadSelect,
      where: { status: LeadStatus.NEW },
      take: 5,
      orderBy: { createdAt: "desc" }
    }),
    client.merchant.findMany({
      select: sellerSelect,
      where: {
        OR: [
          { adminStatus: { in: [MerchantAdminStatus.NEW, MerchantAdminStatus.ONBOARDING, MerchantAdminStatus.BLOCKED] } },
          { onboardingStatus: { not: MerchantOnboardingStatus.READY_TO_SHIP } }
        ]
      },
      take: 5,
      orderBy: { updatedAt: "desc" }
    }),
    client.firstShipmentRequest.findMany({
      select: firstShipmentSelect,
      where: {
        status: {
          in: [
            FirstShipmentRequestStatus.NEW,
            FirstShipmentRequestStatus.REVIEWING,
            FirstShipmentRequestStatus.READY_TO_BOOK,
            FirstShipmentRequestStatus.BOOKED_MANUALLY
          ]
        }
      },
      take: 5,
      orderBy: { createdAt: "desc" }
    })
  ]);

  const totalLeads = Object.values(leadsByStatus).reduce((sum, count) => sum + count, 0);
  const convertedLeads = leadsByStatus.CONVERTED ?? 0;
  const qualifiedLeads = leadsByStatus.QUALIFIED ?? 0;

  return {
    counts: {
      leadsByStatus,
      sellersByAdminStatus,
      sellersByOnboardingStatus,
      firstShipmentsByStatus
    },
    latest: {
      leads: latestLeads,
      sellers: latestSellers,
      firstShipmentRequests: latestFirstShipmentRequests
    },
    needsAction: {
      leads: urgentLeads,
      sellers: sellersNeedingAction,
      firstShipmentRequests: firstShipmentsNeedingReview
    },
    conversionHealth: {
      totalLeads,
      qualifiedLeads,
      convertedLeads,
      conversionRatePercent: percent(convertedLeads, totalLeads),
      qualifiedRatePercent: percent(qualifiedLeads, totalLeads)
    }
  };
}
