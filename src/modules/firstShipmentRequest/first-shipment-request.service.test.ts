import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FirstShipmentRequestStatus,
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  PaymentMode
} from "@prisma/client";
import {
  createFirstShipmentRequest,
  listSellerFirstShipmentRequests,
  updateFirstShipmentRequest
} from "./first-shipment-request.service.js";

const now = new Date("2026-05-08T14:05:00.000Z");

function makeClient() {
  const state = {
    merchants: [{
      id: "merchant_1",
      name: "Skymax Store",
      email: "seller@example.com",
      phone: "9876543210",
      onboardingStatus: MerchantOnboardingStatus.IN_PROGRESS,
      pickupAddressStatus: MerchantOnboardingStepStatus.COMPLETED,
      kycStatus: MerchantOnboardingStepStatus.COMPLETED,
      bankStatus: MerchantOnboardingStepStatus.COMPLETED,
      firstShipmentStatus: MerchantOnboardingStepStatus.PENDING,
      onboardingNotes: null,
      updatedAt: now
    }] as any[],
    users: [{ id: "user_1", email: "seller@example.com", name: "Seller" }] as any[],
    requests: [] as any[],
    auditLogs: [] as any[]
  };

  const withInclude = (request: any) => ({
    ...request,
    merchant: state.merchants.find((merchant) => merchant.id === request.merchantId),
    requester: state.users.find((user) => user.id === request.requesterUserId)
  });

  const client = {
    $transaction: async (callback: any) => callback(client),
    firstShipmentRequest: {
      create: async ({ data }: any) => {
        const request = {
          id: `fsr_${state.requests.length + 1}`,
          status: FirstShipmentRequestStatus.NEW,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.requests.push(request);
        return withInclude(request);
      },
      findMany: async ({ where, orderBy }: any = {}) => {
        let requests = [...state.requests];
        if (where?.merchantId) requests = requests.filter((request) => request.merchantId === where.merchantId);
        if (orderBy?.createdAt === "desc") {
          requests.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return requests.map(withInclude);
      },
      findUnique: async ({ where }: any) => {
        const request = state.requests.find((item) => item.id === where.id);
        return request ? withInclude(request) : null;
      },
      update: async ({ where, data }: any) => {
        const request = state.requests.find((item) => item.id === where.id);
        if (!request) throw new Error("REQUEST_NOT_FOUND");
        Object.assign(request, data, { updatedAt: now });
        return withInclude(request);
      }
    },
    merchant: {
      findUnique: async ({ where }: any) => state.merchants.find((merchant) => merchant.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const merchant = state.merchants.find((item) => item.id === where.id);
        if (!merchant) throw new Error("MERCHANT_NOT_FOUND");
        Object.assign(merchant, data, { updatedAt: now });
        return merchant;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("first shipment requests", () => {
  it("creates a seller-owned first shipment request and marks onboarding in progress", async () => {
    const { client, state } = makeClient();

    const request = await createFirstShipmentRequest({
      merchantId: "merchant_1",
      requesterUserId: "user_1",
      pickupName: "Ops Seller",
      pickupPhone: "9876543210",
      pickupAddress: "Warehouse 1, Mumbai",
      pickupPincode: "400001",
      deliveryCity: "Pune",
      deliveryPincode: "411001",
      buyerName: "Buyer One",
      buyerPhone: "9123456789",
      buyerAddress: "Buyer address, Pune",
      packageDescription: "T-shirt test parcel",
      packageWeight: 750,
      paymentMode: PaymentMode.COD,
      codAmount: 129900,
      courierPreference: "Manual Delhivery check",
      notes: "Handle manually"
    }, client);

    assert.equal(request.status, FirstShipmentRequestStatus.NEW);
    assert.equal(request.merchantId, "merchant_1");
    assert.equal(request.buyerName, "Buyer One");
    assert.equal(request.packageDescription, "T-shirt test parcel");
    assert.equal(request.courierPreference, "Manual Delhivery check");
    assert.equal(state.merchants[0].firstShipmentStatus, MerchantOnboardingStepStatus.IN_PROGRESS);
    assert.equal(state.auditLogs.some((log) => log.action === "FIRST_SHIPMENT_REQUEST_CREATED"), true);

    const listed = await listSellerFirstShipmentRequests("merchant_1", client);
    assert.equal(listed.latestRequest?.id, request.id);
  });

  it("updates admin status and completes onboarding when delivered", async () => {
    const { client, state } = makeClient();
    await createFirstShipmentRequest({
      merchantId: "merchant_1",
      requesterUserId: "user_1",
      pickupName: "Ops Seller",
      pickupPhone: "9876543210",
      pickupAddress: "Warehouse 1, Mumbai",
      pickupPincode: "400001",
      deliveryCity: "Pune",
      deliveryPincode: "411001",
      packageWeight: 750,
      paymentMode: PaymentMode.PREPAID,
      notes: null
    }, client);

    const updated = await updateFirstShipmentRequest({
      id: "fsr_1",
      actorId: "admin_1",
      patch: {
        status: FirstShipmentRequestStatus.DELIVERED,
        awb: "QA123456789",
        trackingNumber: "TRK123456789",
        courierPreference: "Manual Blue Dart",
        notes: "Delivered in dry run"
      }
    }, client);

    assert.equal(updated?.status, FirstShipmentRequestStatus.DELIVERED);
    assert.equal(updated?.awb, "QA123456789");
    assert.equal(updated?.trackingNumber, "TRK123456789");
    assert.equal(updated?.courierPreference, "Manual Blue Dart");
    assert.equal(state.merchants[0].firstShipmentStatus, MerchantOnboardingStepStatus.COMPLETED);
    assert.equal(state.auditLogs.some((log) => log.action === "FIRST_SHIPMENT_REQUEST_UPDATED"), true);
    assert.equal(state.auditLogs.at(-1)?.metadata.changed.awb, true);
  });

  it("blocks onboarding when manual first shipment is RTO or cancelled", async () => {
    const { client, state } = makeClient();
    await createFirstShipmentRequest({
      merchantId: "merchant_1",
      requesterUserId: "user_1",
      pickupName: "Ops Seller",
      pickupPhone: "9876543210",
      pickupAddress: "Warehouse 1, Mumbai",
      pickupPincode: "400001",
      deliveryCity: "Pune",
      deliveryPincode: "411001",
      packageWeight: 750,
      paymentMode: PaymentMode.PREPAID,
      notes: null
    }, client);

    const updated = await updateFirstShipmentRequest({
      id: "fsr_1",
      actorId: "admin_1",
      patch: {
        status: FirstShipmentRequestStatus.RTO,
        notes: "Manual courier returned shipment"
      }
    }, client);

    assert.equal(updated?.status, FirstShipmentRequestStatus.RTO);
    assert.equal(state.merchants[0].firstShipmentStatus, MerchantOnboardingStepStatus.BLOCKED);
  });
});
