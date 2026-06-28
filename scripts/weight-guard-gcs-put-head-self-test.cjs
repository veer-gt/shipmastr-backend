#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const dotenv = require("dotenv");

dotenv.config();

const APPROVAL_FLAG = "YES_I_APPROVE_STAGING_GCS_DIAGNOSTIC_UPLOAD";
const OPERATION = "put_head_self_test";
const METADATA_SERVICE_ACCOUNT_EMAIL_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const DIAGNOSTIC_CONTENT_TYPE = "application/octet-stream";
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

function triState(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return "unknown";
}

function hashIdentity(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function safeErrorCode(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^[0-9]{3,6}$/.test(text)) return text;
  if (/^[A-Z0-9_:-]{1,80}$/.test(text) && !/[@/\\.?=&]/.test(text)) return text;
  return null;
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

function officialFailureText(diagnostic, error) {
  return [
    diagnostic?.category,
    diagnostic?.sanitizedMessage,
    diagnostic?.errorName,
    diagnostic?.errorClass,
    diagnostic?.errorCode,
    error?.code,
    error?.status,
    error?.name,
    error?.message
  ].filter(Boolean).map(String).join(" ").toLowerCase();
}

function classifyOfficialGetSignedUrlFailure(diagnostic, error) {
  const joined = officialFailureText(diagnostic, error);

  if (
    (joined.includes("iamcredentials.googleapis.com") || joined.includes("service account credentials api") || joined.includes("serviceusage"))
    && (joined.includes("disabled") || joined.includes("not enabled") || joined.includes("has not been used"))
  ) {
    return "SERVICE_ACCOUNT_CREDENTIALS_API_DISABLED";
  }

  if (
    (joined.includes("signblob") || joined.includes("sign blob") || joined.includes("iam.serviceaccounts.signblob"))
    && (joined.includes("denied") || joined.includes("permission") || joined.includes("403") || joined.includes("forbidden"))
  ) {
    return "IAM_SIGN_BLOB_DENIED";
  }

  if (
    (joined.includes("client_email") || joined.includes("service account email") || joined.includes("signer email") || joined.includes("metadata email"))
    && (joined.includes("missing") || joined.includes("unavailable") || joined.includes("not found") || joined.includes("could not"))
  ) {
    return "SIGNER_EMAIL_UNAVAILABLE";
  }

  if (
    joined.includes("private_key")
    || joined.includes("private key")
    || joined.includes("cannot sign")
    || joined.includes("no signer")
    || joined.includes("missing signer")
    || joined.includes("signing without")
  ) {
    return "NO_PRIVATE_KEY_OR_SIGNER";
  }

  if (
    (joined.includes("mismatch") || joined.includes("does not match") || joined.includes("invalid_grant"))
    && (joined.includes("signer") || joined.includes("service account"))
  ) {
    return "SIGNING_SERVICE_ACCOUNT_MISMATCH";
  }

  if (
    joined.includes("storage.objects.create")
    || (joined.includes("object create") && (joined.includes("denied") || joined.includes("permission") || joined.includes("403")))
  ) {
    return "STORAGE_OBJECT_CREATE_PERMISSION_MISSING";
  }

  if (
    joined.includes("storage.objects.get")
    || joined.includes("storage.objects.list")
    || ((joined.includes("object get") || joined.includes("object list")) && (joined.includes("denied") || joined.includes("permission") || joined.includes("403")))
  ) {
    return "STORAGE_OBJECT_GET_PERMISSION_MISSING";
  }

  if (
    joined.includes("invalid")
    || joined.includes("expires")
    || joined.includes("contenttype")
    || joined.includes("content-type")
    || joined.includes("argument")
    || joined.includes("config")
    || joined.includes("action")
  ) {
    return "OFFICIAL_GET_SIGNED_URL_CONFIG_INVALID";
  }

  return "UNKNOWN_SIGNED_URL_FAILURE";
}

function likelyPermissionValues(category) {
  return {
    serviceAccountCredentialsApiLikely: category === "SERVICE_ACCOUNT_CREDENTIALS_API_DISABLED" ? false : "unknown",
    signBlobLikelyAllowed: category === "IAM_SIGN_BLOB_DENIED" ? false : "unknown",
    storageCreateLikelyAllowed: category === "STORAGE_OBJECT_CREATE_PERMISSION_MISSING" ? false : "unknown",
    storageGetLikelyAllowed: category === "STORAGE_OBJECT_GET_PERMISSION_MISSING" ? false : "unknown"
  };
}

async function resolveRuntimeServiceAccountEmail(options = {}) {
  if (typeof options.metadataEmailResolver === "function") {
    const email = await options.metadataEmailResolver();
    return stringValue(email);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return "";

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? 1000) : null;
  try {
    const response = await fetchImpl(METADATA_SERVICE_ACCOUNT_EMAIL_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller?.signal
    });
    if (!response?.ok || typeof response.text !== "function") return "";
    return stringValue(await response.text());
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildRuntimeIdentityDiagnostics(source, options = {}) {
  const explicitSigner = stringValue(source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT);
  const runtimeEmail = await resolveRuntimeServiceAccountEmail(options).catch(() => "");
  const runtimeServiceAccountHash = hashIdentity(runtimeEmail);
  const explicitSigningServiceAccountHash = hashIdentity(explicitSigner);
  return {
    runtimeServiceAccountHash,
    explicitSigningServiceAccountHash,
    sameSignerHash: runtimeServiceAccountHash && explicitSigningServiceAccountHash
      ? runtimeServiceAccountHash === explicitSigningServiceAccountHash
      : "unknown",
    signerEmailPresent: Boolean(explicitSigner || runtimeEmail),
    metadataEmailNeeded: !Boolean(explicitSigner),
    adcAvailable: runtimeEmail ? true : "unknown"
  };
}

function buildOfficialSigningFailureDiagnostics({ source, diagnostic, error, runtimeIdentity }) {
  const errorCategory = classifyOfficialGetSignedUrlFailure(diagnostic, error);
  return {
    errorCategory,
    errorCode: safeErrorCode(diagnostic?.errorCode ?? error?.code ?? error?.status),
    hasMessage: Boolean(diagnostic?.sanitizedMessage || error?.message),
    hasStack: false,
    signerConfigured: Boolean(stringValue(source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT)),
    adcAvailable: triState(runtimeIdentity?.adcAvailable),
    explicitSignerConfigured: Boolean(stringValue(source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT)),
    ...likelyPermissionValues(errorCategory),
    runtimeServiceAccountHash: runtimeIdentity?.runtimeServiceAccountHash ?? null,
    explicitSigningServiceAccountHash: runtimeIdentity?.explicitSigningServiceAccountHash ?? null,
    sameSignerHash: triState(runtimeIdentity?.sameSignerHash),
    signerEmailPresent: Boolean(runtimeIdentity?.signerEmailPresent),
    metadataEmailNeeded: Boolean(runtimeIdentity?.metadataEmailNeeded),
    expiresFormat: diagnostic?.expiresFormat ?? "unknown",
    ttlSeconds: Number.isInteger(diagnostic?.ttlSeconds) ? diagnostic.ttlSeconds : null,
    contentTypePresent: Boolean(diagnostic?.contentTypePresent),
    officialConfigShapeValid: Boolean(diagnostic?.officialConfigShapeValid),
    hasUnsupportedOfficialSignedUrlOptions: Boolean(diagnostic?.hasUnsupportedOfficialSignedUrlOptions)
  };
}

function buildSafeOutput(input = {}) {
  return {
    signedUrlGenerated: Boolean(input.signedUrlGenerated),
    putStatus: input.putStatus ?? null,
    putOk: Boolean(input.putOk),
    xGoogGenerationPresent: Boolean(input.xGoogGenerationPresent),
    xGoogHashPresent: Boolean(input.xGoogHashPresent),
    xGoogStoredContentLengthPresent: Boolean(input.xGoogStoredContentLengthPresent),
    contentLengthResponseHeaderPresent: Boolean(input.contentLengthResponseHeaderPresent),
    headVerified: Boolean(input.headVerified),
    metadataVerified: Boolean(input.metadataVerified),
    listFoundMatchingHash: Boolean(input.listFoundMatchingHash),
    metadataCandidateResults: Array.isArray(input.metadataCandidateResults)
      ? input.metadataCandidateResults.map((candidate) => ({
        candidateName: String(candidate?.candidateName ?? "unknown"),
        candidateHash: candidate?.candidateHash ?? null,
        metadataFound: Boolean(candidate?.metadataFound)
      }))
      : [],
    sameObjectKeyHash: Boolean(input.sameObjectKeyHash),
    requiredHeadersUsed: Boolean(input.requiredHeadersUsed),
    errorCategory: input.errorCategory || "none",
    classification: input.classification || input.errorCategory || "none",
    errorCode: input.errorCode ?? null,
    hasMessage: Boolean(input.hasMessage),
    hasStack: false,
    signerConfigured: Boolean(input.signerConfigured),
    adcAvailable: triState(input.adcAvailable),
    explicitSignerConfigured: Boolean(input.explicitSignerConfigured),
    serviceAccountCredentialsApiLikely: triState(input.serviceAccountCredentialsApiLikely),
    signBlobLikelyAllowed: triState(input.signBlobLikelyAllowed),
    storageCreateLikelyAllowed: triState(input.storageCreateLikelyAllowed),
    storageGetLikelyAllowed: triState(input.storageGetLikelyAllowed),
    runtimeServiceAccountHash: input.runtimeServiceAccountHash ?? null,
    explicitSigningServiceAccountHash: input.explicitSigningServiceAccountHash ?? null,
    sameSignerHash: triState(input.sameSignerHash),
    signerEmailPresent: Boolean(input.signerEmailPresent),
    metadataEmailNeeded: Boolean(input.metadataEmailNeeded),
    expiresFormat: input.expiresFormat || "unknown",
    ttlSeconds: Number.isInteger(input.ttlSeconds) ? input.ttlSeconds : null,
    contentTypePresent: Boolean(input.contentTypePresent),
    officialConfigShapeValid: Boolean(input.officialConfigShapeValid),
    hasUnsupportedOfficialSignedUrlOptions: Boolean(input.hasUnsupportedOfficialSignedUrlOptions)
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

function safeResponseHeaderPresence(response) {
  const headers = response?.headers;
  const hasHeader = (name) => {
    if (!headers || typeof headers.get !== "function") return false;
    return headers.get(name) !== null;
  };
  return {
    xGoogGenerationPresent: hasHeader("x-goog-generation"),
    xGoogHashPresent: hasHeader("x-goog-hash"),
    xGoogStoredContentLengthPresent: hasHeader("x-goog-stored-content-length"),
    contentLengthResponseHeaderPresent: hasHeader("content-length") || hasHeader("content-range")
  };
}

function uniqueCandidateList(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const value = String(candidate?.objectKey ?? "");
    const cacheKey = `${candidate?.candidateName}:${value}`;
    if (!value || seen.has(cacheKey)) return false;
    seen.add(cacheKey);
    return true;
  });
}

function buildMetadataCandidateKeys({ objectKey, signedUrl, bucketName, storageModule }) {
  const raw = String(objectKey ?? "");
  let signedPathCandidate = "";
  try {
    const url = new URL(String(signedUrl ?? ""));
    const pathSegments = url.pathname.replace(/^\/+/, "").split("/");
    const bucketSegment = pathSegments.shift();
    if (bucketSegment && decodeURIComponent(bucketSegment) === String(bucketName ?? "") && pathSegments.length > 0) {
      signedPathCandidate = pathSegments.map((segment) => decodeURIComponent(segment)).join("/");
    }
  } catch {
    signedPathCandidate = "";
  }

  let slashPreservedDecodedRaw = raw;
  try {
    if (typeof storageModule.buildGcsXmlPathStyleObjectPath === "function") {
      slashPreservedDecodedRaw = storageModule.buildGcsXmlPathStyleObjectPath(raw).split("/").map((segment) => decodeURIComponent(segment)).join("/");
    }
  } catch {
    slashPreservedDecodedRaw = raw;
  }

  return uniqueCandidateList([
    { candidateName: "raw", objectKey: raw },
    { candidateName: "slash_preserved_decoded_raw", objectKey: slashPreservedDecodedRaw },
    { candidateName: "whole_key_encoded", objectKey: encodeURIComponent(raw) },
    { candidateName: "leading_slash", objectKey: `/${raw}` },
    { candidateName: "accidental_bucket_prefixed", objectKey: `${bucketName}/${raw}` },
    { candidateName: "accidental_double_prefix_diagnostic", objectKey: `weight-guard-diagnostics/${raw}` },
    { candidateName: "signed_path_decoded", objectKey: signedPathCandidate }
  ]);
}

async function inspectMetadataCandidateKeys(adapter, candidates, storageModule) {
  const results = [];
  for (const candidate of candidates) {
    const candidateDiagnostics = storageModule.getWeightProofObjectKeyDiagnostics(candidate.objectKey);
    let metadataFound = false;
    try {
      const head = await adapter.headObject({ objectKey: candidate.objectKey });
      metadataFound = Boolean(head?.exists);
    } catch {
      metadataFound = false;
    }
    results.push({
      candidateName: candidate.candidateName,
      candidateHash: candidateDiagnostics.objectKeyHash,
      metadataFound
    });
  }
  return results;
}

function classifyPutHeadDiagnostic({
  putOk,
  putResponseFacts,
  metadataCandidateResults,
  signedPathDiagnostics,
  headVerified,
  fallbackErrorCategory
}) {
  if (signedPathDiagnostics?.signedPathKeyHash && !signedPathDiagnostics.sameObjectKeyHash) {
    return "GCS_OBJECT_PATH_ENCODING_MISMATCH";
  }
  if (!putOk) return fallbackErrorCategory || "SIGNED_PUT_NOT_OK";
  if (!putResponseFacts?.xGoogGenerationPresent) return "PUT_200_WITHOUT_GCS_OBJECT_GENERATION";
  if (metadataCandidateResults?.some((candidate) => candidate.metadataFound)) return "GCS_OBJECT_KEY_VARIANT_IDENTIFIED";
  if (headVerified) return "GCS_OBJECT_KEY_VARIANT_IDENTIFIED";
  return "PUT_CREATED_UNKNOWN_OBJECT_IDENTITY";
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
  const expiresAt = new Date(now.getTime() + 600000);
  const officialConfigDiagnostics = typeof storageModule.buildOfficialGcsWriteSignedUrlConfig === "function"
    ? storageModule.buildOfficialGcsWriteSignedUrlConfig({
      expiresAt,
      contentType: DIAGNOSTIC_CONTENT_TYPE,
      nowMs: now.getTime()
    }).diagnostics
    : {
      expiresFormat: "unknown",
      ttlSeconds: null,
      contentTypePresent: true,
      officialConfigShapeValid: false,
      hasUnsupportedOfficialSignedUrlOptions: false
    };
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
  let metadataCandidateResults = [];
  let requiredHeadersUsed = false;
  let putResponseFacts = {
    xGoogGenerationPresent: false,
    xGoogHashPresent: false,
    xGoogStoredContentLengthPresent: false,
    contentLengthResponseHeaderPresent: false
  };
  const runtimeIdentity = await buildRuntimeIdentityDiagnostics(source, {
    metadataEmailResolver: options.metadataEmailResolver,
    fetchImpl: options.metadataFetch
  });

  try {
    const result = await adapter.createPresignedPutUrl({
      objectKey,
      contentType: DIAGNOSTIC_CONTENT_TYPE,
      expectedByteSize: DIAGNOSTIC_PNG.length,
      expiresAt
    });
    signedUrlGenerated = Boolean(result.uploadUrl);
    signedPathDiagnostics = buildSignedPathDiagnostics(storageModule, {
      rawObjectKey: objectKey,
      signedUrl: result.uploadUrl,
      bucketName: config.bucket
    });
    const headers = safeUploadHeaders(result.headers);
    requiredHeadersUsed = result.method === "PUT"
      && headers["Content-Type"] === DIAGNOSTIC_CONTENT_TYPE
      && (!headers["x-goog-content-sha256"] || headers["x-goog-content-sha256"] === "UNSIGNED-PAYLOAD")
      && !Object.prototype.hasOwnProperty.call(headers, "Authorization")
      && Object.keys(headers).every((header) => ["Content-Type", "x-goog-content-sha256"].includes(header));
    const response = await fetch(result.uploadUrl, {
      method: "PUT",
      headers,
      body: DIAGNOSTIC_PNG
    });
    putStatus = response.status;
    putOk = [200, 201, 204].includes(response.status);
    putResponseFacts = safeResponseHeaderPresence(response);
    if (putOk) {
      headObjectDiagnostics = storageModule.getWeightProofObjectKeyDiagnostics(objectKey);
      try {
        const verification = await verifyHeadWithRetry(adapter, objectKey, storageModule);
        headObjectDiagnostics = verification.headObjectDiagnostics;
        headVerified = verification.headVerified;
        metadataVerified = verification.metadataVerified;
      } catch {
        headVerified = false;
        metadataVerified = false;
      }
      metadataCandidateResults = await inspectMetadataCandidateKeys(adapter, buildMetadataCandidateKeys({
        objectKey,
        signedUrl: result.uploadUrl,
        bucketName: config.bucket,
        storageModule
      }), storageModule);
      listFoundMatchingHash = metadataCandidateResults.some((candidate) => candidate.metadataFound)
        || await listDiagnosticMatchingHash(adapter, objectKey, storageModule);
    }
    const sameObjectKeyHash = Boolean(
      rawObjectDiagnostics.objectKeyHash
        && rawObjectDiagnostics.objectKeyHash === signedPathDiagnostics.signedPathKeyHash
        && rawObjectDiagnostics.objectKeyHash === headObjectDiagnostics.objectKeyHash
    );
    const classification = classifyPutHeadDiagnostic({
      putOk,
      putResponseFacts,
      metadataCandidateResults,
      signedPathDiagnostics,
      headVerified,
      fallbackErrorCategory: putOk ? "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED" : "SIGNED_PUT_NOT_OK"
    });
    const output = buildSafeOutput({
      signedUrlGenerated,
      putStatus,
      putOk,
      ...putResponseFacts,
      headVerified,
      metadataVerified,
      listFoundMatchingHash,
      metadataCandidateResults,
      sameObjectKeyHash,
      requiredHeadersUsed,
      errorCategory: classification === "GCS_OBJECT_KEY_VARIANT_IDENTIFIED" ? "none" : classification,
      classification,
      ...officialConfigDiagnostics
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
    const officialSigningFailure = !signedUrlGenerated
      ? buildOfficialSigningFailureDiagnostics({
        source,
        diagnostic: diagnostics.at(-1) ?? null,
        error,
        runtimeIdentity
      })
      : null;
    const classification = officialSigningFailure?.errorCategory ?? classifyPutHeadDiagnostic({
      putOk,
      putResponseFacts,
      metadataCandidateResults,
      signedPathDiagnostics,
      headVerified,
      fallbackErrorCategory: safeErrorCategory(diagnostics.at(-1) ?? error)
    });
    const output = buildSafeOutput({
      signedUrlGenerated,
      putStatus,
      putOk,
      ...putResponseFacts,
      headVerified,
      metadataVerified,
      listFoundMatchingHash,
      metadataCandidateResults,
      sameObjectKeyHash,
      requiredHeadersUsed,
      errorCategory: classification === "GCS_OBJECT_KEY_VARIANT_IDENTIFIED" ? "none" : classification,
      classification,
      ...officialSigningFailure,
      ...officialConfigDiagnostics
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
  buildOfficialSigningFailureDiagnostics,
  buildRuntimeIdentityDiagnostics,
  classifyOfficialGetSignedUrlFailure,
  hashIdentity,
  safeErrorCategory,
  safeUploadHeaders
};

if (require.main === module) {
  void main();
}
