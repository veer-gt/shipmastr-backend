#!/usr/bin/env node

const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

const PILOT_MERCHANT_ID = "cmq6xp0qb0000m1j2x42x0gnr";
const PILOT_MERCHANT_EMAIL = "pilot-6h-local-merchant@shipmastr.test";
const PILOT_ADMIN_EMAIL = "pilot-6h-local-admin@shipmastr.test";
const PRIMARY_PICKUP_ID = "cmqamkmh60006m1qhjozb80nr";
const ALTERNATE_PICKUP_ID = "cmq9380sf0002m1akjbwmbkm8";
const SHIPMENT_ID = "cmqamlku6000am1qh7amfz3m5";
const COURIER_PARTNER_ID = "phase44b_shipmastr_courier_network";
const SELLER_COURIER_PARTNER_ID = "phase44b_pilot_6h_network_mapping";
const SHIPROCKET_CREDENTIAL_ID = "phase44b_pilot_6h_shiprocket_credential";
const SHIPROCKET_PROBE_ID = "phase44b_pilot_6h_shiprocket_probe";

const PROD_DATABASE_MARKERS = [
  "shipmastr-core-prod",
  "cloudsql",
  "asia-south1",
  "prod"
];

function databaseUrlLooksProductionLike(databaseUrl) {
  const normalized = String(databaseUrl || "").toLowerCase();
  return PROD_DATABASE_MARKERS.some((marker) => normalized.includes(marker));
}

function assertLocalFixtureSeedSafety(source = process.env, options = {}) {
  const nodeEnv = String(source.NODE_ENV || "").toLowerCase();
  const databaseUrl = String(source.DATABASE_URL || "");

  if (nodeEnv === "production") {
    throw new Error("Refusing to use Pilot Run 6H local fixture while NODE_ENV=production");
  }

  if (source.K_SERVICE || source.CLOUD_RUN_JOB) {
    throw new Error("Refusing to use Pilot Run 6H local fixture inside Cloud Run");
  }

  if (!databaseUrl) {
    throw new Error("Refusing to use Pilot Run 6H local fixture without DATABASE_URL");
  }

  if (databaseUrlLooksProductionLike(databaseUrl)) {
    throw new Error("Refusing to use Pilot Run 6H local fixture against a production-looking DATABASE_URL");
  }

  if (options.requireAllowFlag !== false && source.SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED !== "1") {
    throw new Error("SHIPMASTR_ALLOW_LOCAL_FIXTURE_SEED=1 is required to seed Pilot Run 6H local fixture");
  }
}

function toJson(value) {
  return JSON.stringify(value ?? {});
}

function publicRateCode(serviceName) {
  if (serviceName === "Shipmastr Economy") return "shipmastr_economy";
  if (serviceName === "Shipmastr Express") return "shipmastr_express";
  return "shipmastr_smart";
}

function tierForServiceName(serviceName) {
  if (serviceName === "Shipmastr Economy") return "economy";
  if (serviceName === "Shipmastr Express") return "express";
  return "smart";
}

function buildRateBreakup({ serviceName, providerCourierId, amountPaise }) {
  const tier = tierForServiceName(serviceName);
  return {
    internalRateId: `pilot_6h_${tier}`,
    internalCourierId: providerCourierId,
    providerCourierId,
    rawProviderResponseStored: false,
    phase6: {
      pilotRun: "6H",
      tier,
      codSupported: true,
      pickupAvailable: false,
      deliveryAvailable: true,
      reliabilityScore: tier === "smart" ? 0.91 : tier === "express" ? 0.88 : 0.84,
      providerCourierId,
      livePilotRatesMode: "LIVE",
      livePilotRatesReady: true,
      rawProviderResponseStored: false,
      amountPaise
    }
  };
}

function fixtureRates() {
  return [{
    id: "phase44b_pilot_6h_rate_smart",
    serviceName: "Shipmastr Smart",
    providerCourierId: "190123",
    amountPaise: 7200,
    estimatedDeliveryDays: 2
  }, {
    id: "phase44b_pilot_6h_rate_economy",
    serviceName: "Shipmastr Economy",
    providerCourierId: "190124",
    amountPaise: 6100,
    estimatedDeliveryDays: 4
  }, {
    id: "phase44b_pilot_6h_rate_express",
    serviceName: "Shipmastr Express",
    providerCourierId: "190125",
    amountPaise: 9100,
    estimatedDeliveryDays: 1
  }];
}

function shipmentMetadata() {
  return {
    pilotRun: "6H",
    seededBy: "phase44b_local_fixture",
    safeFixtureOnly: true,
    rawProviderPayloadStored: false,
    boxes: [{
      name: "Pilot fixture parcel",
      quantity: 1,
      weightGrams: 500,
      dimensionsCm: {
        length: 20,
        breadth: 15,
        height: 10
      }
    }],
    products: [{
      name: "Pilot fixture item",
      quantity: 1,
      sku: "PILOT-6H-SAFE"
    }],
    invoice: {
      amountPaise: 149900,
      currency: "INR"
    },
    buyerPreview: {
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
      country: "IN"
    },
    phase6: {
      providerStatus: "rates_fetched",
      ratedAt: new Date().toISOString(),
      livePilotRatesMode: "LIVE",
      livePilotRatesReady: true,
      latestRateRefresh: {
        status: "NO_ELIGIBLE_SHIPPING_RATES",
        fetched_count: 3,
        effective_limit: 3,
        eligible_rate_count: 0,
        provider_pickup_available_any: false,
        provider_delivery_available_any: true,
        stale_selected_rate_ignored: true,
        rawProviderResponseStored: false,
        rejected_rate_reasons: [{
          safe_reason: "PICKUP_UNAVAILABLE",
          count: 3
        }],
        safe_warnings: [
          "Selected pickup is not currently serviceable for the stored live-like rate evidence."
        ]
      }
    }
  };
}

function shiprocketRequiredFields() {
  return {
    fields: [{
      name: "email",
      label: "Account email",
      sensitive: true,
      required: true,
      format: "vault_ref_only"
    }, {
      name: "password",
      label: "Account password",
      sensitive: true,
      required: true,
      format: "vault_ref_only"
    }]
  };
}

async function inspectPilotRun6HFixture(client) {
  const [merchantRows, pickupRows, alternatePickupRows, shipmentRows, rateRows, credentialRows, adminRows] = await Promise.all([
    client.$queryRaw`SELECT id, name, email FROM "Merchant" WHERE id = ${PILOT_MERCHANT_ID} LIMIT 1`,
    client.$queryRaw`SELECT id, seller_id, label, city, state, pincode, status FROM pickup_locations WHERE id = ${PRIMARY_PICKUP_ID} LIMIT 1`,
    client.$queryRaw`SELECT id, seller_id, label, city, state, pincode, status FROM pickup_locations WHERE id = ${ALTERNATE_PICKUP_ID} LIMIT 1`,
    client.$queryRaw`SELECT id, seller_id, pickup_location_id, status, awb_number, tracking_url, to_pincode FROM shipments WHERE id = ${SHIPMENT_ID} LIMIT 1`,
    client.$queryRaw`SELECT id, public_service_name, amount_paise, rate_breakup FROM shipment_rates WHERE shipment_id = ${SHIPMENT_ID} ORDER BY public_service_code ASC`,
    client.$queryRaw`SELECT id, provider_key, mode, status, credential_ref, last_test_status FROM courier_provider_credentials WHERE merchant_id = ${PILOT_MERCHANT_ID}`,
    client.$queryRaw`SELECT id, email, role, "userType", "merchantId" FROM "User" WHERE email = ${PILOT_ADMIN_EMAIL} LIMIT 1`
  ]);
  const shipment = shipmentRows[0] ?? null;
  return {
    merchant_exists: merchantRows.length > 0,
    pilot_admin_exists: adminRows.length > 0,
    pickup_exists: pickupRows.length > 0,
    alternate_pickup_exists: alternatePickupRows.length > 0,
    shipment_exists: Boolean(shipment),
    shipment: shipment ? {
      status: shipment.status,
      pickup_location_id: shipment.pickup_location_id,
      to_pincode: shipment.to_pincode,
      awb_present: Boolean(shipment.awb_number),
      tracking_url_present: Boolean(shipment.tracking_url)
    } : null,
    rate_count: rateRows.length,
    rates: rateRows.map((rate) => ({
      service: rate.public_service_name,
      amount_paise: rate.amount_paise,
      pickup_available: rate.rate_breakup?.phase6?.pickupAvailable ?? null,
      delivery_available: rate.rate_breakup?.phase6?.deliveryAvailable ?? null,
      provider_courier_id_configured: Boolean(rate.rate_breakup?.phase6?.providerCourierId || rate.rate_breakup?.providerCourierId),
      raw_provider_response_stored: Boolean(rate.rate_breakup?.phase6?.providerResponseJson || rate.rate_breakup?.result)
    })),
    credential_readiness: credentialRows.map((credential) => ({
      provider_key: credential.provider_key,
      mode: credential.mode,
      status: credential.status,
      credential_ref_configured: Boolean(credential.credential_ref),
      last_test_status: credential.last_test_status
    }))
  };
}

async function seedPilotRun6HFixture({ client, source = process.env, hashPassword = (value) => bcrypt.hash(value, 12) }) {
  assertLocalFixtureSeedSafety(source);

  await client.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "Merchant" (id, name, email, phone, "onboardingStatus", "pickupAddressStatus", "kycStatus", "bankStatus", "firstShipmentStatus", "adminStatus", "createdAt", "updatedAt")
      VALUES (${PILOT_MERCHANT_ID}, 'Pilot Run 6H Local Merchant', ${PILOT_MERCHANT_EMAIL}, NULL, 'READY_TO_SHIP'::"MerchantOnboardingStatus", 'COMPLETED'::"MerchantOnboardingStepStatus", 'COMPLETED'::"MerchantOnboardingStepStatus", 'COMPLETED'::"MerchantOnboardingStepStatus", 'COMPLETED'::"MerchantOnboardingStepStatus", 'READY_TO_SHIP'::"MerchantAdminStatus", NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        "onboardingStatus" = EXCLUDED."onboardingStatus",
        "pickupAddressStatus" = EXCLUDED."pickupAddressStatus",
        "kycStatus" = EXCLUDED."kycStatus",
        "bankStatus" = EXCLUDED."bankStatus",
        "firstShipmentStatus" = EXCLUDED."firstShipmentStatus",
        "adminStatus" = EXCLUDED."adminStatus",
        "updatedAt" = NOW()
    `;

    if (source.PILOT_6H_LOCAL_ADMIN_PASSWORD) {
      const passwordHash = await hashPassword(String(source.PILOT_6H_LOCAL_ADMIN_PASSWORD));
      await tx.$executeRaw`
        INSERT INTO "User" (id, "merchantId", email, "passwordHash", name, "userType", role, "createdAt", "updatedAt")
        VALUES ('phase44b_pilot_6h_admin', ${PILOT_MERCHANT_ID}, ${PILOT_ADMIN_EMAIL}, ${passwordHash}, 'Pilot 6H Local Admin', 'INTERNAL_SHIPMASTR', 'MASTER_ADMIN'::"UserRole", NOW(), NOW())
        ON CONFLICT (email) DO UPDATE SET
          "merchantId" = EXCLUDED."merchantId",
          "passwordHash" = EXCLUDED."passwordHash",
          name = EXCLUDED.name,
          "userType" = EXCLUDED."userType",
          role = EXCLUDED.role,
          "updatedAt" = NOW()
      `;
    }

    await tx.$executeRaw`
      INSERT INTO "CourierPartner" (id, name, code, status, "isSystemManaged", "defaultForNewSellers", "credentialsRequiredFromSeller", country, "supportedSegments", active, "apiMode", "bookingMode", "supportsCOD", "supportsPrepaid", "supportsPickup", priority, "createdAt", "updatedAt")
      VALUES (${COURIER_PARTNER_ID}, 'Shipmastr Courier Network', 'shipmastr_courier_network', 'active'::"CourierPartnerStatus", true, true, false, 'IN', ARRAY['domestic_b2c']::"ShipmentSegment"[], true, 'manual', 'manual', true, true, true, 1, NOW(), NOW())
      ON CONFLICT (code) DO UPDATE SET
        status = EXCLUDED.status,
        "isSystemManaged" = EXCLUDED."isSystemManaged",
        "defaultForNewSellers" = EXCLUDED."defaultForNewSellers",
        "credentialsRequiredFromSeller" = EXCLUDED."credentialsRequiredFromSeller",
        country = EXCLUDED.country,
        "supportedSegments" = EXCLUDED."supportedSegments",
        active = EXCLUDED.active,
        priority = EXCLUDED.priority,
        "updatedAt" = NOW()
    `;

    const mappingRows = await tx.$queryRaw`
      INSERT INTO seller_courier_partners (id, seller_id, courier_partner_id, status, partner_type, credentials_required_from_seller, enabled_segments, country, display_code, display_name, created_at, updated_at)
      VALUES (${SELLER_COURIER_PARTNER_ID}, ${PILOT_MERCHANT_ID}, (SELECT id FROM "CourierPartner" WHERE code = 'shipmastr_courier_network' LIMIT 1), 'active'::"SellerCourierPartnerStatus", 'system_managed'::"PartnerType", false, ARRAY['domestic_b2c']::"ShipmentSegment"[], 'IN', 'shipmastr_courier_network', 'Shipmastr Courier Network', NOW(), NOW())
      ON CONFLICT (seller_id, courier_partner_id) DO UPDATE SET
        status = EXCLUDED.status,
        partner_type = EXCLUDED.partner_type,
        credentials_required_from_seller = EXCLUDED.credentials_required_from_seller,
        enabled_segments = EXCLUDED.enabled_segments,
        country = EXCLUDED.country,
        display_code = EXCLUDED.display_code,
        display_name = EXCLUDED.display_name,
        updated_at = NOW()
      RETURNING id, courier_partner_id
    `;
    const mapping = mappingRows[0];

    const pickupMetadata = {
      pilotRun: "6H",
      localFixtureOnly: true,
      providerPickupAligned: true,
      rawProviderPayloadStored: false
    };
    await tx.$executeRaw`
      INSERT INTO pickup_locations (id, seller_id, label, contact_name, phone, address_line1, address_line2, city, state, pincode, country, status, metadata, created_at, updated_at)
      VALUES (${PRIMARY_PICKUP_ID}, ${PILOT_MERCHANT_ID}, 'skymax', 'Pilot Ops', NULL, 'Pilot fixture pickup', NULL, 'Gautam Buddha Nagar', 'Uttar Pradesh', '201301', 'IN', 'active', ${toJson(pickupMetadata)}::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        seller_id = EXCLUDED.seller_id,
        label = EXCLUDED.label,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        pincode = EXCLUDED.pincode,
        country = EXCLUDED.country,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;
    await tx.$executeRaw`
      INSERT INTO pickup_locations (id, seller_id, label, contact_name, phone, address_line1, address_line2, city, state, pincode, country, status, metadata, created_at, updated_at)
      VALUES (${ALTERNATE_PICKUP_ID}, ${PILOT_MERCHANT_ID}, 'Pilot Run 3 Pickup', 'Pilot Ops', NULL, 'Pilot fixture alternate pickup', NULL, 'Gurugram', 'Haryana', '122001', 'IN', 'active', ${toJson({ ...pickupMetadata, alternate: true })}::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        seller_id = EXCLUDED.seller_id,
        label = EXCLUDED.label,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        pincode = EXCLUDED.pincode,
        country = EXCLUDED.country,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;

    await tx.$executeRaw`
      INSERT INTO pickup_location_provider_mappings (id, pickup_location_id, seller_courier_partner_id, courier_partner_id, provider_pickup_id, provider_code, status, metadata, created_at, updated_at)
      VALUES ('phase44b_pickup_mapping_primary', ${PRIMARY_PICKUP_ID}, ${mapping.id}, ${mapping.courier_partner_id}, 'pilot_6h_provider_pickup_201301', 'SHIPROCKET', 'active', ${toJson({ pilotRun: "6H", pincode: "201301", active: true, rawProviderPayloadStored: false })}::jsonb, NOW(), NOW())
      ON CONFLICT (pickup_location_id, courier_partner_id) DO UPDATE SET
        seller_courier_partner_id = EXCLUDED.seller_courier_partner_id,
        provider_pickup_id = EXCLUDED.provider_pickup_id,
        provider_code = EXCLUDED.provider_code,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;
    await tx.$executeRaw`
      INSERT INTO pickup_location_provider_mappings (id, pickup_location_id, seller_courier_partner_id, courier_partner_id, provider_pickup_id, provider_code, status, metadata, created_at, updated_at)
      VALUES ('phase44b_pickup_mapping_alternate', ${ALTERNATE_PICKUP_ID}, ${mapping.id}, ${mapping.courier_partner_id}, 'pilot_6h_provider_pickup_122001', 'SHIPROCKET', 'active', ${toJson({ pilotRun: "6H", pincode: "122001", active: true, rawProviderPayloadStored: false })}::jsonb, NOW(), NOW())
      ON CONFLICT (pickup_location_id, courier_partner_id) DO UPDATE SET
        seller_courier_partner_id = EXCLUDED.seller_courier_partner_id,
        provider_pickup_id = EXCLUDED.provider_pickup_id,
        provider_code = EXCLUDED.provider_code,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;

    await tx.$executeRaw`
      INSERT INTO shipments (id, seller_id, external_order_id, pickup_location_id, seller_courier_partner_id, courier_partner_id, segment, status, payment_mode, cod_amount_paise, declared_value_paise, from_pincode, to_pincode, dead_weight_kg, length_cm, breadth_cm, height_cm, volumetric_divisor, volumetric_weight_kg, chargeable_weight_kg, service_level, awb_number, tracking_url, metadata, created_at, updated_at)
      VALUES (${SHIPMENT_ID}, ${PILOT_MERCHANT_ID}, 'PILOT-6H-LOCAL', ${PRIMARY_PICKUP_ID}, ${mapping.id}, ${mapping.courier_partner_id}, 'domestic_b2c'::"ShipmentSegment", 'rates_fetched'::"ShipmentStatus", 'cod'::"ShippingPaymentMode", 149900, 149900, '201301', '400001', 0.500, 20.00, 15.00, 10.00, 5000, 0.600, 0.600, 'Shipmastr Smart', NULL, NULL, ${toJson(shipmentMetadata())}::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        seller_id = EXCLUDED.seller_id,
        external_order_id = EXCLUDED.external_order_id,
        pickup_location_id = EXCLUDED.pickup_location_id,
        seller_courier_partner_id = EXCLUDED.seller_courier_partner_id,
        courier_partner_id = EXCLUDED.courier_partner_id,
        segment = EXCLUDED.segment,
        status = CASE
          WHEN shipments.awb_number IS NULL AND shipments.tracking_url IS NULL THEN EXCLUDED.status
          ELSE shipments.status
        END,
        payment_mode = EXCLUDED.payment_mode,
        cod_amount_paise = EXCLUDED.cod_amount_paise,
        declared_value_paise = EXCLUDED.declared_value_paise,
        from_pincode = EXCLUDED.from_pincode,
        to_pincode = EXCLUDED.to_pincode,
        dead_weight_kg = EXCLUDED.dead_weight_kg,
        length_cm = EXCLUDED.length_cm,
        breadth_cm = EXCLUDED.breadth_cm,
        height_cm = EXCLUDED.height_cm,
        volumetric_divisor = EXCLUDED.volumetric_divisor,
        volumetric_weight_kg = EXCLUDED.volumetric_weight_kg,
        chargeable_weight_kg = EXCLUDED.chargeable_weight_kg,
        service_level = EXCLUDED.service_level,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `;

    for (const rate of fixtureRates()) {
      await tx.$executeRaw`
        INSERT INTO shipment_rates (id, shipment_id, seller_id, seller_courier_partner_id, courier_partner_id, public_service_code, public_service_name, segment, chargeable_weight_kg, amount_paise, currency, estimated_delivery_days, rate_breakup, expires_at, created_at, updated_at)
        VALUES (${rate.id}, ${SHIPMENT_ID}, ${PILOT_MERCHANT_ID}, ${mapping.id}, ${mapping.courier_partner_id}, ${publicRateCode(rate.serviceName)}, ${rate.serviceName}, 'domestic_b2c'::"ShipmentSegment", 0.600, ${rate.amountPaise}, 'INR', ${rate.estimatedDeliveryDays}, ${toJson(buildRateBreakup(rate))}::jsonb, NOW() + interval '2 hours', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          shipment_id = EXCLUDED.shipment_id,
          seller_id = EXCLUDED.seller_id,
          seller_courier_partner_id = EXCLUDED.seller_courier_partner_id,
          courier_partner_id = EXCLUDED.courier_partner_id,
          public_service_code = EXCLUDED.public_service_code,
          public_service_name = EXCLUDED.public_service_name,
          segment = EXCLUDED.segment,
          chargeable_weight_kg = EXCLUDED.chargeable_weight_kg,
          amount_paise = EXCLUDED.amount_paise,
          currency = EXCLUDED.currency,
          estimated_delivery_days = EXCLUDED.estimated_delivery_days,
          rate_breakup = EXCLUDED.rate_breakup,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
      `;
    }
    await tx.$executeRaw`
      UPDATE shipment_rates
      SET
        rate_breakup = jsonb_set(
          jsonb_set(
            (
              COALESCE(rate_breakup, '{}'::jsonb)
              - 'result'
              - 'providerResponseJson'
              - 'rawPayload'
              - 'rawResponse'
              - 'rawHeaders'
              #- '{phase6,result}'
              #- '{phase6,providerResponseJson}'
              #- '{phase6,rawPayload}'
              #- '{phase6,rawResponse}'
              #- '{phase6,rawHeaders}'
            ),
            '{rawProviderResponseStored}',
            'false'::jsonb,
            true
          ),
          '{phase6,rawProviderResponseStored}',
          'false'::jsonb,
          true
        ),
        updated_at = NOW()
      WHERE shipment_id = ${SHIPMENT_ID}
    `;

    const credentialSummary = {
      probeType: "ACCOUNT_INFO",
      status: "PASS",
      testedAt: new Date().toISOString(),
      latencyMs: 0,
      safeMessage: "Local fixture credential readiness passed without provider calls.",
      warnings: [
        "Local fixture only.",
        "No live provider call was made.",
        "No credential value was stored."
      ]
    };
    await tx.$executeRaw`
      INSERT INTO courier_provider_credentials (id, merchant_id, provider_key, mode, status, credential_ref, required_fields, safe_meta, last_tested_at, last_test_status, last_test_summary, created_at, updated_at)
      VALUES (${SHIPROCKET_CREDENTIAL_ID}, ${PILOT_MERCHANT_ID}, 'SHIPROCKET', 'LIVE', 'ACTIVE', 'vault:shiprocket/live/pilot-6h-local-fixture', ${toJson(shiprocketRequiredFields())}::jsonb, ${toJson({ pilotRun: "6H", credential_values_stored: false, credential_ref_only: true, required_fields_present: ["email", "password"], missing_fields: [] })}::jsonb, NOW(), 'PASS', ${toJson(credentialSummary)}::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        provider_key = EXCLUDED.provider_key,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        credential_ref = EXCLUDED.credential_ref,
        required_fields = EXCLUDED.required_fields,
        safe_meta = EXCLUDED.safe_meta,
        last_tested_at = EXCLUDED.last_tested_at,
        last_test_status = EXCLUDED.last_test_status,
        last_test_summary = EXCLUDED.last_test_summary,
        updated_at = NOW()
    `;
    await tx.$executeRaw`
      INSERT INTO courier_provider_readiness_probes (id, credential_id, merchant_id, provider_key, probe_type, mode, status, safe_summary, warnings, errors, tested_at, created_at)
      VALUES (${SHIPROCKET_PROBE_ID}, ${SHIPROCKET_CREDENTIAL_ID}, ${PILOT_MERCHANT_ID}, 'SHIPROCKET', 'ACCOUNT_INFO', 'LIVE', 'PASS', ${toJson(credentialSummary)}::jsonb, ${toJson(["Local fixture only.", "No live provider call was made."])}::jsonb, ${toJson([])}::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        credential_id = EXCLUDED.credential_id,
        merchant_id = EXCLUDED.merchant_id,
        provider_key = EXCLUDED.provider_key,
        probe_type = EXCLUDED.probe_type,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        safe_summary = EXCLUDED.safe_summary,
        warnings = EXCLUDED.warnings,
        errors = EXCLUDED.errors,
        tested_at = EXCLUDED.tested_at
    `;
  });

  return inspectPilotRun6HFixture(client);
}

async function main() {
  const inspectOnly = process.argv.includes("--inspect");
  assertLocalFixtureSeedSafety(process.env, { requireAllowFlag: !inspectOnly });
  const prisma = new PrismaClient();
  try {
    const result = inspectOnly
      ? await inspectPilotRun6HFixture(prisma)
      : await seedPilotRun6HFixture({ client: prisma });
    console.log(JSON.stringify({
      ok: true,
      mode: inspectOnly ? "inspect" : "seed",
      local_only: true,
      secrets_printed: false,
      live_provider_calls: false,
      awb_created: false,
      label_generated: false,
      tracking_live_read: false,
      ship_now_called: false,
      result
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  PILOT_MERCHANT_ID,
  PILOT_ADMIN_EMAIL,
  PRIMARY_PICKUP_ID,
  ALTERNATE_PICKUP_ID,
  SHIPMENT_ID,
  databaseUrlLooksProductionLike,
  assertLocalFixtureSeedSafety,
  buildRateBreakup,
  fixtureRates,
  shipmentMetadata,
  inspectPilotRun6HFixture,
  seedPilotRun6HFixture
};
