-- Phase 45A: Tracking offer engine and growth telemetry foundation.
-- Additive only. No external ad network, billing, partner marketplace, or provider/courier calls.

CREATE TYPE "GrowthPlacementSurface" AS ENUM (
  'TRACKING_PAGE',
  'SELLER_DASHBOARD',
  'CHECKOUT',
  'POST_DELIVERY',
  'NDR_ACTION',
  'BUILD_ON_SHIPMASTR'
);

CREATE TYPE "GrowthOfferType" AS ENUM (
  'MERCHANT_REORDER',
  'MERCHANT_CROSS_SELL',
  'PREPAID_INCENTIVE',
  'COD_RISK_REDUCTION',
  'PACKAGING_RECOMMENDATION',
  'INSURANCE_RECOMMENDATION',
  'PARTNER_SPONSORED',
  'STORE_GROWTH_TOOL'
);

CREATE TYPE "GrowthOfferStatus" AS ENUM (
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ARCHIVED'
);

CREATE TYPE "GrowthEventType" AS ENUM (
  'VIEW',
  'IMPRESSION',
  'CLICK',
  'DISMISS',
  'CONVERSION'
);

CREATE TABLE "growth_offers" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "title" TEXT NOT NULL,
  "subtitle" TEXT,
  "description" TEXT,
  "type" "GrowthOfferType" NOT NULL,
  "status" "GrowthOfferStatus" NOT NULL DEFAULT 'DRAFT',
  "is_sponsored" BOOLEAN NOT NULL DEFAULT false,
  "sponsor_name" TEXT,
  "cta_label" TEXT NOT NULL,
  "cta_url" TEXT,
  "metadata" JSONB,
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "growth_offers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_offer_placements" (
  "id" TEXT NOT NULL,
  "offer_id" TEXT NOT NULL,
  "surface" "GrowthPlacementSurface" NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "rules_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "growth_offer_placements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_offer_events" (
  "id" TEXT NOT NULL,
  "offer_id" TEXT,
  "merchant_id" TEXT,
  "seller_id" TEXT,
  "shipment_id" TEXT,
  "order_id" TEXT,
  "event_type" "GrowthEventType" NOT NULL,
  "surface" "GrowthPlacementSurface" NOT NULL,
  "anonymous_buyer_ref" TEXT,
  "session_ref" TEXT,
  "idempotency_key" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "growth_offer_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "growth_offer_placements"
  ADD CONSTRAINT "growth_offer_placements_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "growth_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "growth_offer_events"
  ADD CONSTRAINT "growth_offer_events_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "growth_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "growth_offers_merchant_id_idx" ON "growth_offers"("merchant_id");
CREATE INDEX "growth_offers_type_idx" ON "growth_offers"("type");
CREATE INDEX "growth_offers_status_idx" ON "growth_offers"("status");
CREATE INDEX "growth_offers_starts_at_idx" ON "growth_offers"("starts_at");
CREATE INDEX "growth_offers_ends_at_idx" ON "growth_offers"("ends_at");
CREATE INDEX "growth_offers_created_at_idx" ON "growth_offers"("created_at");

CREATE INDEX "growth_offer_placements_offer_id_idx" ON "growth_offer_placements"("offer_id");
CREATE INDEX "growth_offer_placements_surface_priority_idx" ON "growth_offer_placements"("surface", "priority");
CREATE INDEX "growth_offer_placements_created_at_idx" ON "growth_offer_placements"("created_at");

CREATE UNIQUE INDEX "growth_offer_events_idempotency_key_key" ON "growth_offer_events"("idempotency_key");
CREATE INDEX "growth_offer_events_offer_id_idx" ON "growth_offer_events"("offer_id");
CREATE INDEX "growth_offer_events_merchant_id_idx" ON "growth_offer_events"("merchant_id");
CREATE INDEX "growth_offer_events_seller_id_idx" ON "growth_offer_events"("seller_id");
CREATE INDEX "growth_offer_events_shipment_id_idx" ON "growth_offer_events"("shipment_id");
CREATE INDEX "growth_offer_events_order_id_idx" ON "growth_offer_events"("order_id");
CREATE INDEX "growth_offer_events_event_type_idx" ON "growth_offer_events"("event_type");
CREATE INDEX "growth_offer_events_surface_idx" ON "growth_offer_events"("surface");
CREATE INDEX "growth_offer_events_created_at_idx" ON "growth_offer_events"("created_at");
