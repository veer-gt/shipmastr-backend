import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runnerPath = resolve("scripts/rate-limit-proxy-probe.sh");
const parserPath = resolve("scripts/rate-limit-proxy-probe-parsers.mjs");
const tag = "rlp-0817123456-a1b2c3d4-001122334455";
const revision = "shipmastr-api-staging-probe";
const image = "asia-south1-docker.pkg.dev/example/service@sha256:" + "a".repeat(64);

function runParser(command, env) {
  return spawnSync(process.execPath, [parserPath, command], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function serviceJson(traffic) {
  return JSON.stringify({ status: { traffic } });
}

function revisionJson({
  containers = [{ image }],
  name = revision,
  generation = "gen1",
  concurrency = 40
} = {}) {
  return JSON.stringify({
    metadata: {
      name,
      annotations: { "run.googleapis.com/execution-environment": generation }
    },
    spec: { containers, containerConcurrency: concurrency }
  });
}

test("runner remains compatible with macOS Bash 3.2 array parsing", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.equal(/\b(?:mapfile|readarray)\b/u.test(source), false);
});

const observedRuntime = {
  STAGING_TEMPLATE_EXECUTION_ENVIRONMENT: "__absent__",
  STAGING_TEMPLATE_CONTAINER_CONCURRENCY: "80",
  STAGING_ACTIVE_EXECUTION_ENVIRONMENT: "__absent__",
  STAGING_ACTIVE_CONTAINER_CONCURRENCY: "80",
  PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT: "__absent__",
  PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY: "40"
};

test("matrix preflight accepts the measured unspecified runtime shape", () => {
  const result = runParser("matrix-preflight", observedRuntime);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    stagingTemplate: { executionEnvironment: "unspecified", concurrency: 80 },
    stagingActive: { executionEnvironment: "unspecified", concurrency: 80 },
    productionActive: { executionEnvironment: "unspecified", concurrency: 40 }
  });
});

test("matrix preflight rejects production concurrency other than 40", () => {
  for (const concurrency of ["39", "41", "__absent__", "forty"]) {
    const result = runParser("matrix-preflight", {
      ...observedRuntime,
      PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY: concurrency
    });
    assert.equal(result.stdout, "");
    assert.notEqual(result.status, 0);
  }
});

test("matrix preflight rejects unknown execution-environment values", () => {
  const result = runParser("matrix-preflight", {
    ...observedRuntime,
    STAGING_ACTIVE_EXECUTION_ENVIRONMENT: "auto"
  });
  assert.equal(result.stdout, "");
  assert.notEqual(result.status, 0);
});

test("production fingerprint is stable and changes with service state", () => {
  const original = JSON.stringify({
    metadata: {
      name: "shipmastr-api",
      generation: 12,
      annotations: { "run.googleapis.com/ingress": "all" },
      labels: { "cloud.googleapis.com/location": "asia-south1" }
    },
    spec: { traffic: [{ revisionName: "prod-r1", percent: 100 }] },
    status: { latestCreatedRevisionName: "prod-r1", latestReadyRevisionName: "prod-r1" }
  });
  const same = runParser("production-fingerprint", { SERVICE_JSON: original });
  const changed = runParser("production-fingerprint", {
    SERVICE_JSON: original.replaceAll("prod-r1", "prod-r2")
  });
  const annotationChanged = runParser("production-fingerprint", {
    SERVICE_JSON: original.replace('"run.googleapis.com/ingress":"all"', '"run.googleapis.com/ingress":"internal"')
  });
  const labelChanged = runParser("production-fingerprint", {
    SERVICE_JSON: original.replace('"asia-south1"', '"us-central1"')
  });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /^[0-9a-f]{64}\n$/u);
  assert.notEqual(same.stdout, changed.stdout);
  assert.notEqual(same.stdout, annotationChanged.stdout);
  assert.notEqual(same.stdout, labelChanged.stdout);
});

test("owned tag and immutable image pass cleanup ownership validation", () => {
  const service = serviceJson([{ tag, revisionName: revision, percent: 0 }]);
  const state = runParser("tag-state", {
    SERVICE_JSON: service,
    TAG_TO_FIND: tag
  });
  assert.equal(state.status, 0, state.stderr);
  assert.equal(state.stdout, `${revision}\n`);

  const ownership = runParser("owned-tag", {
    SERVICE_JSON: service,
    REVISION_JSON: revisionJson(),
    TAG_TO_FIND: tag,
    EXPECTED_REVISION: revision,
    EXPECTED_IMAGE_REF: image,
    EXPECTED_EXECUTION_ENVIRONMENT: "gen1",
    EXPECTED_CONTAINER_CONCURRENCY: "40"
  });
  assert.equal(ownership.status, 0, ownership.stderr);
  assert.equal(ownership.stdout, "owned\n");
});

test("foreign tag target is rejected", () => {
  const result = runParser("owned-tag", {
    SERVICE_JSON: serviceJson([{ tag, revisionName: "foreign-revision", percent: 0 }]),
    REVISION_JSON: revisionJson(),
    TAG_TO_FIND: tag,
    EXPECTED_REVISION: revision,
    EXPECTED_IMAGE_REF: image
  });
  assert.equal(result.stderr, "");
  assert.notEqual(result.status, 0);
});

test("missing or ambiguous tag revisions are rejected", () => {
  for (const traffic of [
    [{ tag, percent: 0 }],
    [
      { tag, revisionName: revision, percent: 0 },
      { tag, revisionName: revision, percent: 0 }
    ]
  ]) {
    const result = runParser("tag-state", {
      SERVICE_JSON: serviceJson(traffic),
      TAG_TO_FIND: tag
    });
    assert.equal(result.stderr, "");
    assert.notEqual(result.status, 0);
  }
});

test("missing or ambiguous revision images are rejected", () => {
  const service = serviceJson([{ tag, revisionName: revision, percent: 0 }]);
  for (const [containers, expectedImage] of [
    [[], image],
    [[{ image }, { image }], image],
    [[{}], image],
    [[{ image }], undefined]
  ]) {
    const result = runParser("owned-tag", {
      SERVICE_JSON: service,
      REVISION_JSON: revisionJson({ containers }),
      TAG_TO_FIND: tag,
      EXPECTED_REVISION: revision,
      EXPECTED_EXECUTION_ENVIRONMENT: "gen1",
      EXPECTED_CONTAINER_CONCURRENCY: "40",
      ...(expectedImage === undefined ? {} : { EXPECTED_IMAGE_REF: expectedImage })
    });
    assert.equal(result.stderr, "");
    assert.notEqual(result.status, 0);
  }
});

test("owned tag requires the expected generation and concurrency", () => {
  const service = serviceJson([{ tag, revisionName: revision, percent: 0 }]);
  const accepted = runParser("owned-tag", {
    SERVICE_JSON: service,
    REVISION_JSON: revisionJson({ generation: "gen1", concurrency: 40 }),
    TAG_TO_FIND: tag,
    EXPECTED_REVISION: revision,
    EXPECTED_IMAGE_REF: image,
    EXPECTED_EXECUTION_ENVIRONMENT: "gen1",
    EXPECTED_CONTAINER_CONCURRENCY: "40"
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "owned\n");

  for (const overrides of [
    { EXPECTED_EXECUTION_ENVIRONMENT: "gen2" },
    { EXPECTED_CONTAINER_CONCURRENCY: "80" }
  ]) {
    const rejected = runParser("owned-tag", {
      SERVICE_JSON: service,
      REVISION_JSON: revisionJson({ generation: "gen1", concurrency: 40 }),
      TAG_TO_FIND: tag,
      EXPECTED_REVISION: revision,
      EXPECTED_IMAGE_REF: image,
      EXPECTED_EXECUTION_ENVIRONMENT: "gen1",
      EXPECTED_CONTAINER_CONCURRENCY: "40",
      ...overrides
    });
    assert.notEqual(rejected.status, 0);
  }
});
