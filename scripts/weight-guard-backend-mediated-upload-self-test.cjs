#!/usr/bin/env node

const { createHash, randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

dotenv.config();

const APPROVAL_FLAG = "YES_I_APPROVE_STAGING_BACKEND_MEDIATED_UPLOAD";
const DEFAULT_STAGING_API_BASE_URL = "https://shipmastr-api-staging-jscfc5kumq-el.a.run.app";
const MERCHANT_ID = "wg_stage_backend_mediated_merchant";
const USER_ID = "wg_stage_backend_mediated_user";
const MERCHANT_EMAIL = "weight-guard-backend-mediated@shipmastr.test";
const AWB_PREFIX = "WGSTAGEUI";
const SAFE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lc9V7wAAAABJRU5ErkJggg==",
  "base64"
);

class BackendMediatedSelfTestSafetyError extends Error {
  constructor(message, category = "BACKEND_MEDIATED_SELF_TEST_SAFETY_REFUSED") {
    super(message);
    this.name = "BackendMediatedSelfTestSafetyError";
    this.category = category;
  }
}

function stringValue(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function booleanTrue(value) {
  return stringValue(value).toLowerCase() === "true";
}

function safeErrorCategory(error) {
  const category = stringValue(error?.category);
  if (category) return category;
  const joined = `${error?.code ?? ""} ${error?.status ?? ""} ${error?.name ?? ""} ${error?.message ?? ""}`.toLowerCase();
  if (joined.includes("approval")) return "BACKEND_MEDIATED_APPROVAL_REQUIRED";
  if (joined.includes("401") || joined.includes("invalid_token") || joined.includes("unauthorized")) return "AUTHENTICATED_CONTEXT_FAILED";
  if (joined.includes("403") || joined.includes("forbidden")) return "AUTHENTICATED_CONTEXT_FORBIDDEN";
  if (joined.includes("already") || joined.includes("proof_already_logged")) return "TEST_AWB_ALREADY_CAPTURED";
  if (joined.includes("upload_not_verified")) return "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED";
  if (joined.includes("upload") && joined.includes("failed")) return "BACKEND_UPLOAD_FAILED";
  if (joined.includes("finalize")) return "FINALIZE_FAILED";
  if (joined.includes("fetch")) return "STAGING_API_FETCH_FAILED";
  return "BACKEND_MEDIATED_SELF_TEST_FAILED";
}

function redactText(value, source = process.env) {
  const redactedValues = [
    source.JWT_SECRET,
    source.DATABASE_URL,
    source.WEIGHT_GUARD_GCS_BUCKET,
    source.WEIGHT_GUARD_GCS_PROJECT_ID,
    source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT
  ].filter(Boolean).map(String);

  let text = String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/https?:\/\/[^\s")]+/gi, "[redacted-url]")
    .replace(/storage[.]googleapis[.]com/gi, "[redacted-storage-host]")
    .replace(/weight-proofs\/[A-Za-z0-9_./=-]+/g, "object-key-redacted")
    .replace(/\b(imageObjectKey|image_object_key|objectKey|bucket|uploadUrl|signedUrl)\b\s*[:=]\s*["']?[^"',}\s]+["']?/gi, "$1=[redacted]")
    .replace(/\b(private[_-]?key|client[_-]?secret|access[_-]?token|id[_-]?token|refresh[_-]?token|secret|cookie|authorization)\b/gi, "[redacted-sensitive-word]");

  for (const redactedValue of redactedValues) {
    text = text.split(redactedValue).join("[redacted-config]");
  }

  return text.slice(0, 220);
}

function assertSelfTestSafety(source = process.env) {
  if (source.WEIGHT_GUARD_BACKEND_UPLOAD_SELF_TEST !== APPROVAL_FLAG) {
    throw new BackendMediatedSelfTestSafetyError(
      "Weight Guard backend-mediated upload self-test approval flag is required.",
      "BACKEND_MEDIATED_APPROVAL_REQUIRED"
    );
  }

  const nodeEnv = stringValue(source.NODE_ENV).toLowerCase();
  const appEnv = stringValue(source.APP_ENV).toLowerCase();
  const explicitStaging = appEnv === "staging" || source.WEIGHT_GUARD_STAGING_SELF_TEST === "true";
  if (nodeEnv === "production" && !explicitStaging) {
    throw new BackendMediatedSelfTestSafetyError(
      "Refusing production-like runtime without explicit staging context.",
      "BACKEND_MEDIATED_PRODUCTION_REFUSED"
    );
  }

  const apiBaseUrl = resolveApiBaseUrl(source);
  if (!apiBaseUrl.includes("shipmastr-api-staging") || apiBaseUrl.includes("shipmastr-api-00182") || apiBaseUrl.includes("shipmastr-api-jscfc5kumq-el.a.run.app")) {
    throw new BackendMediatedSelfTestSafetyError(
      "Staging API base URL is required for Weight Guard backend-mediated self-test.",
      "BACKEND_MEDIATED_API_BASE_NOT_STAGING"
    );
  }

  if (!stringValue(source.DATABASE_URL)) {
    throw new BackendMediatedSelfTestSafetyError("DATABASE_URL is required inside staging runtime.", "DATABASE_URL_MISSING");
  }

  if (!stringValue(source.JWT_SECRET)) {
    throw new BackendMediatedSelfTestSafetyError("JWT_SECRET is required inside staging runtime.", "JWT_SECRET_MISSING");
  }

  if (!booleanTrue(source.WEIGHT_GUARD_PROOF_STORAGE_ENABLED)) {
    throw new BackendMediatedSelfTestSafetyError("WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true is required.", "WEIGHT_GUARD_STORAGE_DISABLED");
  }

  if (stringValue(source.WEIGHT_GUARD_STORAGE_PROVIDER).toLowerCase() !== "gcs") {
    throw new BackendMediatedSelfTestSafetyError("WEIGHT_GUARD_STORAGE_PROVIDER=gcs is required.", "WEIGHT_GUARD_PROVIDER_NOT_GCS");
  }
}

function resolveApiBaseUrl(source = process.env) {
  return stringValue(source.SHIPMASTR_STAGING_API_BASE_URL || source.SHIPMASTR_API_BASE_URL || DEFAULT_STAGING_API_BASE_URL).replace(/\/+$/, "");
}

function awbForIndex(index) {
  return `${AWB_PREFIX}${String(index).padStart(3, "0")}`;
}

function shipmentIdForAwb(awbNumber) {
  return `wg_stage_backend_mediated_shipment_${awbNumber.toLowerCase()}`;
}

function hashIdentity(value) {
  const normalized = stringValue(value).toLowerCase();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

async function ensureSelfTestMerchant(prisma) {
  await prisma.merchant.upsert({
    where: { id: MERCHANT_ID },
    update: {
      name: "Weight Guard Backend Mediated Staging Merchant",
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
      name: "Weight Guard Backend Mediated Staging Merchant",
      email: MERCHANT_EMAIL,
      onboardingStatus: "READY_TO_SHIP",
      pickupAddressStatus: "COMPLETED",
      kycStatus: "COMPLETED",
      bankStatus: "COMPLETED",
      firstShipmentStatus: "COMPLETED",
      adminStatus: "READY_TO_SHIP"
    }
  });

  await prisma.user.upsert({
    where: { id: USER_ID },
    update: {
      merchantId: MERCHANT_ID,
      email: MERCHANT_EMAIL,
      name: "Weight Guard Backend Mediated Self Test",
      userType: "SELLER_ACCOUNT",
      role: "SELLER_OWNER"
    },
    create: {
      id: USER_ID,
      merchantId: MERCHANT_ID,
      email: MERCHANT_EMAIL,
      passwordHash: "staging-self-test-disabled",
      name: "Weight Guard Backend Mediated Self Test",
      userType: "SELLER_ACCOUNT",
      role: "SELLER_OWNER"
    }
  });
}

async function createOrReuseFixture(prisma) {
  await ensureSelfTestMerchant(prisma);

  for (let index = 1; index <= 50; index += 1) {
    const awbNumber = awbForIndex(index);
    const existingProof = await prisma.shippingWeightProof.findFirst({
      where: { awbNumber },
      select: { id: true }
    });
    if (existingProof) continue;

    const existingShipment = await prisma.shipment.findUnique({
      where: { awbNumber },
      select: { id: true, sellerId: true, awbNumber: true }
    });

    if (existingShipment) {
      if (existingShipment.sellerId !== MERCHANT_ID) continue;
      return existingShipment;
    }

    return prisma.shipment.create({
      data: {
        id: shipmentIdForAwb(awbNumber),
        sellerId: MERCHANT_ID,
        awbNumber,
        status: "manifested",
        paymentMode: "prepaid",
        fromPincode: "201301",
        toPincode: "400001",
        deadWeightKg: "1.240",
        lengthCm: "22.00",
        breadthCm: "18.00",
        heightCm: "12.00",
        volumetricDivisor: 5000,
        volumetricWeightKg: "0.950",
        chargeableWeightKg: "1.500",
        metadata: {
          stagingOnly: true,
          fixture: "weight_guard_backend_mediated_self_test",
          liveCourierCalls: false,
          notificationsSent: false,
          createdBy: "codex_ui5b_auth_runner"
        }
      },
      select: { id: true, sellerId: true, awbNumber: true }
    });
  }

  throw new BackendMediatedSelfTestSafetyError("No unused WGSTAGEUI### fixture slot was available.", "STAGING_FIXTURE_SLOT_UNAVAILABLE");
}

function mintSellerToken({ merchantId, source = process.env }) {
  return jwt.sign({
    userId: USER_ID,
    merchantId,
    role: "SELLER_OWNER",
    email: MERCHANT_EMAIL,
    purpose: "weight_guard_backend_mediated_self_test"
  }, source.JWT_SECRET, {
    expiresIn: "15m",
    jwtid: `wg-self-test-${randomUUID()}`
  });
}

async function parseJsonResponse(response, failureCategory = "STAGING_API_HTTP_FAILED") {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(`HTTP_${response.status}`);
    error.status = response.status;
    error.category = `${failureCategory}_HTTP_${response.status}`;
    error.safeBodyHash = hashIdentity(text);
    throw error;
  }
  return json;
}

function assertSellerSafe(value) {
  const text = JSON.stringify(value ?? {});
  return !/(imageObjectKey|image_object_key|objectKey|object_key|bucket|storage[.]googleapis|uploadUrl|upload_url|downloadUrl|download_url|signedUrl|signed_url|X-Goog|Bearer|Authorization|Cookie|DATABASE_URL|private_key|client_secret|weight-proofs\/(?!upload\b)[^/]+\/20\d{2}\/)/i.test(text);
}

function dataFromEnvelope(value) {
  return value?.data ?? value;
}

async function authenticatedJson({ apiBaseUrl, path, token, body, failureCategory }) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  return parseJsonResponse(response, failureCategory);
}

async function authenticatedGet({ apiBaseUrl, path, token, failureCategory }) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return parseJsonResponse(response, failureCategory);
}

async function authenticatedUpload({ apiBaseUrl, token, captureSessionId, awbNumber }) {
  const form = new FormData();
  form.append("capture_session_id", captureSessionId);
  form.append("awb_number", awbNumber);
  form.append("file", new Blob([SAFE_PNG], { type: "image/png" }), "weight-guard-self-test-proof.png");

  const response = await fetch(`${apiBaseUrl}/v1/shipping/weight-proofs/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
  return parseJsonResponse(response, "BACKEND_UPLOAD");
}

function buildSafeOutput(overrides = {}) {
  return {
    authenticatedSellerContext: Boolean(overrides.authenticatedSellerContext),
    testAwb: overrides.testAwb ?? null,
    uploadMode: overrides.uploadMode ?? null,
    uploadEndpointPresent: Boolean(overrides.uploadEndpointPresent),
    uploadVerified: Boolean(overrides.uploadVerified),
    finalizeSucceeded: Boolean(overrides.finalizeSucceeded),
    getProofSellerSafe: Boolean(overrides.getProofSellerSafe),
    directSignedUploadUsed: Boolean(overrides.directSignedUploadUsed),
    gcsWriteHappened: Boolean(overrides.gcsWriteHappened),
    dbMutationScope: overrides.dbMutationScope ?? null,
    errorCategory: overrides.errorCategory ?? null
  };
}

async function runBackendMediatedUploadSelfTest(options = {}) {
  const source = options.source ?? process.env;
  const write = options.write ?? ((text) => console.log(text));
  assertSelfTestSafety(source);

  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
    throw new BackendMediatedSelfTestSafetyError("Runtime fetch/FormData/Blob support is required.", "RUNTIME_MULTIPART_UNAVAILABLE");
  }

  const prisma = options.prisma ?? new PrismaClient();
  const ownsPrisma = !options.prisma;
  const apiBaseUrl = resolveApiBaseUrl(source);
  let safeAwbNumber = null;

  try {
    const fixture = options.fixture ?? await createOrReuseFixture(prisma);
    const token = options.token ?? mintSellerToken({ merchantId: fixture.sellerId, source });
    safeAwbNumber = fixture.awbNumber;

    const initEnvelope = await authenticatedJson({
      apiBaseUrl,
      path: "/v1/shipping/weight-proofs/init",
      token,
      body: {
        shipment_id: fixture.id,
        awb_number: fixture.awbNumber,
        content_type: "image/png",
        expected_byte_size: SAFE_PNG.length,
        device_id: "weight_guard_backend_mediated_self_test"
      },
      failureCategory: "INIT"
    });
    const init = dataFromEnvelope(initEnvelope);
    const uploadMode = init?.uploadMode ?? null;
    const uploadEndpointPresent = Boolean(init?.uploadEndpoint);
    const directSignedUploadUsed = Boolean(init?.uploadUrl) || uploadMode === "DIRECT_SIGNED_URL";
    if (uploadMode !== "BACKEND_MEDIATED" || !uploadEndpointPresent || directSignedUploadUsed || !assertSellerSafe(init)) {
      throw new BackendMediatedSelfTestSafetyError("Init response did not prove backend-mediated seller-safe upload.", "INIT_BACKEND_MEDIATED_CONTRACT_FAILED");
    }

    const captureSessionId = init?.captureSessionId;
    if (!captureSessionId) {
      throw new BackendMediatedSelfTestSafetyError("Init response did not include a capture session id.", "CAPTURE_SESSION_MISSING");
    }

    const uploadEnvelope = await authenticatedUpload({
      apiBaseUrl,
      token,
      captureSessionId,
      awbNumber: fixture.awbNumber
    });
    const upload = dataFromEnvelope(uploadEnvelope);
    const uploadVerified = upload?.uploadVerified === true;
    if (!uploadVerified || !assertSellerSafe(upload)) {
      throw new BackendMediatedSelfTestSafetyError("Backend upload did not verify safely.", "BACKEND_UPLOAD_CONTRACT_FAILED");
    }

    const finalizeEnvelope = await authenticatedJson({
      apiBaseUrl,
      path: "/v1/shipping/weight-proofs/finalize",
      token,
      body: {
        capture_session_id: captureSessionId,
        declared_weight_grams: 1240,
        length_cm: 22,
        width_cm: 18,
        height_cm: 12,
        device_id: "weight_guard_backend_mediated_self_test",
        captured_at: new Date().toISOString()
      },
      failureCategory: "FINALIZE"
    });
    const finalize = dataFromEnvelope(finalizeEnvelope);
    const finalizeSucceeded = finalize?.status === "PROOF_LOGGED" || finalize?.proofStatus === "READY_FOR_DISPUTE";
    if (!finalizeSucceeded || !assertSellerSafe(finalize)) {
      throw new BackendMediatedSelfTestSafetyError("Finalize response did not prove seller-safe proof capture.", "FINALIZE_CONTRACT_FAILED");
    }

    const proofEnvelope = await authenticatedGet({
      apiBaseUrl,
      path: `/v1/shipping/weight-proofs/${encodeURIComponent(fixture.awbNumber)}`,
      token,
      failureCategory: "GET_PROOF"
    });
    const proof = dataFromEnvelope(proofEnvelope);
    const getProofSellerSafe = Boolean(proof?.proof_status === "captured" || proof?.status === "available") && assertSellerSafe(proof);
    if (!getProofSellerSafe) {
      throw new BackendMediatedSelfTestSafetyError("GET proof response was not seller-safe.", "GET_PROOF_NOT_SELLER_SAFE");
    }

    const output = buildSafeOutput({
      authenticatedSellerContext: true,
      testAwb: fixture.awbNumber,
      uploadMode,
      uploadEndpointPresent,
      uploadVerified,
      finalizeSucceeded,
      getProofSellerSafe,
      directSignedUploadUsed: false,
      gcsWriteHappened: true,
      dbMutationScope: "staging_test_session_only",
      errorCategory: null
    });
    write(JSON.stringify(output, null, 2));
    return output;
  } catch (error) {
    const output = buildSafeOutput({
      testAwb: safeAwbNumber,
      errorCategory: safeErrorCategory(error),
      dbMutationScope: "staging_test_session_only"
    });
    write(JSON.stringify(output, null, 2));
    if (options.throwOnFailure) throw new Error(redactText(error?.message ?? error, source));
    return output;
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
}

async function main() {
  try {
    const output = await runBackendMediatedUploadSelfTest();
    if (output.errorCategory) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(buildSafeOutput({ errorCategory: safeErrorCategory(error) }), null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVAL_FLAG,
  AWB_PREFIX,
  BackendMediatedSelfTestSafetyError,
  assertSelfTestSafety,
  assertSellerSafe,
  buildSafeOutput,
  createOrReuseFixture,
  hashIdentity,
  redactText,
  resolveApiBaseUrl,
  runBackendMediatedUploadSelfTest,
  safeErrorCategory
};

if (require.main === module) {
  void main();
}
