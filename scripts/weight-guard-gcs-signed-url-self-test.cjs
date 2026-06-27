#!/usr/bin/env node

const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const dotenv = require("dotenv");

dotenv.config();

const APPROVAL_FLAG = "YES_I_APPROVE_STAGING_SIGNED_URL_DIAGNOSTIC";
const OPERATION = "signed_put_self_test";

class SelfTestSafetyError extends Error {
  constructor(message, category = "SELF_TEST_SAFETY_REFUSED") {
    super(message);
    this.name = "SelfTestSafetyError";
    this.category = category;
  }
}

function booleanTrue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function stringValue(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function assertSelfTestSafety(source = process.env) {
  if (source.WEIGHT_GUARD_GCS_SELF_TEST !== APPROVAL_FLAG) {
    throw new SelfTestSafetyError("Weight Guard GCS self-test approval flag is required.", "SELF_TEST_APPROVAL_REQUIRED");
  }

  const nodeEnv = stringValue(source.NODE_ENV).toLowerCase();
  const appEnv = stringValue(source.APP_ENV).toLowerCase();
  const explicitStaging = appEnv === "staging" || source.WEIGHT_GUARD_STAGING_SELF_TEST === "true";
  if (nodeEnv === "production" && !explicitStaging) {
    throw new SelfTestSafetyError("Refusing production-like runtime without explicit staging context.", "SELF_TEST_PRODUCTION_REFUSED");
  }

  if (!booleanTrue(source.WEIGHT_GUARD_PROOF_STORAGE_ENABLED)) {
    throw new SelfTestSafetyError("WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true is required.", "SELF_TEST_STORAGE_DISABLED");
  }

  if (stringValue(source.WEIGHT_GUARD_STORAGE_PROVIDER).toLowerCase() !== "gcs") {
    throw new SelfTestSafetyError("WEIGHT_GUARD_STORAGE_PROVIDER=gcs is required.", "SELF_TEST_PROVIDER_NOT_GCS");
  }

  if (!stringValue(source.WEIGHT_GUARD_GCS_BUCKET)) {
    throw new SelfTestSafetyError("WEIGHT_GUARD_GCS_BUCKET is required.", "SELF_TEST_BUCKET_MISSING");
  }

  if (!stringValue(source.WEIGHT_GUARD_GCS_PROJECT_ID)) {
    throw new SelfTestSafetyError("WEIGHT_GUARD_GCS_PROJECT_ID is required.", "SELF_TEST_PROJECT_MISSING");
  }
}

function redactSelfTestText(value, source = process.env) {
  const redactedValues = [
    source.WEIGHT_GUARD_GCS_BUCKET,
    source.WEIGHT_GUARD_GCS_PROJECT_ID,
    source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT,
    source.DATABASE_URL
  ].filter(Boolean).map(String);

  let text = String(value ?? "")
    .replace(/https?:\/\/[^\s")]+/gi, "[redacted-url]")
    .replace(/storage[.]googleapis[.]com/gi, "[redacted-storage-host]")
    .replace(/weight-proofs\/[A-Za-z0-9_./=-]+/g, "object-key-redacted")
    .replace(/\b(imageObjectKey|image_object_key|objectKey)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi, "$1=[redacted-object-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/([?&](?:X-Goog-Signature|X-Goog-Credential|X-Goog-Security-Token|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(private[_-]?key|client[_-]?secret|access[_-]?token|id[_-]?token|refresh[_-]?token|secret)\b/gi, "[redacted-sensitive-word]");

  for (const redactedValue of redactedValues) {
    text = text.split(redactedValue).join("[redacted-config]");
  }

  return text.slice(0, 220);
}

function classifySafeFailure(diagnostic, error) {
  const category = String(diagnostic?.category ?? "");
  const joined = `${category} ${diagnostic?.sanitizedMessage ?? ""} ${diagnostic?.errorName ?? ""} ${diagnostic?.errorClass ?? ""} ${error?.message ?? ""}`.toLowerCase();

  if (category === "GCS_PERMISSION_DENIED" || joined.includes("permission") || joined.includes("denied") || joined.includes("403")) {
    return "IAM_SIGN_BLOB_DENIED";
  }

  if (joined.includes("metadata") || joined.includes("service account unavailable")) {
    return "METADATA_SERVICE_ACCOUNT_UNAVAILABLE";
  }

  if (joined.includes("iamcredentials") || joined.includes("credentials") || joined.includes("auth")) {
    return "IAM_CREDENTIALS_API_FAILURE";
  }

  if (joined.includes("canonical") || joined.includes("signature")) {
    return "INVALID_CANONICAL_SIGNATURE";
  }

  if (joined.includes("library signer") || joined.includes("get signed url")) {
    return "GCS_LIBRARY_SIGNING_FAILURE";
  }

  return "UNKNOWN_SIGNING_FAILURE";
}

function buildSafeSelfTestOutput(input) {
  const diagnostic = input.diagnostic;
  const error = input.error;
  const signedUrlGenerated = Boolean(input.signedUrlGenerated);
  const requiredHeadersPresent = Boolean(input.requiredHeadersPresent);
  const safeCategory = signedUrlGenerated ? "none" : classifySafeFailure(diagnostic, error);
  const errorClass = diagnostic?.errorClass
    ?? (error instanceof Error ? error.constructor.name : typeof error);
  const rawMessage = diagnostic?.sanitizedMessage ?? (error?.message ?? "");

  return {
    provider: "gcs",
    operation: OPERATION,
    signedUrlGenerated,
    requiredHeadersPresent,
    errorCategory: safeCategory,
    safeErrorClass: signedUrlGenerated ? "none" : redactSelfTestText(errorClass, input.source),
    safeMessage: signedUrlGenerated ? "none" : redactSelfTestText(rawMessage, input.source),
    signingServiceAccountConfigured: Boolean(stringValue(input.source?.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT)),
    explicitSignerConfigured: Boolean(stringValue(input.source?.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT)),
    metadataEmailNeeded: !Boolean(stringValue(input.source?.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT))
  };
}

async function loadBuiltStorageModule() {
  const storagePath = path.join(__dirname, "../dist/modules/shippingNetwork/shipping-weight-proof-storage.js");
  if (!existsSync(storagePath)) {
    throw new SelfTestSafetyError("Built Weight Guard storage module is missing. Run npm run build before this self-test.", "SELF_TEST_BUILD_MISSING");
  }
  return import(pathToFileURL(storagePath).href);
}

function buildDiagnosticObjectKey(storageModule, now = new Date()) {
  return storageModule.buildWeightProofObjectKey({
    sellerOrMerchantId: "diagnostic",
    awbNumber: "WGDIAG001",
    captureSessionId: `selftest_${String(now.getTime())}`,
    capturedAt: now,
    contentType: "image/png"
  });
}

async function runSelfTest(options = {}) {
  const source = options.source ?? process.env;
  const write = options.write ?? ((text) => console.log(text));
  assertSelfTestSafety(source);

  const storageModule = options.storageModule ?? await loadBuiltStorageModule();
  const diagnostics = [];
  const config = storageModule.resolveGcsWeightProofStorageConfig(source);
  const adapter = new storageModule.GcsWeightProofStorageAdapter({
    ...config,
    diagnostics: (diagnostic) => diagnostics.push(diagnostic)
  });
  const now = options.now ?? new Date();
  const objectKey = buildDiagnosticObjectKey(storageModule, now);

  try {
    const result = await adapter.createPresignedPutUrl({
      objectKey,
      contentType: "image/png",
      expectedByteSize: 2048,
      expiresAt: new Date(now.getTime() + 600000)
    });
    const output = buildSafeSelfTestOutput({
      source,
      signedUrlGenerated: Boolean(result.uploadUrl),
      requiredHeadersPresent: result.method === "PUT"
        && result.headers?.["content-type"] === "image/png"
        && (!result.headers?.["x-goog-content-sha256"] || result.headers?.["x-goog-content-sha256"] === "UNSIGNED-PAYLOAD"),
      diagnostic: null,
      error: null
    });
    write(JSON.stringify(output, null, 2));
    return output;
  } catch (error) {
    const output = buildSafeSelfTestOutput({
      source,
      signedUrlGenerated: false,
      requiredHeadersPresent: false,
      diagnostic: diagnostics.at(-1) ?? null,
      error
    });
    write(JSON.stringify(output, null, 2));
    return output;
  }
}

async function main() {
  try {
    await runSelfTest();
  } catch (error) {
    const output = buildSafeSelfTestOutput({
      source: process.env,
      signedUrlGenerated: false,
      requiredHeadersPresent: false,
      diagnostic: null,
      error
    });
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVAL_FLAG,
  SelfTestSafetyError,
  assertSelfTestSafety,
  buildDiagnosticObjectKey,
  buildSafeSelfTestOutput,
  classifySafeFailure,
  redactSelfTestText,
  runSelfTest
};

if (require.main === module) {
  void main();
}
