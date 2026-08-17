import { createHash } from "node:crypto";
import {
  expectedLogLabelMetadata,
  ProbeSchemaError
} from "./rate-limit-proxy-probe-evidence-schema.mjs";

function fail(code) {
  process.exit(code);
}

function requiredText(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) fail(2);
  return value;
}

function parseObject(name) {
  let value;
  try {
    value = JSON.parse(requiredText(name));
  } catch {
    fail(2);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(2);
  return value;
}

function matchingTagEntries() {
  const service = parseObject("SERVICE_JSON");
  const tag = requiredText("TAG_TO_FIND");
  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic)) fail(3);
  return traffic.filter((entry) => entry?.tag === tag);
}

function normalizeGeneration(value) {
  if (value === "__absent__") return "unspecified";
  if (value === "gen1" || value === "gen2") return value;
  fail(3);
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) fail(3);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(3);
  return parsed;
}

function matrixPreflight() {
  const state = {
    stagingTemplate: {
      executionEnvironment: normalizeGeneration(requiredText("STAGING_TEMPLATE_EXECUTION_ENVIRONMENT")),
      concurrency: positiveInteger(requiredText("STAGING_TEMPLATE_CONTAINER_CONCURRENCY"))
    },
    stagingActive: {
      executionEnvironment: normalizeGeneration(requiredText("STAGING_ACTIVE_EXECUTION_ENVIRONMENT")),
      concurrency: positiveInteger(requiredText("STAGING_ACTIVE_CONTAINER_CONCURRENCY"))
    },
    productionActive: {
      executionEnvironment: normalizeGeneration(requiredText("PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT")),
      concurrency: positiveInteger(requiredText("PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY"))
    }
  };
  if (state.productionActive.concurrency !== 40) fail(4);
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

function productionFingerprint() {
  const service = parseObject("SERVICE_JSON");
  const projection = {
    name: service?.metadata?.name,
    generation: service?.metadata?.generation,
    annotations: service?.metadata?.annotations,
    labels: service?.metadata?.labels,
    spec: service?.spec,
    latestCreatedRevisionName: service?.status?.latestCreatedRevisionName,
    latestReadyRevisionName: service?.status?.latestReadyRevisionName,
    traffic: service?.status?.traffic
  };
  if (projection.name !== "shipmastr-api" || projection.spec === undefined) fail(3);
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  };
  process.stdout.write(`${createHash("sha256")
    .update(JSON.stringify(canonicalize(projection)))
    .digest("hex")}\n`);
}

function tagState() {
  const matches = matchingTagEntries();
  if (matches.length === 0) {
    process.stdout.write("absent\n");
    return;
  }
  if (matches.length !== 1) fail(4);
  const revision = matches[0]?.revisionName;
  if (typeof revision !== "string" || revision.length === 0) fail(4);
  process.stdout.write(`${revision}\n`);
}

function ownedTag() {
  const expectedRevision = requiredText("EXPECTED_REVISION");
  const expectedImage = requiredText("EXPECTED_IMAGE_REF");
  const expectedGeneration = requiredText("EXPECTED_EXECUTION_ENVIRONMENT");
  const expectedConcurrency = positiveInteger(requiredText("EXPECTED_CONTAINER_CONCURRENCY"));
  if (!/@sha256:[0-9a-f]{64}$/u.test(expectedImage)) fail(2);
  if (expectedGeneration !== "gen1" && expectedGeneration !== "gen2") fail(2);

  const matches = matchingTagEntries();
  if (
    matches.length !== 1 ||
    matches[0]?.revisionName !== expectedRevision
  ) fail(4);

  const revision = parseObject("REVISION_JSON");
  if (revision?.metadata?.name !== expectedRevision) fail(5);
  if (
    revision?.metadata?.annotations?.["run.googleapis.com/execution-environment"] !== expectedGeneration ||
    revision?.spec?.containerConcurrency !== expectedConcurrency
  ) fail(5);
  const containers = revision?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) fail(5);
  if (containers[0]?.image !== expectedImage) fail(5);
  process.stdout.write("owned\n");
}

function revisionLogLabels() {
  const revision = parseObject("REVISION_JSON");
  const labels = revision?.metadata?.labels;
  const metadata = expectedLogLabelMetadata(labels);
  process.stdout.write(
    `${metadata.canonicalJson}\n${metadata.sha256}\n${metadata.count}\n`
  );
}

const command = process.argv[2];
if (command === "tag-state") {
  tagState();
} else if (command === "owned-tag") {
  ownedTag();
} else if (command === "matrix-preflight") {
  matrixPreflight();
} else if (command === "production-fingerprint") {
  productionFingerprint();
} else if (command === "revision-log-labels") {
  try {
    revisionLogLabels();
  } catch (error) {
    if (error instanceof ProbeSchemaError) fail(4);
    throw error;
  }
} else {
  fail(64);
}
