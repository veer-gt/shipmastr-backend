import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FirstShipmentRequestStatus,
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  PaymentMode
} from "@prisma/client";
import {
  convertFirstShipmentRequestToManualShipment,
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
    couriers: [{
      id: "courier_1",
      name: "Northline Express",
      code: "NLE",
      apiMode: "manual",
      bookingMode: "manual"
    }] as any[],
    requests: [] as any[],
    shipments: [] as any[],
    auditLogs: [] as any[]
  };

  const withInclude = (request: any) => ({
    ...request,
    merchant: state.merchants.find((merchant) => merchant.id === request.merchantId),
    requester: state.users.find((user) => user.id === request.requesterUserId),
    manualShipment: state.shipments.find((shipment) => shipment.firstShipmentRequestId === request.id)
      ? {
        ...state.shipments.find((shipment) => shipment.firstShipmentRequestId === request.id),
        courier: state.couriers.find((courier) => courier.id === state.shipments.find((shipment) => shipment.firstShipmentRequestId === request.id)?.courierId)
      }
      : null
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
    courierPartner: {
      findUnique: async ({ where }: any) => state.couriers.find((courier) => courier.id === where.id) ?? null
    },
    courierShipment: {
      create: async ({ data }: any) => {
        const shipment = {
          id: `shipment_${state.shipments.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data,
          courier: state.couriers.find((courier) => courier.id === data.courierId),
          events: data.events?.create ? [{ id: "event_1", ...data.events.create }] : []
        };
        state.shipments.push(shipment);
        return shipment;
      },
      update: async ({ where, data }: any) => {
        const shipment = state.shipments.find((item) => item.id === where.id);
        if (!shipment) throw new Error("SHIPMENT_NOT_FOUND");
        Object.assign(shipment, data, {
          updatedAt: now,
          courier: state.couriers.find((courier) => courier.id === data.courierId)
        });
        return shipment;
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

  it("converts a first shipment request into an audited manual courier shipment", async () => {
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
      paymentMode: PaymentMode.COD,
      codAmount: 129900,
      notes: null
    }, client);

    const result = await convertFirstShipmentRequestToManualShipment({
      requestId: "fsr_1",
      actorId: "admin_1",
      courierId: "courier_1",
      awbNumber: "qa-awb-1001",
      freightEstimate: 8500,
      codAmount: 129900,
      status: "pickup_scheduled",
      trackingUrl: "https://track.example/qa-awb-1001",
      opsNotes: "Booked by phone with courier ops"
    }, client);

    assert.equal(result?.shipment.awbNumber, "QA-AWB-1001");
    assert.equal(result?.shipment.freightEstimate, 8500);
    assert.equal(result?.request.status, FirstShipmentRequestStatus.AWB_ADDED);
    assert.equal(result?.request.assignedCourierId, "courier_1");
    assert.equal(state.shipments.length, 1);
    assert.equal(state.auditLogs.some((log) => log.action === "FIRST_SHIPMENT_MANUAL_SHIPMENT_CREATED"), true);
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
