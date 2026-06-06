CREATE TYPE "public"."ShippingPaymentMode" AS ENUM ('prepaid', 'cod');
CREATE TYPE "public"."CourierPartnerStatus" AS ENUM ('active', 'inactive', 'testing', 'suspended', 'failed');
CREATE TYPE "public"."SellerCourierPartnerStatus" AS ENUM ('active', 'inactive', 'suspended', 'failed');
CREATE TYPE "public"."PartnerType" AS ENUM ('system_managed', 'seller_owned', 'merchant_owned');
CREATE TYPE "public"."ShipmentStatus" AS ENUM (
  'draft',
  'rates_fetched',
  'manifested',
  'pickup_scheduled',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'rto_initiated',
  'rto_in_transit',
  'rto_delivered',
  'cancelled',
  'lost',
  'damaged',
  'exception'
);
CREATE TYPE "public"."ShipmentSegment" AS ENUM ('domestic_b2c', 'domestic_b2b', 'hyperlocal');

ALTER TABLE "public"."CourierPartner"
  ADD COLUMN "status" "public"."CourierPartnerStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "isSystemManaged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "defaultForNewSellers" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "credentialsRequiredFromSeller" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'IN',
  ADD COLUMN "supportedSegments" "public"."ShipmentSegment"[] NOT NULL DEFAULT ARRAY[]::"public"."ShipmentSegment"[];

CREATE TABLE "public"."seller_courier_partners" (
  "id" TEXT NOT NULL,
  "seller_id" TEXT NOT NULL,
  "courier_partner_id" TEXT NOT NULL,
  "status" "public"."SellerCourierPartnerStatus" NOT NULL DEFAULT 'active',
  "partner_type" "public"."PartnerType" NOT NULL DEFAULT 'system_managed',
  "credentials_required_from_seller" BOOLEAN NOT NULL DEFAULT false,
  "enabled_segments" "public"."ShipmentSegment"[] NOT NULL DEFAULT ARRAY[]::"public"."ShipmentSegment"[],
  "country" TEXT NOT NULL DEFAULT 'IN',
  "display_code" TEXT NOT NULL DEFAULT 'shipmastr_courier_network',
  "display_name" TEXT NOT NULL DEFAULT 'Shipmastr Courier Network',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "seller_courier_partners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."pickup_locations" (
  "id" TEXT NOT NULL,
  "seller_id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "contact_name" TEXT,
  "phone" TEXT,
  "address_line1" TEXT,
  "address_line2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "pincode" TEXT,
  "country" TEXT NOT NULL DEFAULT 'IN',
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pickup_locations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."pickup_location_provider_mappings" (
  "id" TEXT NOT NULL,
  "pickup_location_id" TEXT NOT NULL,
  "seller_courier_partner_id" TEXT,
  "courier_partner_id" TEXT NOT NULL,
  "provider_pickup_id" TEXT,
  "provider_code" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pickup_location_provider_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."shipments" (
  "id" TEXT NOT NULL,
  "seller_id" TEXT NOT NULL,
  "order_id" TEXT,
  "external_order_id" TEXT,
  "pickup_location_id" TEXT,
  "seller_courier_partner_id" TEXT,
  "courier_partner_id" TEXT,
  "segment" "public"."ShipmentSegment" NOT NULL DEFAULT 'domestic_b2c',
  "status" "public"."ShipmentStatus" NOT NULL DEFAULT 'draft',
  "payment_mode" "public"."ShippingPaymentMode" NOT NULL DEFAULT 'prepaid',
  "cod_amount_paise" INTEGER NOT NULL DEFAULT 0,
  "declared_value_paise" INTEGER,
  "from_pincode" TEXT,
  "to_pincode" TEXT,
  "dead_weight_kg" NUMERIC(10,3),
  "length_cm" NUMERIC(10,2),
  "breadth_cm" NUMERIC(10,2),
  "height_cm" NUMERIC(10,2),
  "volumetric_divisor" INTEGER NOT NULL DEFAULT 5000,
  "volumetric_weight_kg" NUMERIC(10,3),
  "chargeable_weight_kg" NUMERIC(10,3),
  "service_level" TEXT,
  "awb_number" TEXT,
  "tracking_url" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."shipment_provider_refs" (
  "id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "courier_partner_id" TEXT,
  "provider_shipment_id" TEXT,
  "provider_awb" TEXT,
  "provider_order_id" TEXT,
  "provider_pickup_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shipment_provider_refs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."shipment_rates" (
  "id" TEXT NOT NULL,
  "shipment_id" TEXT,
  "seller_id" TEXT NOT NULL,
  "seller_courier_partner_id" TEXT,
  "courier_partner_id" TEXT,
  "public_service_code" TEXT NOT NULL DEFAULT 'shipmastr_smart',
  "public_service_name" TEXT NOT NULL DEFAULT 'Shipmastr Smart',
  "segment" "public"."ShipmentSegment" NOT NULL DEFAULT 'domestic_b2c',
  "chargeable_weight_kg" NUMERIC(10,3),
  "amount_paise" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "estimated_delivery_days" INTEGER,
  "rate_breakup" JSONB,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shipment_rates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."shipment_tracking_events" (
  "id" TEXT NOT NULL,
  "shipment_id" TEXT NOT NULL,
  "courier_partner_id" TEXT,
  "status" "public"."ShipmentStatus" NOT NULL,
  "event_code" TEXT,
  "event_label" TEXT NOT NULL,
  "public_message" TEXT,
  "location" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "provider_event_id" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shipment_tracking_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seller_courier_partners_seller_id_courier_partner_id_key" ON "public"."seller_courier_partners"("seller_id", "courier_partner_id");
CREATE INDEX "seller_courier_partners_seller_id_idx" ON "public"."seller_courier_partners"("seller_id");
CREATE INDEX "seller_courier_partners_courier_partner_id_idx" ON "public"."seller_courier_partners"("courier_partner_id");
CREATE INDEX "seller_courier_partners_status_idx" ON "public"."seller_courier_partners"("status");
CREATE INDEX "seller_courier_partners_partner_type_idx" ON "public"."seller_courier_partners"("partner_type");
CREATE INDEX "seller_courier_partners_country_idx" ON "public"."seller_courier_partners"("country");

CREATE INDEX "pickup_locations_seller_id_idx" ON "public"."pickup_locations"("seller_id");
CREATE INDEX "pickup_locations_seller_id_status_idx" ON "public"."pickup_locations"("seller_id", "status");
CREATE INDEX "pickup_locations_pincode_idx" ON "public"."pickup_locations"("pincode");
CREATE INDEX "pickup_locations_country_idx" ON "public"."pickup_locations"("country");

CREATE UNIQUE INDEX "pickup_location_provider_mappings_pickup_location_id_courier_partner_id_key" ON "public"."pickup_location_provider_mappings"("pickup_location_id", "courier_partner_id");
CREATE INDEX "pickup_location_provider_mappings_pickup_location_id_idx" ON "public"."pickup_location_provider_mappings"("pickup_location_id");
CREATE INDEX "pickup_location_provider_mappings_seller_courier_partner_id_idx" ON "public"."pickup_location_provider_mappings"("seller_courier_partner_id");
CREATE INDEX "pickup_location_provider_mappings_courier_partner_id_idx" ON "public"."pickup_location_provider_mappings"("courier_partner_id");
CREATE INDEX "pickup_location_provider_mappings_provider_pickup_id_idx" ON "public"."pickup_location_provider_mappings"("provider_pickup_id");
CREATE INDEX "pickup_location_provider_mappings_status_idx" ON "public"."pickup_location_provider_mappings"("status");

CREATE UNIQUE INDEX "shipments_awb_number_key" ON "public"."shipments"("awb_number");
CREATE INDEX "shipments_seller_id_idx" ON "public"."shipments"("seller_id");
CREATE INDEX "shipments_order_id_idx" ON "public"."shipments"("order_id");
CREATE INDEX "shipments_external_order_id_idx" ON "public"."shipments"("external_order_id");
CREATE INDEX "shipments_pickup_location_id_idx" ON "public"."shipments"("pickup_location_id");
CREATE INDEX "shipments_seller_courier_partner_id_idx" ON "public"."shipments"("seller_courier_partner_id");
CREATE INDEX "shipments_courier_partner_id_idx" ON "public"."shipments"("courier_partner_id");
CREATE INDEX "shipments_status_idx" ON "public"."shipments"("status");
CREATE INDEX "shipments_segment_idx" ON "public"."shipments"("segment");
CREATE INDEX "shipments_payment_mode_idx" ON "public"."shipments"("payment_mode");
CREATE INDEX "shipments_from_pincode_to_pincode_idx" ON "public"."shipments"("from_pincode", "to_pincode");
CREATE INDEX "shipments_created_at_idx" ON "public"."shipments"("created_at");

CREATE INDEX "shipment_provider_refs_shipment_id_idx" ON "public"."shipment_provider_refs"("shipment_id");
CREATE INDEX "shipment_provider_refs_courier_partner_id_idx" ON "public"."shipment_provider_refs"("courier_partner_id");
CREATE INDEX "shipment_provider_refs_provider_shipment_id_idx" ON "public"."shipment_provider_refs"("provider_shipment_id");
CREATE INDEX "shipment_provider_refs_provider_awb_idx" ON "public"."shipment_provider_refs"("provider_awb");
CREATE INDEX "shipment_provider_refs_provider_order_id_idx" ON "public"."shipment_provider_refs"("provider_order_id");

CREATE INDEX "shipment_rates_shipment_id_idx" ON "public"."shipment_rates"("shipment_id");
CREATE INDEX "shipment_rates_seller_id_idx" ON "public"."shipment_rates"("seller_id");
CREATE INDEX "shipment_rates_seller_courier_partner_id_idx" ON "public"."shipment_rates"("seller_courier_partner_id");
CREATE INDEX "shipment_rates_courier_partner_id_idx" ON "public"."shipment_rates"("courier_partner_id");
CREATE INDEX "shipment_rates_public_service_code_idx" ON "public"."shipment_rates"("public_service_code");
CREATE INDEX "shipment_rates_segment_idx" ON "public"."shipment_rates"("segment");
CREATE INDEX "shipment_rates_created_at_idx" ON "public"."shipment_rates"("created_at");

CREATE INDEX "shipment_tracking_events_shipment_id_idx" ON "public"."shipment_tracking_events"("shipment_id");
CREATE INDEX "shipment_tracking_events_courier_partner_id_idx" ON "public"."shipment_tracking_events"("courier_partner_id");
CREATE INDEX "shipment_tracking_events_status_idx" ON "public"."shipment_tracking_events"("status");
CREATE INDEX "shipment_tracking_events_provider_event_id_idx" ON "public"."shipment_tracking_events"("provider_event_id");
CREATE INDEX "shipment_tracking_events_occurred_at_idx" ON "public"."shipment_tracking_events"("occurred_at");

CREATE INDEX "CourierPartner_status_idx" ON "public"."CourierPartner"("status");
CREATE INDEX "CourierPartner_isSystemManaged_idx" ON "public"."CourierPartner"("isSystemManaged");
CREATE INDEX "CourierPartner_defaultForNewSellers_idx" ON "public"."CourierPartner"("defaultForNewSellers");
CREATE INDEX "CourierPartner_country_idx" ON "public"."CourierPartner"("country");

ALTER TABLE "public"."seller_courier_partners"
  ADD CONSTRAINT "seller_courier_partners_courier_partner_id_fkey"
  FOREIGN KEY ("courier_partner_id") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."pickup_location_provider_mappings"
  ADD CONSTRAINT "pickup_location_provider_mappings_pickup_location_id_fkey"
  FOREIGN KEY ("pickup_location_id") REFERENCES "public"."pickup_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."pickup_location_provider_mappings"
  ADD CONSTRAINT "pickup_location_provider_mappings_seller_courier_partner_id_fkey"
  FOREIGN KEY ("seller_courier_partner_id") REFERENCES "public"."seller_courier_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."pickup_location_provider_mappings"
  ADD CONSTRAINT "pickup_location_provider_mappings_courier_partner_id_fkey"
  FOREIGN KEY ("courier_partner_id") REFERENCES "public"."CourierPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."shipments"
  ADD CONSTRAINT "shipments_pickup_location_id_fkey"
  FOREIGN KEY ("pickup_location_id") REFERENCES "public"."pickup_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."shipments"
  ADD CONSTRAINT "shipments_seller_courier_partner_id_fkey"
  FOREIGN KEY ("seller_courier_partner_id") REFERENCES "public"."seller_courier_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."shipments"
  ADD CONSTRAINT "shipments_courier_partner_id_fkey"
  FOREIGN KEY ("courier_partner_id") REFERENCES "public"."CourierPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_provider_refs"
  ADD CONSTRAINT "shipment_provider_refs_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_provider_refs"
  ADD CONSTRAINT "shipment_provider_refs_courier_partner_id_fkey"
  FOREIGN KEY ("courier_partner_id") REFERENCES "public"."CourierPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_rates"
  ADD CONSTRAINT "shipment_rates_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_rates"
  ADD CONSTRAINT "shipment_rates_seller_courier_partner_id_fkey"
  FOREIGN KEY ("seller_courier_partner_id") REFERENCES "public"."seller_courier_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_rates"
  ADD CONSTRAINT "shipment_rates_courier_partner_id_fkey"
  FOREIGN KEY ("courier_partner_id") REFERENCES "public"."CourierPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_tracking_events"
  ADD CONSTRAINT "shipment_tracking_events_shipment_id_fkey"
  FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."shipment_tracking_events"
  ADD CONSTRAINT "shipment_tracking_events_courier_partner_id_fkey"
  FOREIGN KEY ("courier_partner_id") REFERENCES "public"."CourierPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
