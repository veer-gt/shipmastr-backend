import { Router } from "express";
import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  completeMerchantStoreOnboarding,
  getMerchantStoreOnboardingState,
  markMerchantOnboardingReconciliationViewed,
  startMerchantOnboardingFirstFetch,
  testMerchantStoreConnection,
  updateMerchantStoreOnboardingState
} from "./merchant-onboarding.service.js";
import {
  merchantOnboardingConnectionActionSchema,
  merchantOnboardingFirstFetchSchema,
  merchantOnboardingStatePatchSchema
} from "./merchant-onboarding.validation.js";

export const merchantStoreOnboardingRouter = Router();

merchantStoreOnboardingRouter.get("/merchant-onboarding/state", async (req, res) => {
  const data = await getMerchantStoreOnboardingState(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant store onboarding state fetched safely.", data));
});

merchantStoreOnboardingRouter.put("/merchant-onboarding/state", async (req, res) => {
  const body = merchantOnboardingStatePatchSchema.parse(req.body ?? {});
  const data = await updateMerchantStoreOnboardingState(req.auth!.merchantId, body);
  return res.json(successEnvelope("Merchant store onboarding state updated safely.", data));
});

merchantStoreOnboardingRouter.post("/merchant-onboarding/actions/test-connection", async (req, res) => {
  const body = merchantOnboardingConnectionActionSchema.parse(req.body ?? {});
  const data = await testMerchantStoreConnection(req.auth!.merchantId, body);
  return res.json(successEnvelope("Merchant store connection readiness checked safely.", data));
});

merchantStoreOnboardingRouter.post("/merchant-onboarding/actions/start-first-fetch", async (req, res) => {
  const body = merchantOnboardingFirstFetchSchema.parse(req.body ?? {});
  const data = await startMerchantOnboardingFirstFetch(req.auth!.merchantId, body);
  return res.status(201).json(successEnvelope("Merchant first read-only fetch ran safely.", data));
});

merchantStoreOnboardingRouter.post("/merchant-onboarding/actions/mark-reconciliation-viewed", async (req, res) => {
  const data = await markMerchantOnboardingReconciliationViewed(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant import reconciliation milestone marked safely.", data));
});

merchantStoreOnboardingRouter.post("/merchant-onboarding/actions/complete", async (req, res) => {
  const data = await completeMerchantStoreOnboarding(req.auth!.merchantId);
  return res.json(successEnvelope("Merchant store onboarding completed safely.", data));
});
