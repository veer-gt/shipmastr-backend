import assert from "node:assert/strict";
import test from "node:test";
import { ProbeSchemaError, canonicalizeJson, expectedLogLabelMetadata, parseExpectedLogLabels, validateLogEntry } from "./rate-limit-proxy-probe-evidence-schema.mjs";

const validOptions = { expectedCase: "baseline", expectedRevision: "shipmastr-api-staging-gen1", expectedLabels: { environment: "diagnostic", generation: "one" }, probeToken: "c".repeat(64) };

function completeEntry() {
  return {
    insertId: "gen1-baseline",
    jsonPayload: { eventName: "rate_limit_proxy_probe", probeCase: "baseline", path: "/api/health", forwardedPresent: false, forwardedParseStatus: "absent", forwardedElementCount: null, forwardedMarkerPosition: null, xForwardedForPresent: false, xForwardedForElementCount: 0, xForwardedForMarkerPosition: null, reqIpEqualsSocket: true, reqIpXForwardedForPosition: null, socketXForwardedForPosition: null },
    labels: { instanceId: "a".repeat(145), environment: "diagnostic", generation: "one" },
    logName: "projects/shipmastr-core-prod/logs/run.googleapis.com%2Fstdout", receiveTimestamp: "2026-08-17T06:00:00Z",
    resource: { type: "cloud_run_revision", labels: { project_id: "shipmastr-core-prod", service_name: "shipmastr-api-staging", configuration_name: "shipmastr-api-staging", location: "asia-south1", revision_name: "shipmastr-api-staging-gen1" } },
    severity: "INFO", timestamp: "2026-08-17T06:00:00Z"
  };
}

test("canonical label metadata is stable across input key order", () => {
  const left = expectedLogLabelMetadata({ z: "last", a: "first" });
  const right = expectedLogLabelMetadata({ a: "first", z: "last" });
  assert.deepEqual(left, right);
  assert.equal(left.canonicalJson, '{"a":"first","z":"last"}');
  assert.equal(left.count, 2);
  assert.match(left.sha256, /^[0-9a-f]{64}$/u);
});

test("canonicalizeJson sorts nested objects without reordering arrays", () => {
  assert.equal(canonicalizeJson({ z: [2, { b: 1, a: 0 }], a: true }), '{"a":true,"z":[2,{"a":0,"b":1}]}');
});

test("schema errors expose only fixed codes", () => {
  assert.throws(() => validateLogEntry({ secretUnexpectedField: "do-not-echo" }, validOptions), (error) => error instanceof ProbeSchemaError && /^[A-Z0-9_]+$/u.test(error.code) && !JSON.stringify(error).includes("secretUnexpectedField") && !JSON.stringify(error).includes("do-not-echo"));
});

test("expected-label metadata is caller-independent", () => {
  const parsed = { environment: "diagnostic" };
  const metadata = expectedLogLabelMetadata(parsed);
  const before = { canonicalJson: metadata.canonicalJson, sha256: metadata.sha256, count: metadata.count };
  parsed.environment = "changed";
  assert.deepEqual({ canonicalJson: metadata.canonicalJson, sha256: metadata.sha256, count: metadata.count }, before);
  assert.equal(metadata.value.environment, "diagnostic");
  assert.equal(parseExpectedLogLabels('{"environment":"diagnostic"}').value.environment, "diagnostic");
});

test("expected-label parsing rejects malformed and bounded-invalid maps with fixed codes", () => {
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, "v"]));
  for (const raw of ["", "{", "[]", "null", JSON.stringify(tooMany), JSON.stringify({ key: 1 }), JSON.stringify({ "x\u0001": "v" }), JSON.stringify({ key: "v\u0001" })]) {
    assert.throws(() => parseExpectedLogLabels(raw), ProbeSchemaError);
  }
  assert.throws(() => expectedLogLabelMetadata(Object.create(null)), ProbeSchemaError);
});

test("expected-label metadata accepts all documented map boundaries", () => {
  const wide = { ["k".repeat(128)]: "v".repeat(256) };
  assert.equal(expectedLogLabelMetadata({}).count, 0);
  assert.equal(expectedLogLabelMetadata(wide).count, 1);
  const exactSize = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    `k${String(index).padStart(3, "0")}`, "v".repeat(index === 63 ? 245 : 246)
  ]));
  const metadata = expectedLogLabelMetadata(exactSize);
  assert.equal(metadata.count, 64);
  assert.equal(Buffer.byteLength(metadata.canonicalJson, "utf8"), 16_384);
  exactSize.k000 = "v".repeat(247);
  assert.throws(() => expectedLogLabelMetadata(exactSize), ProbeSchemaError);
});

test("expected-label metadata and parser accept empty configured values", () => {
  const labels = { optional: "" };
  const metadata = expectedLogLabelMetadata(labels);
  assert.deepEqual(metadata.value, labels);
  assert.equal(metadata.canonicalJson, '{"optional":""}');
  assert.deepEqual(parseExpectedLogLabels('{"optional":""}').value, labels);
});

test("expected-label maps reject invalid key bounds while retaining zero-length values", () => {
  for (const labels of [{ "": "value" }, { ["k".repeat(129)]: "value" }, { "k\u0001": "value" }, { key: null }]) {
    assert.throws(() => expectedLogLabelMetadata(labels), ProbeSchemaError);
  }
  assert.deepEqual(parseExpectedLogLabels('{"empty":""}').value, { empty: "" });
});

test("schema rejects sensitive values only after an otherwise-valid configured label passes validation", () => {
  for (const value of ["https://example.invalid/", "192.0.2.1", "2001:db8::1", "Forwarded: for=x", "X-Forwarded-For: x", "for=x", "c".repeat(64)]) {
    const entry = completeEntry();
    entry.labels.note = value;
    assert.throws(
      () => validateLogEntry(entry, { ...validOptions, expectedLabels: { environment: "diagnostic", generation: "one", note: value } }),
      (error) => error instanceof ProbeSchemaError && error.code === "SENSITIVE_VALUE"
    );
  }
});

test("schema keeps the final projection sensitive-value scan active", () => {
  const entry = completeEntry();
  let pathReads = 0;
  Object.defineProperty(entry.jsonPayload, "path", {
    enumerable: true,
    get() {
      pathReads += 1;
      return pathReads < 3 ? "/api/health" : "https://example.invalid/";
    }
  });
  assert.throws(
    () => validateLogEntry(entry, validOptions),
    (error) => error instanceof ProbeSchemaError && error.code === "SENSITIVE_OUTPUT"
  );
});
