import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activateMerchantCampaign,
  createMerchantCampaign,
  recordMerchantCampaignEvent,
  resolveMerchantCampaignCardsForSurface,
  submitMerchantCampaign
} from "../merchant-campaign.service.js";
import {
  approveCampaignFromReview,
  runCampaignPolicyCheck
} from "../campaign-review.service.js";
import {
  getCampaignAnalytics,
  getCampaignAnalyticsBySurface,
  getCampaignAnalyticsByType,
  getCampaignAnalyticsSummary
} from "../campaign-analytics.service.js";
import {
  createPartnerLeadConsent,
  createPartnerLeadRoutingIntent,
  getPartnerLeadRoutingReadiness,
  simulatePartnerLeadRouting,
  updatePartnerLeadConsentStatus
} from "../partner-routing.service.js";
import {
  checkBillingReadiness,
  createBillingSimulationEvent,
  upsertBillingReadinessProfile
} from "../billing-readiness.service.js";
import { makeGrowthNetworkMaturityClient } from "./growth-network-maturity-test-utils.js";

describe("growth network maturity services", () => {
  it("reviews, activates, resolves, and analyzes merchant campaigns without billing math", async () => {
    const { client, state } = makeGrowthNetworkMaturityClient();

    const campaign = await createMerchantCampaign({
      merchantId: "merchant_1",
      title: "Repeat buyer reorder",
      description: "Bring a shopper back to the store",
      campaignType: "TRACKING_REORDER",
      surface: "TRACKING_PAGE",
      ctaLabel: "Reorder now",
      ctaUrl: "/seller/growth/reorder",
      metadata: {
        buyerEmail: "buyer@example.com",
        cohort: "repeat"
      }
    }, client);
    assert.equal(campaign.campaignId, "campaign_1");
    assert.equal("metadata" in campaign, false);
    assert.equal(state.campaigns[0]?.metadata?.buyerEmail, undefined);

    await submitMerchantCampaign(campaign.campaignId, client);
    const policy = await runCampaignPolicyCheck(campaign.campaignId, client);
    assert.equal(policy.passed, true);

    const approved = await approveCampaignFromReview(campaign.campaignId, {
      reviewerRef: "ops_reviewer",
      reason: "Looks good"
    }, client);
    assert.equal(approved.reviewStatus, "APPROVED");

    const active = await activateMerchantCampaign(campaign.campaignId, client);
    assert.equal(active.status, "ACTIVE");
    assert.equal(active.growthOfferId, "offer_1");
    assert.equal(state.offerPlacements.length, 1);

    const cards = await resolveMerchantCampaignCardsForSurface("TRACKING_PAGE", {
      merchantId: "merchant_1",
      sellerId: null,
      max: 3
    }, client);
    assert.equal(cards.offers.length, 1);
    assert.equal(cards.offers[0]?.label, "Merchant Offer");

    await recordMerchantCampaignEvent({
      campaignId: campaign.campaignId,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      eventType: "IMPRESSION",
      surface: "TRACKING_PAGE",
      metadata: { buyerPhone: "9999999999" }
    }, client);
    await recordMerchantCampaignEvent({
      campaignId: campaign.campaignId,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      eventType: "CLICK",
      surface: "TRACKING_PAGE"
    }, client);
    await recordMerchantCampaignEvent({
      campaignId: campaign.campaignId,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      eventType: "CONVERSION_SIMULATED",
      surface: "TRACKING_PAGE"
    }, client);

    const campaignAnalytics = await getCampaignAnalytics(campaign.campaignId, client);
    assert.equal(campaignAnalytics.metrics.impressions, 1);
    assert.equal(campaignAnalytics.metrics.clicks, 1);
    assert.equal(campaignAnalytics.metrics.simulatedConversions, 1);
    assert.equal(campaignAnalytics.revenueMode, "none");
    assert.equal(campaignAnalytics.roasMode, "not_calculated");

    const summary = await getCampaignAnalyticsSummary({ merchantId: "merchant_1" }, client);
    assert.equal(summary.activeCampaigns, 1);
    assert.equal(summary.topCampaignByClicks?.campaignId, campaign.campaignId);
    assert.equal(summary.billingMode, "none");

    const bySurface = await getCampaignAnalyticsBySurface({ merchantId: "merchant_1" }, client);
    assert.equal(bySurface.groups[0]?.surface, "TRACKING_PAGE");

    const byType = await getCampaignAnalyticsByType({ merchantId: "merchant_1" }, client);
    assert.equal(byType.groups[0]?.campaignType, "TRACKING_REORDER");
  });

  it("blocks unsafe campaign review approval before activation", async () => {
    const { client } = makeGrowthNetworkMaturityClient();
    const campaign = await createMerchantCampaign({
      merchantId: "merchant_1",
      title: "Shiprocket reorder boost",
      description: "Provider specific text should not go public",
      campaignType: "TRACKING_REORDER",
      surface: "SELLER_DASHBOARD",
      ctaLabel: "Reorder",
      ctaUrl: "/seller/growth/reorder"
    }, client);
    await submitMerchantCampaign(campaign.campaignId, client);

    const policy = await runCampaignPolicyCheck(campaign.campaignId, client);
    assert.equal(policy.passed, false);
    await assert.rejects(
      approveCampaignFromReview(campaign.campaignId, { reviewerRef: "reviewer" }, client),
      /MERCHANT_CAMPAIGN_POLICY_CHECK_FAILED/
    );
  });

  it("requires usable consent before simulated partner lead routing", async () => {
    const { client } = makeGrowthNetworkMaturityClient();
    const consent = await createPartnerLeadConsent({
      partnerId: "partner_1",
      merchantId: "merchant_1",
      sellerId: "seller_1",
      consentStatus: "GRANTED",
      consentScope: { purpose: "growth_partner_simulation" },
      consentText: "Merchant consented to simulated partner lead routing."
    }, client);
    assert.equal(consent.consentStatus, "GRANTED");

    const intent = await createPartnerLeadRoutingIntent({
      partnerId: "partner_1",
      leadId: "lead_1",
      consentId: consent.consentId,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      routingSnapshot: {
        buyerEmail: "buyer@example.com",
        segment: "packaging"
      },
      idempotencyKey: "route_1"
    }, client);
    assert.equal(intent.routingStatus, "READY_SIMULATED");
    assert.equal(intent.routingSnapshot.buyerEmail, undefined);

    const duplicate = await createPartnerLeadRoutingIntent({
      partnerId: "partner_1",
      leadId: "lead_1",
      consentId: consent.consentId,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      routingSnapshot: {},
      idempotencyKey: "route_1"
    }, client);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.intentId, intent.intentId);

    const readiness = await getPartnerLeadRoutingReadiness(intent.intentId, client);
    assert.equal(readiness.ready, true);

    const routed = await simulatePartnerLeadRouting(intent.intentId, {
      routingSnapshot: { operatorRef: "ops_user" }
    }, client);
    assert.equal(routed.routingStatus, "ROUTED_SIMULATED");
    assert.equal(routed.routingMode, "simulated_no_external_delivery");

    await updatePartnerLeadConsentStatus(consent.consentId, { consentStatus: "REVOKED" }, client);
    const blocked = await createPartnerLeadRoutingIntent({
      partnerId: "partner_1",
      leadId: "lead_1",
      merchantId: "merchant_1",
      sellerId: "seller_1",
      routingSnapshot: {}
    }, client);
    assert.equal(blocked.routingStatus, "CONSENT_REQUIRED");
  });

  it("gates billing simulation events behind legal and finance readiness", async () => {
    const { client } = makeGrowthNetworkMaturityClient();

    await assert.rejects(
      upsertBillingReadinessProfile({
        merchantId: "merchant_1",
        partnerId: "partner_1",
        readinessStatus: "READY_SIMULATED"
      }, client),
      /LEGAL_REVIEW_REF_REQUIRED/
    );

    const profile = await upsertBillingReadinessProfile({
      merchantId: "merchant_1",
      partnerId: "partner_1",
      readinessStatus: "READY_SIMULATED",
      legalReviewRef: "legal_approved_1",
      financeReviewRef: "finance_approved_1",
      notes: "Simulation only"
    }, client);
    assert.equal(profile.readinessStatus, "READY_SIMULATED");
    assert.equal(profile.billingMode, "none");

    const readiness = await checkBillingReadiness({
      merchantId: "merchant_1",
      partnerId: "partner_1"
    }, client);
    assert.equal(readiness.ready, true);

    const event = await createBillingSimulationEvent({
      merchantId: "merchant_1",
      partnerId: "partner_1",
      leadId: "lead_1",
      eventType: "SIMULATED_INVOICE_DRAFTED",
      amountPaise: 12500,
      currency: "INR",
      simulationSnapshot: {
        invoiceNumber: "INV-001",
        paymentGateway: "Stripe"
      }
    }, client);
    assert.equal(event.eventType, "SIMULATED_INVOICE_DRAFTED");
    assert.equal(event.invoiceMode, "draft_simulation_only");
    assert.equal(event.simulationSnapshot.invoiceNumber, undefined);
    assert.equal(event.billingMode, "none");
  });
});
