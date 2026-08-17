import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const evidencePath = resolve("scripts/rate-limit-proxy-probe-evidence.mjs");
const cases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];
const revisions = { gen1: "shipmastr-api-staging-gen1", gen2: "shipmastr-api-staging-gen2" };
const configuredLabels = {
  gen1: { environment: "diagnostic", generation: "one" },
  gen2: { environment: "diagnostic", generation: "two" }
};

function structuralEvent(probeCase, overrides = {}) {
  return {
    eventName: "rate_limit_proxy_probe", probeCase, path: "/api/health",
    forwardedPresent: probeCase.includes("forwarded") || probeCase.includes("both"),
    forwardedParseStatus: probeCase === "baseline" || probeCase === "xff-ipv4" ? "absent" : "simple",
    forwardedElementCount: probeCase === "baseline" || probeCase === "xff-ipv4" ? null : 1,
    forwardedMarkerPosition: null,
    xForwardedForPresent: probeCase !== "baseline" && probeCase !== "forwarded-ipv4",
    xForwardedForElementCount: probeCase === "baseline" || probeCase === "forwarded-ipv4" ? 0 : 1,
    xForwardedForMarkerPosition: null, reqIpEqualsSocket: true,
    reqIpXForwardedForPosition: null, socketXForwardedForPosition: null, ...overrides
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMergeForTest(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMergeForTest(base[key], value) : value;
  }
  return result;
}

function fullLogEntry(generation, probeCase, overrides = {}) {
  const entry = {
    insertId: `${generation}-${probeCase}`,
    jsonPayload: { ...structuralEvent(probeCase), hostname: "probe-host", level: 30, msg: "rate limit proxy probe", pid: 42, time: 1_787_000_000_000 },
    labels: { instanceId: "a".repeat(145), environment: "diagnostic", generation: generation === "gen1" ? "one" : "two" },
    logName: "projects/shipmastr-core-prod/logs/run.googleapis.com%2Fstdout",
    receiveTimestamp: "2026-08-17T06:00:00.123456789Z",
    resource: { type: "cloud_run_revision", labels: {
      project_id: "shipmastr-core-prod", service_name: "shipmastr-api-staging",
      configuration_name: "shipmastr-api-staging", location: "asia-south1", revision_name: revisions[generation]
    } },
    severity: "INFO", timestamp: "2026-08-17T06:00:00Z"
  };
  return deepMergeForTest(entry, overrides);
}

function cloudEntries(generation, overrides = {}) {
  return cases.map((probeCase) => fullLogEntry(generation, probeCase, overrides[probeCase]));
}

function runEvidence(matrix, overrides = {}) {
  return spawnSync(process.execPath, [evidencePath, "assemble"], { encoding: "utf8", env: {
    ...process.env, MATRIX_LOGS_JSON: JSON.stringify(matrix), PROBE_TOKEN_FOR_LEAK_CHECK: "b".repeat(64),
    GEN1_REVISION: revisions.gen1, GEN2_REVISION: revisions.gen2,
    GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify(configuredLabels.gen1),
    GEN2_EXPECTED_LOG_LABELS_JSON: JSON.stringify(configuredLabels.gen2), ...overrides
  } });
}

function assertRejected(matrix, message) {
  const result = runEvidence(matrix);
  assert.equal(result.stdout, "", message);
  assert.equal(result.stderr, "", message);
  assert.notEqual(result.status, 0, message);
}

function mutateOne(mutator) {
  const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  mutator(matrix.gen1[0]);
  return matrix;
}

test("assembler emits ten projected events and exact matches from complete log entries", () => {
  const result = runEvidence({ gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.events.length, 10);
  assert.deepEqual(evidence.events.map(({ generation }) => generation), ["gen1", "gen1", "gen1", "gen1", "gen1", "gen2", "gen2", "gen2", "gen2", "gen2"]);
  assert.equal(evidence.comparison.exactMatch, true);
  assert.doesNotMatch(result.stdout, /instanceId|"environment"|"labels"|logName/u);
});

test("assembler retains all events for a legitimate structural mismatch", () => {
  const result = runEvidence({ gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2", { "xff-ipv4": { jsonPayload: { xForwardedForElementCount: 2 } } }) });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.events.length, 10);
  assert.deepEqual(evidence.comparison.cases.filter(({ equal }) => !equal), [{ probeCase: "xff-ipv4", equal: false }]);
});

test("assembler fail-closes complete-envelope violations", () => {
  const mutations = [
    ...["insertId", "jsonPayload", "labels", "logName", "receiveTimestamp", "resource", "severity", "timestamp"].map((key) => (entry) => { delete entry[key]; }),
    ...["httpRequest", "metadata", "split", "errorGroups", "apphub", "apphubDestination", "apphubSource", "otel", "protoPayload", "textPayload", "futureLoggingField"].map((key) => (entry) => { entry[key] = "synthetic"; }),
    (entry) => { entry.resource.extra = true; },
    (entry) => { entry.resource.labels.extra = "x"; },
    (entry) => { entry.operation = { id: "x", producer: "y", first: true, last: true, extra: true }; },
    (entry) => { entry.sourceLocation = { file: "a", line: "1", function: "b", extra: true }; },
    (entry) => { entry.jsonPayload.extra = true; },
    (entry) => { entry.insertId = ""; }, (entry) => { entry.insertId = "a".repeat(257); }, (entry) => { entry.insertId = "bad\u0001"; },
    (entry) => { entry.timestamp = "2026-02-31T00:00:00Z"; }, (entry) => { entry.receiveTimestamp = "2026-08-17T06:00:00.1234567890Z"; },
    (entry) => { entry.logName = "projects/other/logs/stdout"; }, (entry) => { entry.severity = "ERROR"; },
    (entry) => { entry.trace = "projects/shipmastr-core-prod/traces/" + "A".repeat(32); }, (entry) => { entry.spanId = "A".repeat(16); }, (entry) => { entry.traceSampled = "true"; },
    (entry) => { entry.resource.labels.revision_name = revisions.gen2; }, (entry) => { entry.labels.instanceId = "g"; },
    (entry) => { entry.labels.environment = "not-diagnostic"; }, (entry) => { entry.labels.unexpected = "x"; },
    (entry) => { entry.operation = {}; }, (entry) => { entry.sourceLocation = {}; },
    (entry) => { entry.jsonPayload.hostname = ""; }, (entry) => { entry.jsonPayload.level = 31; }, (entry) => { entry.jsonPayload.pid = 0; }, (entry) => { entry.jsonPayload.time = -1; }
  ];
  for (const change of mutations) assertRejected(mutateOne(change));
});

test("assembler accepts bounded optional Cloud Logging fields and keeps labels out of evidence", () => {
  const optional = { operation: { id: "o".repeat(256), producer: "p".repeat(256), first: true, last: false }, sourceLocation: { file: "f".repeat(512), line: "4294967295", function: "n".repeat(512) }, spanId: "b".repeat(16), trace: "projects/shipmastr-core-prod/traces/" + "c".repeat(32), traceSampled: false, labels: { instanceId: "d".repeat(256), environment: "diagnostic", generation: "one" } };
  const result = runEvidence({ gen1: cloudEntries("gen1", { baseline: optional }), gen2: cloudEntries("gen2") });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"labels"/u);
});

test("assembler rejects invalid label maps and sensitive values without output", () => {
  const valid = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  for (const rawLabels of ["", "[]", "{", JSON.stringify({ key: 1 })]) {
    const result = runEvidence(valid, { GEN1_EXPECTED_LOG_LABELS_JSON: rawLabels });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); assert.notEqual(result.status, 0);
  }
  for (const value of ["https://example.invalid/", "192.0.2.1", "2001:db8::1", "Forwarded: for=x", "X-Forwarded-For: x", "for=x", "b".repeat(64)]) {
    assertRejected(mutateOne((entry) => { entry.jsonPayload.msg = value; }), value);
  }
});

test("assembler validates every remaining Cloud Logging boundary fail-closed", () => {
  const invalid = [
    (entry) => { entry.insertId = null; }, (entry) => { entry.jsonPayload = null; },
    (entry) => { entry.labels = null; }, (entry) => { entry.logName = 1; },
    (entry) => { entry.receiveTimestamp = null; }, (entry) => { entry.resource = null; },
    (entry) => { entry.severity = null; }, (entry) => { entry.timestamp = null; },
    (entry) => { entry.operation = null; }, (entry) => { entry.sourceLocation = null; },
    (entry) => { entry.spanId = null; }, (entry) => { entry.trace = null; },
    (entry) => { entry.traceSampled = null; },
    (entry) => { entry.timestamp = "2026-08-17"; }, (entry) => { entry.timestamp = "2026-08-17T06:00:00.1234567890+05:30"; },
    (entry) => { entry.timestamp = "2026-13-17T06:00:00Z"; }, (entry) => { entry.timestamp = "2026-08-17T24:00:00Z"; },
    (entry) => { delete entry.resource.labels.project_id; }, (entry) => { entry.resource.labels.project_id = "other"; },
    (entry) => { entry.resource.labels.service_name = "other"; }, (entry) => { entry.resource.labels.configuration_name = "other"; },
    (entry) => { entry.resource.labels.location = "other"; }, (entry) => { entry.resource.type = "other"; },
    (entry) => { entry.labels.instanceId = ""; }, (entry) => { entry.labels.instanceId = "a".repeat(257); },
    (entry) => { entry.labels.instanceId = "a\u0001"; }, (entry) => { delete entry.labels.instanceId; },
    (entry) => { entry.operation = { id: "", producer: "p", first: true, last: true }; },
    (entry) => { entry.operation = { id: "i", producer: "p", first: "true", last: true }; },
    (entry) => { entry.operation = { id: "i\u0001", producer: "p", first: true, last: true }; },
    (entry) => { entry.sourceLocation = { file: "f", line: "-1", function: "n" }; },
    (entry) => { entry.sourceLocation = { file: "f", line: 1, function: "n" }; },
    (entry) => { entry.sourceLocation = { file: "f", line: "4294967296", function: "n" }; },
    (entry) => { entry.sourceLocation = { file: "f".repeat(513), line: "1", function: "n" }; },
    (entry) => { entry.jsonPayload.hostname = 1; }, (entry) => { entry.jsonPayload.level = "30"; },
    (entry) => { entry.jsonPayload.msg = 1; }, (entry) => { entry.jsonPayload.pid = 2_147_483_648; },
    (entry) => { entry.jsonPayload.time = Number.MAX_SAFE_INTEGER + 1; },
    (entry) => { entry.jsonPayload.forwardedPresent = "false"; }, (entry) => { entry.jsonPayload.forwardedElementCount = -1; },
    (entry) => { entry.jsonPayload.forwardedMarkerPosition = 0; }, (entry) => { entry.jsonPayload.xForwardedForPresent = 0; },
    (entry) => { entry.jsonPayload.xForwardedForElementCount = -1; }, (entry) => { entry.jsonPayload.reqIpEqualsSocket = null; }
  ];
  for (const change of invalid) assertRejected(mutateOne(change));
  const inverse = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  inverse.gen2[0].resource.labels.revision_name = revisions.gen1;
  assertRejected(inverse, "gen2 revision must not cross into gen1");
});

test("assembler accepts RFC 3339 variants and absent allowed fields", () => {
  for (const timestamp of ["2026-08-17T06:00:00Z", "2026-08-17T06:00:00.1Z", "2026-08-17T06:00:00.123456789+05:30"]) {
    const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
    matrix.gen1[0].timestamp = timestamp;
    const result = runEvidence(matrix);
    assert.equal(result.status, 0, timestamp);
  }
  const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  for (const entry of [...matrix.gen1, ...matrix.gen2]) {
    for (const key of ["hostname", "level", "msg", "pid", "time"]) delete entry.jsonPayload[key];
    delete entry.labels.environment; delete entry.labels.generation;
  }
  const result = runEvidence(matrix, { GEN1_EXPECTED_LOG_LABELS_JSON: "{}", GEN2_EXPECTED_LOG_LABELS_JSON: "{}" });
  assert.equal(result.status, 0, result.stderr);
});

test("assembler enforces raw-matrix and expected-label-map bounds", () => {
  const valid = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  for (const rawMatrix of ["", " "]) {
    const result = runEvidence(valid, { MATRIX_LOGS_JSON: rawMatrix });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); assert.notEqual(result.status, 0);
  }
  const oversized = spawnSync(process.execPath, ["--input-type=module", "-e", `
    process.argv[2] = "assemble";
    process.env.MATRIX_LOGS_JSON = "{".repeat(262145);
    process.env.PROBE_TOKEN_FOR_LEAK_CHECK = "b".repeat(64);
    process.env.GEN1_REVISION = "shipmastr-api-staging-gen1";
    process.env.GEN2_REVISION = "shipmastr-api-staging-gen2";
    process.env.GEN1_EXPECTED_LOG_LABELS_JSON = "{}";
    process.env.GEN2_EXPECTED_LOG_LABELS_JSON = "{}";
    await import(${JSON.stringify(new URL("./rate-limit-proxy-probe-evidence.mjs", import.meta.url).href)});
  `], { encoding: "utf8" });
  assert.equal(oversized.stdout, ""); assert.equal(oversized.stderr, ""); assert.notEqual(oversized.status, 0);
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, "v"]));
  const invalidMaps = [JSON.stringify(tooMany), JSON.stringify({ "a\u0001": "v" }), JSON.stringify({ key: "v\u0001" }), JSON.stringify({ key: "v".repeat(257) })];
  for (const rawLabels of invalidMaps) {
    const result = runEvidence(valid, { GEN1_EXPECTED_LOG_LABELS_JSON: rawLabels });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); assert.notEqual(result.status, 0);
  }
});

test("assembler accepts an empty configured-label value when the entry carries it", () => {
  const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  matrix.gen1[0].labels.optional = "";
  const result = runEvidence(matrix, {
    GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify({ ...configuredLabels.gen1, optional: "" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).events.length, 10);
});

test("assembler rejects matrix count, order, trace, span, and remaining nested bounds", () => {
  const shortGeneration = { gen1: cloudEntries("gen1").slice(0, 4), gen2: cloudEntries("gen2") };
  assertRejected(shortGeneration, "generation array must contain all five cases");
  const wrongOrder = { gen1: cloudEntries("gen1").reverse(), gen2: cloudEntries("gen2") };
  assertRejected(wrongOrder, "generation arrays must retain the fixed case order");
  const invalid = [
    (entry) => { entry.jsonPayload.eventName = "other"; }, (entry) => { entry.jsonPayload.path = "/other"; },
    (entry) => { entry.jsonPayload.forwardedParseStatus = "other"; }, (entry) => { entry.jsonPayload.socketXForwardedForPosition = -1; },
    (entry) => { entry.trace = "projects/other/traces/" + "a".repeat(32); },
    (entry) => { entry.trace = "projects/shipmastr-core-prod/traces/" + "a".repeat(31); },
    (entry) => { entry.trace = "projects/shipmastr-core-prod/traces/" + "a".repeat(33); },
    (entry) => { entry.trace = "projects/shipmastr-core-prod/traces/" + "g".repeat(32); },
    (entry) => { entry.spanId = "a".repeat(15); }, (entry) => { entry.spanId = "a".repeat(17); },
    (entry) => { entry.spanId = "g".repeat(16); },
    (entry) => { entry.operation = { id: "i".repeat(257), producer: "p", first: true, last: true }; },
    (entry) => { entry.operation = { id: "i", producer: "p".repeat(257), first: true, last: true }; },
    (entry) => { entry.operation = { id: "i", producer: "p", first: true, last: "false" }; },
    (entry) => { entry.operation = { id: "i", producer: "p", first: true, last: true, unknown: true }; },
    (entry) => { entry.sourceLocation = { file: "", line: "1", function: "n" }; },
    (entry) => { entry.sourceLocation = { file: "f", line: "1.5", function: "n" }; },
    (entry) => { entry.sourceLocation = { file: "f", line: "1", function: "n\u0001" }; },
    (entry) => { entry.sourceLocation = { file: "f", line: "1", function: "n", unknown: true }; },
    (entry) => { entry.jsonPayload.hostname = "h".repeat(256); }, (entry) => { entry.jsonPayload.hostname = "h\u0001"; },
    (entry) => { entry.jsonPayload.level = 29; }, (entry) => { entry.jsonPayload.pid = "42"; }, (entry) => { entry.jsonPayload.time = "0"; }
  ];
  for (const change of invalid) assertRejected(mutateOne(change));
});

test("assembler accepts exact comparison cases and configured-label map boundaries", () => {
  const matching = runEvidence({ gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") });
  assert.equal(matching.status, 0, matching.stderr);
  assert.deepEqual(JSON.parse(matching.stdout).comparison.cases, cases.map((probeCase) => ({ probeCase, equal: true })));
  const labels64 = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, "v"]));
  const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  for (const entry of [...matrix.gen1, ...matrix.gen2]) { delete entry.labels.environment; delete entry.labels.generation; }
  const result = runEvidence(matrix, { GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify(labels64), GEN2_EXPECTED_LOG_LABELS_JSON: JSON.stringify(labels64) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).events.length, 10);
});

test("Task 1 structural-field and receiveTimestamp matrix fails closed per mutation", () => {
  const structuralWrongTypes = [
    ["eventName", []], ["probeCase", {}], ["path", false], ["forwardedPresent", null],
    ["forwardedParseStatus", false], ["forwardedElementCount", "0"], ["forwardedMarkerPosition", {}],
    ["xForwardedForPresent", null], ["xForwardedForElementCount", "0"], ["xForwardedForMarkerPosition", {}],
    ["reqIpEqualsSocket", "true"], ["reqIpXForwardedForPosition", {}], ["socketXForwardedForPosition", []]
  ];
  for (const [key, value] of structuralWrongTypes) {
    assertRejected(mutateOne((entry) => { entry.jsonPayload[key] = value; }), `structural ${key}`);
  }
  const structuralBounds = [
    ["forwardedElementCount", -1], ["forwardedElementCount", 2_147_483_648],
    ["forwardedMarkerPosition", 0], ["forwardedMarkerPosition", 2_147_483_648],
    ["xForwardedForElementCount", 2_147_483_648], ["xForwardedForMarkerPosition", 0],
    ["reqIpXForwardedForPosition", 0], ["socketXForwardedForPosition", 0]
  ];
  for (const [key, value] of structuralBounds) {
    assertRejected(mutateOne((entry) => { entry.jsonPayload[key] = value; }), `structural bound ${key}`);
  }
  for (const value of ["", "2026-08-17", "2026-08-17T06:00:00.1234567890Z", "2026-02-31T06:00:00Z", "2026-08-17T24:00:00Z"]) {
    assertRejected(mutateOne((entry) => { entry.receiveTimestamp = value; }), `receiveTimestamp ${value.length}`);
  }
  for (const value of ["2026-08-17T06:00:00Z", "2026-08-17T06:00:00.1Z", "2026-08-17T06:00:00.123456789+05:30"]) {
    const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
    matrix.gen1[0].receiveTimestamp = value;
    const result = runEvidence(matrix);
    assert.equal(result.status, 0, `valid receiveTimestamp ${value}`);
    assert.equal(JSON.parse(result.stdout).events.length, 10);
  }
});

test("Task 1 envelope resource optional and Pino matrix fails closed per mutation", () => {
  const invalid = [
    (entry) => { entry.insertId = false; }, (entry) => { entry.logName = {}; },
    (entry) => { entry.receiveTimestamp = false; }, (entry) => { entry.severity = []; }, (entry) => { entry.timestamp = {}; },
    (entry) => { entry.resource.labels = []; }, (entry) => { entry.resource.labels.project_id = 1; },
    (entry) => { delete entry.resource.labels.service_name; }, (entry) => { delete entry.resource.labels.configuration_name; },
    (entry) => { delete entry.resource.labels.location; }, (entry) => { delete entry.resource.labels.revision_name; },
    (entry) => { entry.resource.labels.extra = "x"; },
    (entry) => { entry.trace = "x".repeat(80); }, (entry) => { entry.spanId = "A".repeat(16); },
    (entry) => { entry.traceSampled = 0; },
    (entry) => { entry.operation = { id: "i\u0001", producer: "p", first: true, last: true }; },
    (entry) => { entry.operation = { id: "i", producer: "p\u0001", first: true, last: true }; },
    (entry) => { entry.sourceLocation = { file: "f\u0001", line: "1", function: "n" }; },
    (entry) => { entry.sourceLocation = { file: "f", line: "1", function: "n".repeat(513) }; },
    (entry) => { entry.jsonPayload.hostname = null; }, (entry) => { entry.jsonPayload.level = 30.5; },
    (entry) => { entry.jsonPayload.msg = "other"; }, (entry) => { entry.jsonPayload.pid = -1; }, (entry) => { entry.jsonPayload.time = -1; }
  ];
  for (const change of invalid) assertRejected(mutateOne(change));
});

test("Task 1 expected-label-map real-process matrix handles key and size boundaries", () => {
  const valid = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  const exactSize = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${String(index).padStart(3, "0")}`, "v".repeat(index === 63 ? 245 : 246)]));
  const oversized = { ...exactSize, k000: "v".repeat(247) };
  const invalidMaps = [
    { "": "v" }, { ["k".repeat(129)]: "v" }, { "k\u0001": "v" }, { key: null },
    { key: "v".repeat(257) }, oversized
  ];
  for (const labels of invalidMaps) {
    const result = runEvidence(valid, { GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify(labels) });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); assert.notEqual(result.status, 0);
  }
  const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
  for (const entry of [...matrix.gen1, ...matrix.gen2]) { delete entry.labels.environment; delete entry.labels.generation; }
  const validMaps = [{ ["k".repeat(128)]: "v".repeat(256) }, exactSize];
  for (const labels of validMaps) {
    const result = runEvidence(matrix, { GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify(labels), GEN2_EXPECTED_LOG_LABELS_JSON: JSON.stringify(labels) });
    assert.equal(result.status, 0, "valid expected labels");
    assert.equal(JSON.parse(result.stdout).events.length, 10);
  }
});

test("Task 1 sensitive values reach the real assembler scanner through allowed labels", () => {
  for (const value of ["https://example.invalid/", "192.0.2.1", "2001:db8::1", "Forwarded: for=x", "X-Forwarded-For: x", "for=x", "b".repeat(64)]) {
    const matrix = { gen1: cloudEntries("gen1"), gen2: cloudEntries("gen2") };
    matrix.gen1[0].labels.note = value;
    const result = runEvidence(matrix, { GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify({ ...configuredLabels.gen1, note: value }) });
    assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); assert.notEqual(result.status, 0, value);
  }
});
