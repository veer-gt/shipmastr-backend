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

function revisionJson(containers = [{ image }], name = revision) {
  return JSON.stringify({ metadata: { name }, spec: { containers } });
}

test("runner remains compatible with macOS Bash 3.2 array parsing", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.equal(/\b(?:mapfile|readarray)\b/u.test(source), false);
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
    EXPECTED_IMAGE_REF: image
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
      REVISION_JSON: revisionJson(containers),
      TAG_TO_FIND: tag,
      EXPECTED_REVISION: revision,
      ...(expectedImage === undefined ? {} : { EXPECTED_IMAGE_REF: expectedImage })
    });
    assert.equal(result.stderr, "");
    assert.notEqual(result.status, 0);
  }
});
