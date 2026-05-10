import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MerchantOnboardingStatus, MerchantOnboardingStepStatus, SellerKycStatus } from "@prisma/client";
import { buildMerchantOnboardingProjection, deriveMerchantOnboardingStatus, updateMerchantOnboarding } from "./onboarding.service.js";

const baseMerchant = {
  id: "merchant_1",
  name: "Skymax Store",
  email: "founder@example.com",
  phone: "9876543210",
  gstin: null,
  panEncrypted: null,
  panIv: null,
  panAuthTag: null,
  panMasked: null,
  onboardingStatus: MerchantOnboardingStatus.PENDING,
  pickupAddressStatus: MerchantOnboardingStepStatus.PENDING,
  kycStatus: MerchantOnboardingStepStatus.PENDING,
  bankStatus: MerchantOnboardingStepStatus.PENDING,
  firstShipmentStatus: MerchantOnboardingStepStatus.PENDING,
  onboardingNotes: null,
  sellerKycStatus: SellerKycStatus.NOT_STARTED,
  updatedAt: new Date("2026-05-08T12:45:00.000Z")
};

function makeClient() {
  const state = {
    merchant: { ...baseMerchant },
    auditLogs: [] as any[]
  };

  const client = {
    merchant: {
      findUnique: async ({ where }: any) => where.id === state.merchant.id ? state.merchant : null,
      update: async ({ where, data }: any) => {
        assert.equal(where.id, state.merchant.id);
        state.merchant = {
          ...state.merchant,
          ...data,
          updatedAt: baseMerchant.updatedAt
        };
        return state.merchant;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: baseMerchant.updatedAt, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("merchant onboarding", () => {
  it("projects a converted seller as pending with company profile progress", () => {
    const result = buildMerchantOnboardingProjection(baseMerchant);

    assert.equal(result.onboarding.onboardingStatus, MerchantOnboardingStatus.PENDING);
    assert.equal(result.onboarding.progressPercent, 20);
    assert.deepEqual(result.onboarding.checklist.map((item) => [item.key, item.status]), [
      ["companyProfile", MerchantOnboardingStepStatus.COMPLETED],
      ["pickupAddress", MerchantOnboardingStepStatus.PENDING],
      ["bankCodDetails", MerchantOnboardingStepStatus.PENDING],
      ["kycDocuments", MerchantOnboardingStepStatus.PENDING],
      ["firstShipmentRequest", MerchantOnboardingStepStatus.PENDING]
    ]);
  });

  it("derives in-progress and ready-to-ship states from checklist status", () => {
    assert.equal(deriveMerchantOnboardingStatus({
      ...baseMerchant,
      pickupAddressStatus: MerchantOnboardingStepStatus.IN_PROGRESS
    }), MerchantOnboardingStatus.IN_PROGRESS);

    assert.equal(deriveMerchantOnboardingStatus({
      ...baseMerchant,
      pickupAddressStatus: MerchantOnboardingStepStatus.COMPLETED,
      kycStatus: MerchantOnboardingStepStatus.COMPLETED,
      bankStatus: MerchantOnboardingStepStatus.COMPLETED,
      firstShipmentStatus: MerchantOnboardingStepStatus.COMPLETED
    }), MerchantOnboardingStatus.READY_TO_SHIP);
  });

  it("accepts blank seller GSTIN", async () => {
    const { client, state } = makeClient();

    const result = await updateMerchantOnboarding({
      merchantId: "merchant_1",
      actorId: "user_1",
      patch: { gstin: "" }
    }, client);

    assert.equal(result?.merchant.gstin, null);
    assert.equal(state.merchant.gstin, null);
  });

  it("accepts blank seller GSTIN and blank PAN on onboarding draft", async () => {
    const { client, state } = makeClient();

    const result = await updateMerchantOnboarding({
      merchantId: "merchant_1",
      actorId: "user_1",
      patch: { gstin: "", pan: "" }
    }, client);

    assert.equal(result?.merchant.gstin, null);
    assert.equal(result?.merchant.panMasked, null);
    assert.equal(state.merchant.gstin, null);
    assert.equal(state.merchant.panMasked, null);
  });

  it("normalizes lowercase seller GSTIN and rejects invalid provided GSTIN", async () => {
    const { client } = makeClient();

    const result = await updateMerchantOnboarding({
      merchantId: "merchant_1",
      actorId: "user_1",
      patch: { gstin: "27aapfu0939f1zv" }
    }, client);

    assert.equal(result?.merchant.gstin, "27AAPFU0939F1ZV");

    await assert.rejects(
      () => updateMerchantOnboarding({
        merchantId: "merchant_1",
        actorId: "user_1",
        patch: { gstin: "not-a-gstin" }
      }, client),
      /INVALID_GSTIN/
    );
  });

  it("normalizes valid seller PAN, stores only masked PAN outward, and redacts audit metadata", async () => {
    const { client, state } = makeClient();

    const result = await updateMerchantOnboarding({
      merchantId: "merchant_1",
      actorId: "user_1",
      patch: { pan: "abcde1234f" }
    }, client);

    assert.equal(result?.merchant.panMasked, "*****1234F");
    assert.equal(result?.onboarding.sellerKycStatus, SellerKycStatus.DETAILS_SUBMITTED);
    assert.equal(state.merchant.panMasked, "*****1234F");
    assert.notEqual(state.merchant.panEncrypted, "ABCDE1234F");
    assert.equal(JSON.stringify(state.auditLogs), JSON.stringify(state.auditLogs).replace("ABCDE1234F", ""));
    assert.equal(JSON.stringify(state.auditLogs).includes("abcde1234f"), false);
    assert.equal(JSON.stringify(state.auditLogs).includes("ABCDE1234F"), false);
  });

  it("rejects invalid seller PAN only when provided", async () => {
    const { client } = makeClient();

    await assert.rejects(
      () => updateMerchantOnboarding({
        merchantId: "merchant_1",
        actorId: "user_1",
        patch: { pan: "bad-pan" }
      }, client),
      /INVALID_PAN/
    );
  });
});
