-- Phase 45F-J Growth Network maturity foundation.
-- Additive only. No generic ad network, external ad calls, real partner routing, billing execution,
-- payable invoice creation, payouts, payment gateway calls, communications sending, courier/provider calls,
-- buyer PII export, or courier/provider public exposure.

CREATE TYPE "MerchantCampaignStatus" AS ENUM (
  'DRAFT',
  'PENDING_REVIEW',
  'ACTIVE',
  'PAUSED',
  'REJECTED',
  'ARCHIVED'
);

CREATE TYPE "MerchantCampaignType" AS ENUM (
  'TRACKING_REORDER',
  'COD_TO_PREPAID',
  'RTO_NDR_RECOVERY',
  'CROSS_SELL',
  'PACKAGING_QUALITY',
  'CUSTOM_MESSAGE'
);

CREATE TYPE "MerchantCampaignReviewStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "MerchantCampaignEventType" AS ENUM (
  'CREATED',
  'UPDATED',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'ACTIVATED',
  'PAUSED',
  'ARCHIVED',
  'IMPRESSION',
  'CLICK',
  'DISMISS',
  'CONVERSION_SIMULATED'
);

CREATE TYPE "PartnerLeadConsentStatus" AS ENUM (
  'DRAFT',
  'GRANTED',
  'REVOKED',
  'EXPIRED'
);

CREATE TYPE "PartnerLeadRoutingStatus" AS ENUM (
  'CREATED',
  'CONSENT_REQUIRED',
  'READY_SIMULATED',
  'ROUTED_SIMULATED',
  'BLOCKED',
  'CANCELLED',
  'ARCHIVED'
);

CREATE TYPE "GrowthBillingReadinessStatus" AS ENUM (
  'NOT_READY',
  'LEGAL_REVIEW_REQUIRED',
  'FINANCE_REVIEW_REQUIRED',
  'READY_SIMULATED',
  'DISABLED'
);

CREATE TYPE "GrowthBillingEventType" AS ENUM (
  'READINESS_CHECK',
  'SIMULATED_CHARGE_CREATED',
  'SIMULATED_INVOICE_DRAFTED',
  'SIMULATED_INVOICE_VOIDED'
);

CREATE TABLE "merchant_campaigns" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "campaign_type" "MerchantCampaignType" NOT NULL,
  "status" "MerchantCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "review_status" "MerchantCampaignReviewStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "rejection_reason" TEXT,
  "growth_offer_id" TEXT,
  "surface" "GrowthPlacementSurface" NOT NULL DEFAULT 'SELLER_DASHBOARD',
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "cta_label" TEXT NOT NULL,
  "cta_url" TEXT,
  "rules_json" JSONB,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_campaign_events" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "event_type" "MerchantCampaignEventType" NOT NULL,
  "surface" "GrowthPlacementSurface",
  "growth_offer_event_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_campaign_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_campaign_reviews" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "reviewer_ref" TEXT,
  "review_status" "MerchantCampaignReviewStatus" NOT NULL,
  "decision_reason" TEXT,
  "policy_checklist" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_campaign_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "partner_lead_consents" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT,
  "merchant_id" TEXT NOT NULL,
  "seller_id" TEXT,
  "consent_status" "PartnerLeadConsentStatus" NOT NULL DEFAULT 'DRAFT',
  "consent_scope" JSONB NOT NULL,
  "consent_text" TEXT NOT NULL,
  "granted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_lead_consents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "partner_lead_routing_intents" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT,
  "lead_id" TEXT,
  "consent_id" TEXT,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "routing_status" "PartnerLeadRoutingStatus" NOT NULL DEFAULT 'CREATED',
  "routing_snapshot" JSONB NOT NULL,
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_lead_routing_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_billing_readiness_profiles" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "partner_id" TEXT,
  "readiness_status" "GrowthBillingReadinessStatus" NOT NULL DEFAULT 'NOT_READY',
  "legal_review_ref" TEXT,
  "finance_review_ref" TEXT,
  "notes" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "growth_billing_readiness_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_billing_simulation_events" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "partner_id" TEXT,
  "campaign_id" TEXT,
  "lead_id" TEXT,
  "event_type" "GrowthBillingEventType" NOT NULL,
  "amount_paise" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "simulation_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "growth_billing_simulation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "merchant_campaigns_merchant_id_idx" ON "merchant_campaigns"("merchant_id");
CREATE INDEX "merchant_campaigns_campaign_type_idx" ON "merchant_campaigns"("campaign_type");
CREATE INDEX "merchant_campaigns_status_idx" ON "merchant_campaigns"("status");
CREATE INDEX "merchant_campaigns_review_status_idx" ON "merchant_campaigns"("review_status");
CREATE INDEX "merchant_campaigns_growth_offer_id_idx" ON "merchant_campaigns"("growth_offer_id");
CREATE INDEX "merchant_campaigns_surface_idx" ON "merchant_campaigns"("surface");
CREATE INDEX "merchant_campaigns_starts_at_idx" ON "merchant_campaigns"("starts_at");
CREATE INDEX "merchant_campaigns_ends_at_idx" ON "merchant_campaigns"("ends_at");
CREATE INDEX "merchant_campaigns_created_at_idx" ON "merchant_campaigns"("created_at");

CREATE INDEX "merchant_campaign_events_campaign_id_idx" ON "merchant_campaign_events"("campaign_id");
CREATE INDEX "merchant_campaign_events_merchant_id_idx" ON "merchant_campaign_events"("merchant_id");
CREATE INDEX "merchant_campaign_events_seller_id_idx" ON "merchant_campaign_events"("seller_id");
CREATE INDEX "merchant_campaign_events_event_type_idx" ON "merchant_campaign_events"("event_type");
CREATE INDEX "merchant_campaign_events_surface_idx" ON "merchant_campaign_events"("surface");
CREATE INDEX "merchant_campaign_events_growth_offer_event_id_idx" ON "merchant_campaign_events"("growth_offer_event_id");
CREATE INDEX "merchant_campaign_events_created_at_idx" ON "merchant_campaign_events"("created_at");

CREATE INDEX "merchant_campaign_reviews_campaign_id_idx" ON "merchant_campaign_reviews"("campaign_id");
CREATE INDEX "merchant_campaign_reviews_review_status_idx" ON "merchant_campaign_reviews"("review_status");
CREATE INDEX "merchant_campaign_reviews_created_at_idx" ON "merchant_campaign_reviews"("created_at");

CREATE INDEX "partner_lead_consents_partner_id_idx" ON "partner_lead_consents"("partner_id");
CREATE INDEX "partner_lead_consents_merchant_id_idx" ON "partner_lead_consents"("merchant_id");
CREATE INDEX "partner_lead_consents_seller_id_idx" ON "partner_lead_consents"("seller_id");
CREATE INDEX "partner_lead_consents_consent_status_idx" ON "partner_lead_consents"("consent_status");
CREATE INDEX "partner_lead_consents_expires_at_idx" ON "partner_lead_consents"("expires_at");
CREATE INDEX "partner_lead_consents_created_at_idx" ON "partner_lead_consents"("created_at");

CREATE UNIQUE INDEX "partner_lead_routing_intents_idempotency_key_key" ON "partner_lead_routing_intents"("idempotency_key");
CREATE INDEX "partner_lead_routing_intents_partner_id_idx" ON "partner_lead_routing_intents"("partner_id");
CREATE INDEX "partner_lead_routing_intents_lead_id_idx" ON "partner_lead_routing_intents"("lead_id");
CREATE INDEX "partner_lead_routing_intents_consent_id_idx" ON "partner_lead_routing_intents"("consent_id");
CREATE INDEX "partner_lead_routing_intents_merchant_id_idx" ON "partner_lead_routing_intents"("merchant_id");
CREATE INDEX "partner_lead_routing_intents_seller_id_idx" ON "partner_lead_routing_intents"("seller_id");
CREATE INDEX "partner_lead_routing_intents_routing_status_idx" ON "partner_lead_routing_intents"("routing_status");
CREATE INDEX "partner_lead_routing_intents_created_at_idx" ON "partner_lead_routing_intents"("created_at");

CREATE INDEX "growth_billing_readiness_profiles_merchant_id_idx" ON "growth_billing_readiness_profiles"("merchant_id");
CREATE INDEX "growth_billing_readiness_profiles_partner_id_idx" ON "growth_billing_readiness_profiles"("partner_id");
CREATE INDEX "growth_billing_readiness_profiles_readiness_status_idx" ON "growth_billing_readiness_profiles"("readiness_status");
CREATE INDEX "growth_billing_readiness_profiles_created_at_idx" ON "growth_billing_readiness_profiles"("created_at");

CREATE INDEX "growth_billing_simulation_events_merchant_id_idx" ON "growth_billing_simulation_events"("merchant_id");
CREATE INDEX "growth_billing_simulation_events_partner_id_idx" ON "growth_billing_simulation_events"("partner_id");
CREATE INDEX "growth_billing_simulation_events_campaign_id_idx" ON "growth_billing_simulation_events"("campaign_id");
CREATE INDEX "growth_billing_simulation_events_lead_id_idx" ON "growth_billing_simulation_events"("lead_id");
CREATE INDEX "growth_billing_simulation_events_event_type_idx" ON "growth_billing_simulation_events"("event_type");
CREATE INDEX "growth_billing_simulation_events_created_at_idx" ON "growth_billing_simulation_events"("created_at");
