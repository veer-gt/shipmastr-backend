import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FirstShipmentRequestStatus,
  LeadStatus,
  MerchantAdminStatus,
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  PaymentMode
} from "@prisma/client";
import { buildAdminOpsDashboard } from "./admin-ops-dashboard.service.js";

const older = new Date("2026-05-08T08:00:00.000Z");
const newer = new Date("2026-05-08T12:00:00.000Z");

function matchesWhere(item: any, where: any = {}) {
  if (!where || Object.keys(where).length === 0) return true;

  if (where.OR) return where.OR.some((clause: any) => matchesWhere(item, clause));

  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) {
      const list = (value as { in: unknown[] }).in;
      return list.includes(item[key]);
    }

    if (value && typeof value === "object" && "not" in value) {
      return item[key] !== (value as { not: unknown }).not;
    }

    if (value && typeof value === "object" && "notIn" in value) {
      const list = (value as { notIn: unknown[] }).notIn;
      return !list.includes(item[key]);
    }

    return item[key] === value;
  });
}

function ordered(items: any[], orderBy: any) {
  const [field, direction] = Object.entries(orderBy ?? { createdAt: "desc" })[0] as [string, "asc" | "desc"];
  return [...items].sort((left, right) => {
    const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
    const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
    if (leftValue === rightValue) return 0;
    return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
  });
}

function makeClient() {
  const merchants = [{
    id: "merchant_ready",
    name: "Ready Seller",
    email: "ready@example.com",
    phone: "9000000001",
    adminStatus: MerchantAdminStatus.READY_TO_SHIP,
    onboardingStatus: MerchantOnboardingStatus.READY_TO_SHIP,
    firstShipmentStatus: MerchantOnboardingStepStatus.COMPLETED,
    adminNotes: null,
    onboardingNotes: null,
    createdAt: older,
    updatedAt: older
  }, {
    id: "merchant_onboarding",
    name: "Onboarding Seller",
    email: "onboarding@example.com",
    phone: "9000000002",
    adminStatus: MerchantAdminStatus.ONBOARDING,
    onboardingStatus: MerchantOnboardingStatus.IN_PROGRESS,
    firstShipmentStatus: MerchantOnboardingStepStatus.IN_PROGRESS,
    adminNotes: "Waiting on pickup address",
    onboardingNotes: "Ops follow-up",
    createdAt: newer,
    updatedAt: newer
  }];

  const leads = [{
    id: "lead_new",
    name: "New Lead",
    businessName: "New Brand",
    phone: "9000000003",
    email: "new@example.com",
    monthlyShipments: "100-300",
    currentProvider: "Manual",
    biggestIssue: "COD",
    notes: null,
    status: LeadStatus.NEW,
    merchantId: null,
    createdAt: newer,
    updatedAt: newer
  }, {
    id: "lead_converted",
    name: "Converted Lead",
    businessName: "Ready Seller",
    phone: "9000000001",
    email: "ready@example.com",
    monthlyShipments: "500-1000",
    currentProvider: "Manual",
    biggestIssue: "Ops",
    notes: "Converted",
    status: LeadStatus.CONVERTED,
    merchantId: "merchant_ready",
    createdAt: older,
    updatedAt: older
  }];

  const firstShipmentRequests = [{
    id: "fsr_new",
    merchantId: "merchant_onboarding",
    requesterUserId: "user_onboarding",
    pickupName: "Ops Lead",
    pickupPhone: "9000000002",
    pickupPincode: "400001",
    deliveryCity: "Pune",
    deliveryPincode: "411001",
    packageWeight: 500,
    paymentMode: PaymentMode.PREPAID,
    codAmount: 0,
    notes: null,
    status: FirstShipmentRequestStatus.NEW,
    createdAt: newer,
    updatedAt: newer,
    merchant: {
      id: "merchant_onboarding",
      name: "Onboarding Seller",
      email: "onboarding@example.com"
    },
    requester: {
      id: "user_onboarding",
      name: "Ops Lead",
      email: "onboarding@example.com"
    }
  }, {
    id: "fsr_complete",
    merchantId: "merchant_ready",
    requesterUserId: "user_ready",
    pickupName: "Ready Seller",
    pickupPhone: "9000000001",
    pickupPincode: "560001",
    deliveryCity: "Mumbai",
    deliveryPincode: "400001",
    packageWeight: 800,
    paymentMode: PaymentMode.COD,
    codAmount: 100000,
    notes: "Done",
    status: FirstShipmentRequestStatus.DELIVERED,
    createdAt: older,
    updatedAt: older,
    merchant: {
      id: "merchant_ready",
      name: "Ready Seller",
      email: "ready@example.com"
    },
    requester: {
      id: "user_ready",
      name: "Ready Seller",
      email: "ready@example.com"
    }
  }];

  const couriers = [{
    id: "courier_manual",
    name: "Northline Express",
    code: "NLE",
    active: true,
    apiMode: "manual",
    bookingMode: "manual",
    supportsCOD: true,
    updatedAt: newer,
    _count: {
      rateCards: 1,
      serviceablePincodes: 2,
      gstinRecords: 1,
      operationalLocations: 1
    }
  }];

  const courierShipments = [{
    id: "shipment_pending",
    courierId: "courier_manual",
    status: "pickup_scheduled",
    createdAt: newer,
    updatedAt: newer
  }];

  const model = (rows: any[]) => ({
    count: async ({ where }: any = {}) => rows.filter((row) => matchesWhere(row, where)).length,
    findMany: async ({ where, orderBy, take }: any = {}) => ordered(rows.filter((row) => matchesWhere(row, where)), orderBy).slice(0, take)
  });

  return {
    lead: model(leads),
    merchant: model(merchants),
    firstShipmentRequest: model(firstShipmentRequests),
    courierPartner: model(couriers),
    courierShipment: model(courierShipments)
  } as any;
}

describe("admin ops dashboard", () => {
  it("returns status counts, latest rows, and action queues", async () => {
    const dashboard = await buildAdminOpsDashboard(makeClient());

    assert.equal(dashboard.counts.leadsByStatus.NEW, 1);
    assert.equal(dashboard.counts.leadsByStatus.CONVERTED, 1);
    assert.equal(dashboard.counts.sellersByAdminStatus.ONBOARDING, 1);
    assert.equal(dashboard.counts.sellersByOnboardingStatus.READY_TO_SHIP, 1);
    assert.equal(dashboard.counts.firstShipmentsByStatus.NEW, 1);
    assert.equal(dashboard.conversionHealth.totalLeads, 2);
    assert.equal(dashboard.conversionHealth.conversionRatePercent, 50);
    assert.equal(dashboard.pilot.firstCourierSetup.totalCouriers, 1);
    assert.equal(dashboard.pilot.firstCourierSetup.manualBookingCouriers, 1);
    assert.equal(dashboard.pilot.manualShipmentsPending, 1);

    assert.equal(dashboard.latest.leads[0]?.id, "lead_new");
    assert.equal(dashboard.latest.sellers[0]?.id, "merchant_onboarding");
    assert.equal(dashboard.latest.firstShipmentRequests[0]?.id, "fsr_new");
    assert.equal(dashboard.needsAction.leads[0]?.id, "lead_new");
    assert.equal(dashboard.needsAction.sellers[0]?.id, "merchant_onboarding");
    assert.equal(dashboard.needsAction.firstShipmentRequests[0]?.id, "fsr_new");
  });
});
