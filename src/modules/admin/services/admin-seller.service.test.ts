import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FirstShipmentRequestStatus,
  LeadStatus,
  MerchantAdminStatus,
  MerchantOnboardingStatus,
  MerchantOnboardingStepStatus,
  PaymentMode,
  SellerKycStatus
} from "@prisma/client";
import { deriveSellerBadgeStatus, getAdminSellerDetail, listAdminSellers, updateAdminSeller } from "./admin-seller.service.js";

const now = new Date("2026-05-08T14:30:00.000Z");

function makeClient() {
  const state = {
    merchants: [{
      id: "merchant_1",
      name: "Skymax Store",
      email: "seller@example.com",
      phone: "9876543210",
      gstin: null,
      panEncrypted: null,
      panIv: null,
      panAuthTag: null,
      panMasked: null,
      onboardingStatus: MerchantOnboardingStatus.IN_PROGRESS,
      pickupAddressStatus: MerchantOnboardingStepStatus.COMPLETED,
      kycStatus: MerchantOnboardingStepStatus.PENDING,
      bankStatus: MerchantOnboardingStepStatus.PENDING,
      firstShipmentStatus: MerchantOnboardingStepStatus.IN_PROGRESS,
      onboardingNotes: null,
      sellerKycStatus: SellerKycStatus.NOT_STARTED,
      sellerKycChecklist: {},
      sellerKycNotes: null,
      sellerKycReviewedAt: null,
      sellerKycReviewedBy: null,
      adminStatus: MerchantAdminStatus.NEW,
      adminNotes: null,
      createdAt: now,
      updatedAt: now
    }] as any[],
    users: [{
      id: "user_1",
      merchantId: "merchant_1",
      email: "seller@example.com",
      name: "Seller",
      role: "SELLER_OWNER",
      userType: "SELLER_ACCOUNT",
      createdAt: now,
      updatedAt: now
    }] as any[],
    leads: [{
      id: "lead_1",
      merchantId: "merchant_1",
      name: "Seller",
      businessName: "Skymax Store",
      phone: "9876543210",
      email: "seller@example.com",
      monthlyShipments: "500-1000",
      currentProvider: "Manual",
      biggestIssue: "First shipment",
      notes: "Converted",
      status: LeadStatus.CONVERTED,
      createdAt: now,
      updatedAt: now
    }] as any[],
    firstShipmentRequests: [{
      id: "fsr_1",
      merchantId: "merchant_1",
      requesterUserId: "user_1",
      pickupName: "Seller",
      pickupPhone: "9876543210",
      pickupAddress: "Warehouse",
      pickupPincode: "400001",
      deliveryCity: "Pune",
      deliveryPincode: "411001",
      packageWeight: 750,
      paymentMode: PaymentMode.PREPAID,
      codAmount: 0,
      notes: "Manual",
      status: FirstShipmentRequestStatus.NEW,
      createdAt: now,
      updatedAt: now
    }] as any[],
    auditLogs: [] as any[]
  };

  const hydrate = (merchant: any) => ({
    ...merchant,
    users: state.users.filter((user) => user.merchantId === merchant.id),
    leads: state.leads.filter((lead) => lead.merchantId === merchant.id),
    firstShipmentRequests: state.firstShipmentRequests
      .filter((request) => request.merchantId === merchant.id)
      .map((request) => ({
        ...request,
        requester: state.users.find((user) => user.id === request.requesterUserId)
      }))
  });

  const client = {
    merchant: {
      findMany: async () => state.merchants.map(hydrate),
      findUnique: async ({ where }: any) => {
        const merchant = state.merchants.find((item) => item.id === where.id);
        return merchant ? hydrate(merchant) : null;
      },
      update: async ({ where, data }: any) => {
        const merchant = state.merchants.find((item) => item.id === where.id);
        if (!merchant) throw new Error("MERCHANT_NOT_FOUND");
        Object.assign(merchant, data, { updatedAt: now });
        return hydrate(merchant);
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

describe("admin seller service", () => {
  it("lists and details sellers with source lead, onboarding and first shipment context", async () => {
    const { client } = makeClient();

    const list = await listAdminSellers(client);
    const seller = list.sellers[0];
    assert.ok(seller);
    assert.equal(seller.sellerStatus, MerchantAdminStatus.ONBOARDING);
    assert.equal(seller.sourceLead?.id, "lead_1");
    assert.equal(seller.latestFirstShipmentRequest?.id, "fsr_1");

    const detail = await getAdminSellerDetail("merchant_1", client);
    assert.ok(detail);
    const user = detail.users[0];
    assert.ok(user);
    assert.equal(user.email, "seller@example.com");
    assert.equal(detail?.sourceLead?.status, LeadStatus.CONVERTED);
    assert.equal(detail?.onboarding.progressPercent, 40);
  });

  it("updates admin status and notes with an audit log", async () => {
    const { client, state } = makeClient();

    const result = await updateAdminSeller({
      merchantId: "merchant_1",
      actorId: "admin_1",
      patch: {
        adminStatus: MerchantAdminStatus.BLOCKED,
        gstin: "27aapfu0939f1zv",
        adminNotes: "KYC issue",
        onboardingNotes: "Waiting on documents"
      }
    }, client);

    assert.equal(result?.merchant.adminStatus, MerchantAdminStatus.BLOCKED);
    assert.equal(result?.merchant.sellerStatus, MerchantAdminStatus.BLOCKED);
    assert.equal(result?.merchant.gstin, "27AAPFU0939F1ZV");
    assert.equal(state.auditLogs[0]?.action, "ADMIN_SELLER_UPDATED");
  });

  it("shows masked PAN only on admin seller detail", async () => {
    const { client, state } = makeClient();
    state.merchants[0].panEncrypted = "encrypted-pan";
    state.merchants[0].panIv = "iv";
    state.merchants[0].panAuthTag = "tag";
    state.merchants[0].panMasked = "*****1234F";

    const detail = await getAdminSellerDetail("merchant_1", client);

    assert.equal(detail?.merchant.panMasked, "*****1234F");
    assert.equal(JSON.stringify(detail).includes("encrypted-pan"), false);
    assert.equal(JSON.stringify(detail).includes("ABCDE1234F"), false);
  });

  it("updates seller KYC review with redacted audit metadata", async () => {
    const { client, state } = makeClient();
    state.merchants[0].panMasked = "*****1234F";

    const result = await updateAdminSeller({
      merchantId: "merchant_1",
      actorId: "admin_1",
      patch: {
        sellerKycStatus: SellerKycStatus.VERIFIED,
        sellerKycChecklist: {
          gstinPan: { status: "COMPLETED", owner: "Ops", notes: "Checked ABCDE1234F" },
          bankRemittance: { status: "IN_PROGRESS", notes: "Waiting on bank proof" }
        },
        sellerKycNotes: "Risk reviewed for ABCDE1234F"
      }
    }, client);

    assert.equal(result?.merchant.sellerKycStatus, SellerKycStatus.VERIFIED);
    assert.equal(result?.kycReview.reviewedBy, "admin_1");
    assert.equal(result?.kycReview.checklist[0]?.notes, "Checked [redacted-pan]");
    assert.equal(result?.kycReview.notes, "Risk reviewed for [redacted-pan]");
    assert.equal(JSON.stringify(state.auditLogs).includes("ABCDE1234F"), false);
  });

  it("blocks admin KYC verification when GSTIN and PAN are both missing", async () => {
    const { client } = makeClient();

    await assert.rejects(
      () => updateAdminSeller({
        merchantId: "merchant_1",
        actorId: "admin_1",
        patch: { sellerKycStatus: SellerKycStatus.VERIFIED }
      }, client),
      /SELLER_KYC_TAX_ID_REQUIRED/
    );
  });

  it("accepts blank admin GSTIN and rejects invalid provided GSTIN", async () => {
    const { client } = makeClient();

    const result = await updateAdminSeller({
      merchantId: "merchant_1",
      actorId: "admin_1",
      patch: { gstin: "" }
    }, client);

    assert.equal(result?.merchant.gstin, null);
    await assert.rejects(
      () => updateAdminSeller({
        merchantId: "merchant_1",
        actorId: "admin_1",
        patch: { gstin: "bad-gstin" }
      }, client),
      /INVALID_GSTIN/
    );
  });

  it("derives blocked and ready seller badges from onboarding state", () => {
    assert.equal(deriveSellerBadgeStatus({
      adminStatus: MerchantAdminStatus.NEW,
      onboardingStatus: MerchantOnboardingStatus.IN_PROGRESS,
      pickupAddressStatus: MerchantOnboardingStepStatus.BLOCKED,
      kycStatus: MerchantOnboardingStepStatus.PENDING,
      bankStatus: MerchantOnboardingStepStatus.PENDING,
      firstShipmentStatus: MerchantOnboardingStepStatus.PENDING
    }), MerchantAdminStatus.BLOCKED);

    assert.equal(deriveSellerBadgeStatus({
      adminStatus: MerchantAdminStatus.NEW,
      onboardingStatus: MerchantOnboardingStatus.READY_TO_SHIP,
      pickupAddressStatus: MerchantOnboardingStepStatus.COMPLETED,
      kycStatus: MerchantOnboardingStepStatus.COMPLETED,
      bankStatus: MerchantOnboardingStepStatus.COMPLETED,
      firstShipmentStatus: MerchantOnboardingStepStatus.COMPLETED
    }), MerchantAdminStatus.READY_TO_SHIP);
  });
});
