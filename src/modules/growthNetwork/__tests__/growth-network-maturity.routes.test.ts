import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";

import { errorHandler } from "../../../middleware/error.js";
import { createGrowthNetworkRouter } from "../growth-network.routes.js";
import { makeGrowthNetworkMaturityClient } from "./growth-network-maturity-test-utils.js";

async function makeApp(client: any) {
  const app = express();
  app.use(express.json());
  app.use("/growth-network", createGrowthNetworkRouter({ client }));
  app.use(errorHandler);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

describe("growth network maturity routes", () => {
  const servers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(servers.map((close) => close()));
  });

  it("wires merchant campaigns, review, partner routing, and billing readiness routes", async () => {
    const { client } = makeGrowthNetworkMaturityClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const created = await request(app.baseUrl, "/growth-network/merchant-campaigns", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        title: "Tracking reorder route",
        campaign_type: "TRACKING_REORDER",
        surface: "TRACKING_PAGE",
        cta_label: "Reorder",
        cta_url: "/seller/growth/reorder",
        metadata: { buyerEmail: "buyer@example.com" }
      })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.campaignId, "campaign_1");
    assert.equal("metadata" in created.body.data, false);

    const submitted = await request(app.baseUrl, "/growth-network/merchant-campaigns/campaign_1/submit", {
      method: "POST"
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.data.reviewStatus, "PENDING");

    const reviewQueue = await request(app.baseUrl, "/growth-network/admin/campaigns/review-queue?merchant_id=merchant_1");
    assert.equal(reviewQueue.status, 200);
    assert.equal(reviewQueue.body.data.pagination.total, 1);

    const approved = await request(app.baseUrl, "/growth-network/admin/campaigns/campaign_1/approve", {
      method: "POST",
      body: JSON.stringify({ reviewer_ref: "ops" })
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.reviewStatus, "APPROVED");

    const activated = await request(app.baseUrl, "/growth-network/merchant-campaigns/campaign_1/activate", {
      method: "POST"
    });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.data.status, "ACTIVE");

    const card = await request(app.baseUrl, "/growth-network/merchant-campaigns/placements/TRACKING_PAGE/offers?merchant_id=merchant_1");
    assert.equal(card.status, 200);
    assert.equal(card.body.data.offers.length, 1);

    const event = await request(app.baseUrl, "/growth-network/merchant-campaigns/events", {
      method: "POST",
      body: JSON.stringify({
        campaign_id: "campaign_1",
        event_type: "IMPRESSION",
        surface: "TRACKING_PAGE"
      })
    });
    assert.equal(event.status, 201);

    const analytics = await request(app.baseUrl, "/growth-network/merchant-campaigns/campaign_1/analytics");
    assert.equal(analytics.status, 200);
    assert.equal(analytics.body.data.metrics.impressions, 1);
    assert.equal(analytics.body.data.billingMode, "none");

    const summary = await request(app.baseUrl, "/growth-network/merchant-campaigns/analytics/summary?merchant_id=merchant_1");
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.activeCampaigns, 1);

    const consent = await request(app.baseUrl, "/growth-network/partners/lead-consents", {
      method: "POST",
      body: JSON.stringify({
        partner_id: "partner_1",
        merchant_id: "merchant_1",
        seller_id: "seller_1",
        consent_text: "Merchant consented to simulated partner lead routing."
      })
    });
    assert.equal(consent.status, 201);
    assert.equal(consent.body.data.consentId, "consent_1");

    const intent = await request(app.baseUrl, "/growth-network/partners/routing-intents", {
      method: "POST",
      body: JSON.stringify({
        partner_id: "partner_1",
        lead_id: "lead_1",
        consent_id: "consent_1",
        merchant_id: "merchant_1",
        seller_id: "seller_1",
        routing_snapshot: { buyerPhone: "9999999999", segment: "packaging" }
      })
    });
    assert.equal(intent.status, 201);
    assert.equal(intent.body.data.routingStatus, "READY_SIMULATED");
    assert.equal(intent.body.data.routingSnapshot.buyerPhone, undefined);

    const simulatedRoute = await request(app.baseUrl, "/growth-network/partners/routing-intents/intent_1/simulate-route", {
      method: "POST",
      body: JSON.stringify({ routing_snapshot: { operatorRef: "ops" } })
    });
    assert.equal(simulatedRoute.status, 200);
    assert.equal(simulatedRoute.body.data.routingStatus, "ROUTED_SIMULATED");

    const blockedBilling = await request(app.baseUrl, "/growth-network/billing-readiness/profiles", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        partner_id: "partner_1",
        readiness_status: "READY_SIMULATED"
      })
    });
    assert.equal(blockedBilling.status, 409);
    assert.equal(blockedBilling.body.error, "LEGAL_REVIEW_REF_REQUIRED");

    const profile = await request(app.baseUrl, "/growth-network/billing-readiness/profiles", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        partner_id: "partner_1",
        readiness_status: "READY_SIMULATED",
        legal_review_ref: "legal_ok",
        finance_review_ref: "finance_ok"
      })
    });
    assert.equal(profile.status, 201);
    assert.equal(profile.body.data.readinessStatus, "READY_SIMULATED");

    const billingEvent = await request(app.baseUrl, "/growth-network/billing-readiness/simulation-events", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        partner_id: "partner_1",
        lead_id: "lead_1",
        event_type: "SIMULATED_CHARGE_CREATED",
        amount_paise: 5000,
        simulation_snapshot: { invoiceNumber: "INV-ROUTE-1" }
      })
    });
    assert.equal(billingEvent.status, 201);
    assert.equal(billingEvent.body.data.billingMode, "none");
    assert.equal(billingEvent.body.data.simulationSnapshot.invoiceNumber, undefined);
  });
});
