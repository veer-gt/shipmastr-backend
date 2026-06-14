-- Phase 45E partner marketplace, attribution, and ROAS foundation.
-- Additive only. No external ad network calls, sponsor integration, billing, payouts, invoices, payment gateway calls,
-- buyer PII export, courier/provider calls, or partner lead routing.

CREATE TYPE "GrowthPartnerStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED'
);

CREATE TYPE "GrowthPartnerCategory" AS ENUM (
  'PACKAGING',
  'INSURANCE',
  'FINANCING',
  'STORE_GROWTH_TOOL',
  'DOMAIN_HOSTING',
  'DESIGN_THEME',
  'RETURNS_MANAGEMENT',
  'CUSTOMER_SUPPORT',
  'ANALYTICS',
  'OTHER'
);

CREATE TYPE "GrowthPartnerLeadStatus" AS ENUM (
  'CAPTURED',
  'QUALIFIED_SIMULATED',
  'DISQUALIFIED',
  'ARCHIVED'
);

CREATE TYPE "GrowthAttributionEventType" AS ENUM (
  'IMPRESSION',
  'CLICK',
  'LEAD_CAPTURED',
  'CONVERSION_SIMULATED',
  'DISMISS'
);

CREATE TABLE "growth_partners" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "category" "GrowthPartnerCategory" NOT NULL,
  "status" "GrowthPartnerStatus" NOT NULL DEFAULT 'DRAFT',
  "description" TEXT,
  "website_url" TEXT,
  "is_sponsored" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "growth_partners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_partner_placements" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT NOT NULL,
  "offer_id" TEXT,
  "surface" "GrowthPlacementSurface" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "rules_json" JSONB,
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "growth_partner_placements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_partner_leads" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "offer_id" TEXT,
  "shipment_id" TEXT,
  "order_id" TEXT,
  "status" "GrowthPartnerLeadStatus" NOT NULL DEFAULT 'CAPTURED',
  "source_surface" "GrowthPlacementSurface" NOT NULL,
  "attribution_ref" TEXT,
  "idempotency_key" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "growth_partner_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_partner_attribution_events" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT,
  "offer_id" TEXT,
  "lead_id" TEXT,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "event_type" "GrowthAttributionEventType" NOT NULL,
  "surface" "GrowthPlacementSurface" NOT NULL,
  "attribution_ref" TEXT,
  "session_ref" TEXT,
  "idempotency_key" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "growth_partner_attribution_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "growth_partners_name_key" ON "growth_partners"("name");
CREATE INDEX "growth_partners_category_idx" ON "growth_partners"("category");
CREATE INDEX "growth_partners_status_idx" ON "growth_partners"("status");
CREATE INDEX "growth_partners_created_at_idx" ON "growth_partners"("created_at");

CREATE INDEX "growth_partner_placements_partner_id_idx" ON "growth_partner_placements"("partner_id");
CREATE INDEX "growth_partner_placements_offer_id_idx" ON "growth_partner_placements"("offer_id");
CREATE INDEX "growth_partner_placements_surface_priority_idx" ON "growth_partner_placements"("surface", "priority");
CREATE INDEX "growth_partner_placements_starts_at_idx" ON "growth_partner_placements"("starts_at");
CREATE INDEX "growth_partner_placements_ends_at_idx" ON "growth_partner_placements"("ends_at");
CREATE INDEX "growth_partner_placements_created_at_idx" ON "growth_partner_placements"("created_at");

CREATE UNIQUE INDEX "growth_partner_leads_idempotency_key_key" ON "growth_partner_leads"("idempotency_key");
CREATE INDEX "growth_partner_leads_partner_id_idx" ON "growth_partner_leads"("partner_id");
CREATE INDEX "growth_partner_leads_merchant_id_idx" ON "growth_partner_leads"("merchant_id");
CREATE INDEX "growth_partner_leads_seller_id_idx" ON "growth_partner_leads"("seller_id");
CREATE INDEX "growth_partner_leads_offer_id_idx" ON "growth_partner_leads"("offer_id");
CREATE INDEX "growth_partner_leads_shipment_id_idx" ON "growth_partner_leads"("shipment_id");
CREATE INDEX "growth_partner_leads_order_id_idx" ON "growth_partner_leads"("order_id");
CREATE INDEX "growth_partner_leads_status_idx" ON "growth_partner_leads"("status");
CREATE INDEX "growth_partner_leads_source_surface_idx" ON "growth_partner_leads"("source_surface");
CREATE INDEX "growth_partner_leads_attribution_ref_idx" ON "growth_partner_leads"("attribution_ref");
CREATE INDEX "growth_partner_leads_created_at_idx" ON "growth_partner_leads"("created_at");

CREATE UNIQUE INDEX "growth_partner_attribution_events_idempotency_key_key" ON "growth_partner_attribution_events"("idempotency_key");
CREATE INDEX "growth_partner_attribution_events_partner_id_idx" ON "growth_partner_attribution_events"("partner_id");
CREATE INDEX "growth_partner_attribution_events_offer_id_idx" ON "growth_partner_attribution_events"("offer_id");
CREATE INDEX "growth_partner_attribution_events_lead_id_idx" ON "growth_partner_attribution_events"("lead_id");
CREATE INDEX "growth_partner_attribution_events_merchant_id_idx" ON "growth_partner_attribution_events"("merchant_id");
CREATE INDEX "growth_partner_attribution_events_seller_id_idx" ON "growth_partner_attribution_events"("seller_id");
CREATE INDEX "growth_partner_attribution_events_event_type_idx" ON "growth_partner_attribution_events"("event_type");
CREATE INDEX "growth_partner_attribution_events_surface_idx" ON "growth_partner_attribution_events"("surface");
CREATE INDEX "growth_partner_attribution_events_attribution_ref_idx" ON "growth_partner_attribution_events"("attribution_ref");
CREATE INDEX "growth_partner_attribution_events_created_at_idx" ON "growth_partner_attribution_events"("created_at");
