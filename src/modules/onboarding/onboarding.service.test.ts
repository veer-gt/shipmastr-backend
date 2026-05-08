import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MerchantOnboardingStatus, MerchantOnboardingStepStatus } from "@prisma/client";
import { buildMerchantOnboardingProjection, deriveMerchantOnboardingStatus } from "./onboarding.service.js";

const baseMerchant = {
  id: "merchant_1",
  name: "Skymax Store",
  email: "founder@example.com",
  phone: "9876543210",
  onboardingStatus: MerchantOnboardingStatus.PENDING,
  pickupAddressStatus: MerchantOnboardingStepStatus.PENDING,
  kycStatus: MerchantOnboardingStepStatus.PENDING,
  bankStatus: MerchantOnboardingStepStatus.PENDING,
  firstShipmentStatus: MerchantOnboardingStepStatus.PENDING,
  onboardingNotes: null,
  updatedAt: new Date("2026-05-08T12:45:00.000Z")
};

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
});
