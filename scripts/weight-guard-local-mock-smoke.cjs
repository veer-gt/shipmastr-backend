#!/usr/bin/env node

const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

const APPROVAL_FLAG = "YES_I_APPROVE_LOCAL_DB_MUTATION";
const MERCHANT_ID = "wg_local_mock_merchant";
const MERCHANT_EMAIL = "weight-guard-local-smoke@shipmastr.test";
const SHIPMENT_ID = "wg_local_mock_shipment";
const AWB_NUMBER = "WGLOCALMOCK001";

function assertLocalDatabaseUrl(value) {
  if (!value) {
    throw new Error("DATABASE_URL is required for local Weight Guard smoke.");
  }

  const parsed = new URL(value);
  const isPostgres = parsed.protocol === "postgresql:" || parsed.protocol === "postgres:";
  const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const looksProduction = String(value).toLowerCase().includes("prod")
    || String(value).toLowerCase().includes("cloudsql")
    || String(value).toLowerCase().includes("shipmastr-core-prod");

  if (!isPostgres || !isLocalHost || looksProduction) {
    throw new Error("Refusing Weight Guard smoke because DATABASE_URL is not clearly local Postgres.");
  }
}

function assertSmokeSafety(source = process.env) {
  if (String(source.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("Refusing Weight Guard local smoke while NODE_ENV=production.");
  }

  if (source.K_SERVICE || source.CLOUD_RUN_JOB) {
    throw new Error("Refusing Weight Guard local smoke inside Cloud Run.");
  }

  assertLocalDatabaseUrl(String(source.DATABASE_URL || ""));

  if (source.SHIPMASTR_WEIGHT_GUARD_LOCAL_SMOKE !== APPROVAL_FLAG) {
    throw new Error(`SHIPMASTR_WEIGHT_GUARD_LOCAL_SMOKE=${APPROVAL_FLAG} is required.`);
  }

  if (String(source.WEIGHT_GUARD_PROOF_STORAGE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true is required.");
  }

  if (String(source.WEIGHT_GUARD_STORAGE_PROVIDER || "").toLowerCase() !== "mock") {
    throw new Error("WEIGHT_GUARD_STORAGE_PROVIDER=mock is required.");
  }
}

async function loadBuiltWeightGuardModules() {
  const servicePath = path.join(__dirname, "../dist/modules/shippingNetwork/shipping-weight-proof.service.js");
  const storagePath = path.join(__dirname, "../dist/modules/shippingNetwork/shipping-weight-proof-storage.js");

  if (!existsSync(servicePath) || !existsSync(storagePath)) {
    throw new Error("Built Weight Guard modules are missing. Run npm run build before this smoke.");
  }

  const [service, storage] = await Promise.all([
    import(pathToFileURL(servicePath).href),
    import(pathToFileURL(storagePath).href)
  ]);

  return { service, storage };
}

async function createOrReuseFixture(prisma) {
  await prisma.merchant.upsert({
    where: { id: MERCHANT_ID },
    update: {
      name: "Weight Guard Local Mock Merchant",
      email: MERCHANT_EMAIL,
      onboardingStatus: "READY_TO_SHIP",
      pickupAddressStatus: "COMPLETED",
      kycStatus: "COMPLETED",
      bankStatus: "COMPLETED",
      firstShipmentStatus: "COMPLETED",
      adminStatus: "READY_TO_SHIP"
    },
    create: {
      id: MERCHANT_ID,
      name: "Weight Guard Local Mock Merchant",
      email: MERCHANT_EMAIL,
      onboardingStatus: "READY_TO_SHIP",
      pickupAddressStatus: "COMPLETED",
      kycStatus: "COMPLETED",
      bankStatus: "COMPLETED",
      firstShipmentStatus: "COMPLETED",
      adminStatus: "READY_TO_SHIP"
    }
  });

  const existingAwbShipment = await prisma.shipment.findUnique({
    where: { awbNumber: AWB_NUMBER },
    select: { id: true, sellerId: true }
  });

  if (existingAwbShipment && existingAwbShipment.id !== SHIPMENT_ID) {
    throw new Error("Refusing to reuse AWB because it belongs to a different local shipment row.");
  }

  const shipment = await prisma.shipment.upsert({
    where: { id: SHIPMENT_ID },
    update: {
      sellerId: MERCHANT_ID,
      awbNumber: AWB_NUMBER,
      status: "manifested",
      paymentMode: "prepaid",
      fromPincode: "201301",
      toPincode: "400001",
      metadata: {
        localOnly: true,
        fixture: "weight_guard_local_mock_smoke",
        liveCourierCalls: false,
        liveR2Calls: false,
        notificationsSent: false
      }
    },
    create: {
      id: SHIPMENT_ID,
      sellerId: MERCHANT_ID,
      awbNumber: AWB_NUMBER,
      status: "manifested",
      paymentMode: "prepaid",
      fromPincode: "201301",
      toPincode: "400001",
      metadata: {
        localOnly: true,
        fixture: "weight_guard_local_mock_smoke",
        liveCourierCalls: false,
        liveR2Calls: false,
        notificationsSent: false
      }
    },
    select: { id: true, awbNumber: true, sellerId: true }
  });

  return shipment;
}

function assertSellerSafe(value) {
  const text = JSON.stringify(value);
  return !/imageObjectKey|image_object_key|uploadUrl|upload_url|downloadUrl|download_url|signed|mock:\/\/|r2\.dev/i.test(text);
}

async function run() {
  assertSmokeSafety();

  const prisma = new PrismaClient();
  try {
    const { service, storage: storageModule } = await loadBuiltWeightGuardModules();
    const storage = new storageModule.InMemoryWeightProofStorageAdapter();
    const shipment = await createOrReuseFixture(prisma);

    const context = {
      merchantId: MERCHANT_ID,
      storage,
      client: prisma,
      uploadTtlMs: Number(process.env.WEIGHT_GUARD_UPLOAD_TTL_SECONDS || 600) * 1000
    };

    const initResult = await service.initWeightProofCapture({
      shipmentId: shipment.id,
      awbNumber: AWB_NUMBER,
      contentType: "image/jpeg",
      expectedByteSize: 2048,
      deviceId: "weight_guard_local_mock_station"
    }, context);

    if (initResult.objectKey) {
      storage.putObject({
        objectKey: initResult.objectKey,
        contentLength: 2048,
        contentType: "image/jpeg"
      });
    }

    const captureSessionId = initResult.capture?.capture_session_id || initResult.proof?.capture_session_id;
    if (!captureSessionId) {
      throw new Error("Weight Guard smoke could not resolve a capture session id.");
    }

    const finalizeResult = await service.finalizeWeightProofCapture({
      captureSessionId,
      declaredWeightGrams: 1240,
      dimensions: { lengthCm: 22, widthCm: 18, heightCm: 12 },
      deviceId: "weight_guard_local_mock_station",
      capturedAt: new Date()
    }, context);

    const proof = await service.getWeightProofByAwb({ awbNumber: AWB_NUMBER }, context);
    const sellerSafe = assertSellerSafe(finalizeResult.proof) && assertSellerSafe(proof);
    if (!sellerSafe) {
      throw new Error("Seller-safe proof response exposed storage internals.");
    }

    console.log(JSON.stringify({
      ok: true,
      local_only: true,
      live_external_call_happened: false,
      live_r2_call_happened: false,
      courier_api_call_happened: false,
      notifications_sent: false,
      capture_session_created: Boolean(initResult.created),
      object_key_present: Boolean(initResult.objectKey),
      proof_logged: Boolean(finalizeResult.finalized || finalizeResult.idempotent),
      awb: proof.awb_number,
      declaredWeightGrams: proof.declared_weight_grams,
      volumetricWeightGrams: proof.volumetric_weight_grams,
      chargeableWeightGrams: proof.chargeable_weight_grams,
      seller_safe_response_hides_storage_internals: sellerSafe
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  AWB_NUMBER,
  APPROVAL_FLAG,
  MERCHANT_ID,
  SHIPMENT_ID,
  assertLocalDatabaseUrl,
  assertSmokeSafety
};
