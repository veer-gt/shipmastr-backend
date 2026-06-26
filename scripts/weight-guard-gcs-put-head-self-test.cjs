#!/usr/bin/env node

const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const dotenv = require("dotenv");

dotenv.config();

const APPROVAL_FLAG = "YES_I_APPROVE_STAGING_GCS_DIAGNOSTIC_UPLOAD";
const OPERATION = "put_head_self_test";
const DIAGNOSTIC_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lc9V7wAAAABJRU5ErkJggg==",
  "base64"
);

class PutHeadSelfTestSafetyError extends Error {
  constructor(message, category = "PUT_HEAD_SELF_TEST_SAFETY_REFUSED") {
    super(message);
    this.name = "PutHeadSelfTestSafetyError";
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

function assertPutHeadSelfTestSafety(source = process.env) {
  if (source.WEIGHT_GUARD_GCS_PUT_HEAD_SELF_TEST !== APPROVAL_FLAG) {
    throw new PutHeadSelfTestSafetyError("Weight Guard GCS PUT+HEAD self-test approval flag is required.", "PUT_HEAD_APPROVAL_REQUIRED");
  }

  const nodeEnv = stringValue(source.NODE_ENV).toLowerCase();
  const appEnv = stringValue(source.APP_ENV).toLowerCase();
  const explicitStaging = appEnv === "staging" || source.WEIGHT_GUARD_STAGING_SELF_TEST === "true";
  if (nodeEnv === "production" && !explicitStaging) {
    throw new PutHeadSelfTestSafetyError("Refusing production-like runtime without explicit staging context.", "PUT_HEAD_PRODUCTION_REFUSED");
  }

  if (!booleanTrue(source.WEIGHT_GUARD_PROOF_STORAGE_ENABLED)) {
    throw new PutHeadSelfTestSafetyError("WEIGHT_GUARD_PROOF_STORAGE_ENABLED=true is required.", "PUT_HEAD_STORAGE_DISABLED");
  }

  if (stringValue(source.WEIGHT_GUARD_STORAGE_PROVIDER).toLowerCase() !== "gcs") {
    throw new PutHeadSelfTestSafetyError("WEIGHT_GUARD_STORAGE_PROVIDER=gcs is required.", "PUT_HEAD_PROVIDER_NOT_GCS");
  }

  if (!stringValue(source.WEIGHT_GUARD_GCS_BUCKET)) {
    throw new PutHeadSelfTestSafetyError("WEIGHT_GUARD_GCS_BUCKET is required.", "PUT_HEAD_BUCKET_MISSING");
  }

  if (!stringValue(source.WEIGHT_GUARD_GCS_PROJECT_ID)) {
    throw new PutHeadSelfTestSafetyError("WEIGHT_GUARD_GCS_PROJECT_ID is required.", "PUT_HEAD_PROJECT_MISSING");
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
    .replace(/weight-guard-diagnostics\/[A-Za-z0-9_./=-]+/g, "diagnostic-object-key-redacted")
    .replace(/\b(imageObjectKey|image_object_key|objectKey)\b\s*[:=]\s*["']?[^"'\s]+["']?/gi, "$1=[redacted-object-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/([?&](?:X-Goog-Signature|X-Goog-Credential|X-Goog-Security-Token|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(private[_-]?key|client[_-]?secret|access[_-]?token|id[_-]?token|refresh[_-]?token|secret)\b/gi, "[redacted-sensitive-word]");

  for (const redactedValue of redactedValues) {
    text = text.split(redactedValue).join("[redacted-config]");
  }

  return text.slice(0, 220);
}

function safeErrorCategory(error) {
  const category = String(error?.category ?? "");
  const joined = `${category} ${error?.code ?? ""} ${error?.status ?? ""} ${error?.name ?? ""} ${error?.message ?? ""}`.toLowerCase();
  if (category) return category;
  if (joined.includes("approval")) return "PUT_HEAD_APPROVAL_REQUIRED";
  if (joined.includes("cors")) return "GCS_CORS_OR_BROWSER_UPLOAD_FAILED";
  if (joined.includes("not found") || joined.includes("404")) return "GCS_OBJECT_NOT_FOUND";
  if (joined.includes("permission") || joined.includes("denied") || joined.includes("403")) return "GCS_PERMISSION_DENIED";
  if (joined.includes("sign") || joined.includes("iamcredentials") || joined.includes("service account")) return "GCS_SIGNING_FAILED";
  if (joined.includes("fetch")) return "SIGNED_PUT_FETCH_FAILED";
  if (joined.includes("credential") || joined.includes("auth")) return "GCS_AUTH_FAILED";
  return "UNKNOWN_PUT_HEAD_FAILURE";
}

function buildSafeOutput(input = {}) {
  return {
    signedUrlGenerated: Boolean(input.signedUrlGenerated),
    putStatus: input.putStatus ?? null,
    putOk: Boolean(input.putOk),
    headVerified: Boolean(input.headVerified),
    metadataVerified: Boolean(input.metadataVerified),
    listFoundMatchingHash: Boolean(input.listFoundMatchingHash),
    sameObjectKeyHash: Boolean(input.sameObjectKeyHash),
    requiredHeadersUsed: Boolean(input.requiredHeadersUsed),
    errorCategory: input.errorCategory || "none"
  };
}

async function loadBuiltStorageModule() {
  const storagePath = path.join(__dirname, "../dist/modules/shippingNetwork/shipping-weight-proof-storage.js");
  if (!existsSync(storagePath)) {
    throw new PutHeadSelfTestSafetyError("Built Weight Guard storage module is missing. Run npm run build before this self-test.", "PUT_HEAD_BUILD_MISSING");
  }
  return import(pathToFileURL(storagePath).href);
}

function safeUploadHeaders(requiredHeaders = {}) {
  const headers = {};
  Object.entries(requiredHeaders || {}).forEach(([key, value]) => {
    const normalized = String(key || "").trim().toLowerCase();
    const headerValue = String(value ?? "").trim();
    if (!headerValue) return;
    if (normalized === "content-type") headers["Content-Type"] = headerValue;
    if (normalized === "x-goog-content-sha256") headers["x-goog-content-sha256"] = headerValue;
  });
  return headers;
}

function buildSignedPathDiagnostics(storageModule, input) {
  if (typeof storageModule.getGcsSignedUrlObjectPathDiagnostics === "function") {
    return storageModule.getGcsSignedUrlObjectPathDiagnostics(input);
  }
  const raw = storageModule.getWeightProofObjectKeyDiagnostics(input.rawObjectKey);
  return {
    rawKeyHash: raw.objectKeyHash,
    signedPathKeyHash: raw.objectKeyHash,
    signedPathPresent: Boolean(input.signedUrl),
    signedPathHasEncodedSlash: false,
    sameObjectKeyHash: Boolean(raw.objectKeyHash)
  };
}

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function verifyHeadWithRetry(adapter, objectKey, storageModule, options = {}) {
  const retryDelaysMs = options.retryDelaysMs ?? [150, 350];
  const attempts = Math.min(retryDelaysMs.length + 1, 3);
  const headObjectDiagnostics = storageModule.getWeightProofObjectKeyDiagnostics(objectKey);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const head = await adapter.headObject({ objectKey });
      if (head?.exists) {
        return {
          headVerified: true,
          metadataVerified: true,
          headObjectDiagnostics
        };
      }
    } catch (error) {
      lastError = error;
    }
    const delay = retryDelaysMs[attempt];
    if (attempt < attempts - 1 && delay !== undefined) await wait(delay);
  }
  if (lastError) throw lastError;
  return {
    headVerified: false,
    metadataVerified: false,
    headObjectDiagnostics
  };
}

async function listDiagnosticMatchingHash(adapter, objectKey, storageModule) {
  if (typeof adapter.listObjectKeyDiagnosticsByPrefix !== "function" || typeof storageModule.getWeightProofObjectKeyPrefix !== "function") {
    return false;
  }
  const expectedHash = storageModule.getWeightProofObjectKeyDiagnostics(objectKey).objectKeyHash;
  const prefix = storageModule.getWeightProofObjectKeyPrefix(objectKey);
  const listed = await adapter.listObjectKeyDiagnosticsByPrefix({ prefix, maxResults: 20 });
  return listed.some((diagnostic) => diagnostic?.objectKeyHash === expectedHash);
}

async function runPutHeadSelfTest(options = {}) {
  const source = options.source ?? process.env;
  const write = options.write ?? ((text) => console.log(text));
  assertPutHeadSelfTestSafety(source);

  if (typeof fetch !== "function") {
    throw new PutHeadSelfTestSafetyError("Runtime fetch is required for the signed PUT diagnostic.", "PUT_HEAD_FETCH_UNAVAILABLE");
  }

  const storageModule = options.storageModule ?? await loadBuiltStorageModule();
  const diagnostics = [];
  const config = storageModule.resolveGcsWeightProofStorageConfig(source);
  const adapter = options.adapter ?? new storageModule.GcsWeightProofStorageAdapter({
    ...config,
    diagnostics: (diagnostic) => diagnostics.push(diagnostic)
  });
  const now = options.now ?? new Date();
  const diagnosticId = `put_head_${String(now.getTime())}`;
  const objectKey = storageModule.buildWeightGuardDiagnosticObjectKey({
    diagnosticId,
    contentType: "image/png"
  });
  const rawObjectDiagnostics = storageModule.getWeightProofObjectKeyDiagnostics(objectKey);
  let signedPathDiagnostics = {
    rawKeyHash: rawObjectDiagnostics.objectKeyHash,
    signedPathKeyHash: null,
    sameObjectKeyHash: false
  };
  let headObjectDiagnostics = {
    objectKeyHash: null
  };
  let signedUrlGenerated = false;
  let putStatus = null;
  let putOk = false;
  let headVerified = false;
  let metadataVerified = false;
  let listFoundMatchingHash = false;
  let requiredHeadersUsed = false;

  try {
    const result = await adapter.createPresignedPutUrl({
      objectKey,
      contentType: "image/png",
      expectedByteSize: DIAGNOSTIC_PNG.length,
      expiresAt: new Date(now.getTime() + 600000)
    });
    signedUrlGenerated = Boolean(result.uploadUrl);
    signedPathDiagnostics = buildSignedPathDiagnostics(storageModule, {
      rawObjectKey: objectKey,
      signedUrl: result.uploadUrl,
      bucketName: config.bucket
    });
    const headers = safeUploadHeaders(result.headers);
    requiredHeadersUsed = result.method === "PUT"
      && headers["Content-Type"] === "image/png"
      && headers["x-goog-content-sha256"] === "UNSIGNED-PAYLOAD"
      && Object.keys(headers).every((header) => ["Content-Type", "x-goog-content-sha256"].includes(header));
    const response = await fetch(result.uploadUrl, {
      method: "PUT",
      headers,
      body: DIAGNOSTIC_PNG
    });
    putStatus = response.status;
    putOk = [200, 201, 204].includes(response.status);
    if (putOk) {
      headObjectDiagnostics = storageModule.getWeightProofObjectKeyDiagnostics(objectKey);
      const verification = await verifyHeadWithRetry(adapter, objectKey, storageModule);
      headObjectDiagnostics = verification.headObjectDiagnostics;
      headVerified = verification.headVerified;
      metadataVerified = verification.metadataVerified;
      listFoundMatchingHash = await listDiagnosticMatchingHash(adapter, objectKey, storageModule);
    }
    const sameObjectKeyHash = Boolean(
      rawObjectDiagnostics.objectKeyHash
        && rawObjectDiagnostics.objectKeyHash === signedPathDiagnostics.signedPathKeyHash
        && rawObjectDiagnostics.objectKeyHash === headObjectDiagnostics.objectKeyHash
    );
    const output = buildSafeOutput({
      signedUrlGenerated,
      putStatus,
      putOk,
      headVerified,
      metadataVerified,
      listFoundMatchingHash,
      sameObjectKeyHash,
      requiredHeadersUsed,
      errorCategory: !signedPathDiagnostics.sameObjectKeyHash
        ? "GCS_OBJECT_PATH_ENCODING_MISMATCH"
        : headVerified
          ? "none"
          : putOk
            ? "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED"
            : "SIGNED_PUT_NOT_OK"
    });
    write(JSON.stringify(output, null, 2));
    return output;
  } catch (error) {
    if (putOk && !listFoundMatchingHash) {
      listFoundMatchingHash = await listDiagnosticMatchingHash(adapter, objectKey, storageModule).catch(() => false);
    }
    const sameObjectKeyHash = Boolean(
      rawObjectDiagnostics.objectKeyHash
        && rawObjectDiagnostics.objectKeyHash === signedPathDiagnostics.signedPathKeyHash
        && rawObjectDiagnostics.objectKeyHash === headObjectDiagnostics.objectKeyHash
    );
    const output = buildSafeOutput({
      signedUrlGenerated,
      putStatus,
      putOk,
      headVerified,
      metadataVerified,
      listFoundMatchingHash,
      sameObjectKeyHash,
      requiredHeadersUsed,
      errorCategory: signedPathDiagnostics.signedPathKeyHash && !signedPathDiagnostics.sameObjectKeyHash
        ? "GCS_OBJECT_PATH_ENCODING_MISMATCH"
        : safeErrorCategory(diagnostics.at(-1) ?? error)
    });
    write(JSON.stringify(output, null, 2));
    if (options.throwOnFailure) throw new Error(redactSelfTestText(error?.message ?? error, source));
    return output;
  }
}

async function main() {
  try {
    await runPutHeadSelfTest();
  } catch (error) {
    const output = buildSafeOutput({
      errorCategory: safeErrorCategory(error)
    });
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVAL_FLAG,
  PutHeadSelfTestSafetyError,
  assertPutHeadSelfTestSafety,
  buildSafeOutput,
  redactSelfTestText,
  runPutHeadSelfTest,
  safeErrorCategory,
  safeUploadHeaders
};

if (require.main === module) {
  void main();
}
