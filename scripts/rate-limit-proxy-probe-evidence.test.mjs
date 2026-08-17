import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const evidencePath = resolve("scripts/rate-limit-proxy-probe-evidence.mjs");
const cases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];

function structuralEvent(probeCase, overrides = {}) {
  return {
    eventName: "rate_limit_proxy_probe",
    probeCase,
    path: "/api/health",
    forwardedPresent: probeCase.includes("forwarded") || probeCase.includes("both"),
    forwardedParseStatus: probeCase === "baseline" || probeCase === "xff-ipv4" ? "absent" : "simple",
    forwardedElementCount: probeCase === "baseline" || probeCase === "xff-ipv4" ? null : 1,
    forwardedMarkerPosition: null,
    xForwardedForPresent: probeCase !== "baseline" && probeCase !== "forwarded-ipv4",
    xForwardedForElementCount: probeCase === "baseline" || probeCase === "forwarded-ipv4" ? 0 : 1,
    xForwardedForMarkerPosition: null,
    reqIpEqualsSocket: true,
    reqIpXForwardedForPosition: null,
    socketXForwardedForPosition: null,
    ...overrides
  };
}

function cloudEntries(overrides = {}) {
  return cases.map((probeCase) => ({
    jsonPayload: {
      ...structuralEvent(probeCase),
      level: 30,
      msg: "rate limit proxy probe",
      ...overrides[probeCase]
    }
  }));
}

function runEvidence(matrix, overrides = {}) {
  return spawnSync(process.execPath, [evidencePath, "assemble"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MATRIX_LOGS_JSON: JSON.stringify(matrix),
      PROBE_TOKEN_FOR_LEAK_CHECK: "a".repeat(64),
      GEN1_REVISION: "shipmastr-api-staging-gen1",
      GEN2_REVISION: "shipmastr-api-staging-gen2",
      ...overrides
    }
  });
}

test("assembler emits ten events and five exact matches", () => {
  const result = runEvidence({ gen1: cloudEntries(), gen2: cloudEntries() });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.events.length, 10);
  assert.deepEqual(evidence.events.map(({ generation }) => generation), [
    "gen1", "gen1", "gen1", "gen1", "gen1",
    "gen2", "gen2", "gen2", "gen2", "gen2"
  ]);
  assert.equal(evidence.comparison.exactMatch, true);
  assert.deepEqual(evidence.comparison.cases, cases.map((probeCase) => ({ probeCase, equal: true })));
});

test("assembler retains both generations when one structural field differs", () => {
  const result = runEvidence({
    gen1: cloudEntries(),
    gen2: cloudEntries({ "xff-ipv4": { xForwardedForElementCount: 2 } })
  });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.events.length, 10);
  assert.equal(evidence.comparison.exactMatch, false);
  assert.deepEqual(
    evidence.comparison.cases.filter(({ equal }) => !equal),
    [{ probeCase: "xff-ipv4", equal: false }]
  );
});

test("assembler rejects invalid counts, cases, keys, and sensitive material", () => {
  const valid = cloudEntries();
  const mutations = [
    { gen1: valid.slice(0, 4), gen2: valid },
    { gen1: valid, gen2: valid.map((entry, index) => index === 4
      ? { jsonPayload: { ...entry.jsonPayload, probeCase: "baseline" } }
      : entry) },
    { gen1: valid, gen2: valid.map((entry, index) => index === 0
      ? { jsonPayload: { ...entry.jsonPayload, unexpected: true } }
      : entry) },
    { gen1: valid, gen2: valid.map((entry, index) => index === 0
      ? { ...entry, httpRequest: { remoteIp: "192.0.2.99" } }
      : entry) },
    { gen1: valid, gen2: valid.map((entry, index) => index === 0
      ? { jsonPayload: { ...entry.jsonPayload, msg: `token ${"a".repeat(64)}` } }
      : entry) }
  ];
  for (const matrix of mutations) {
    const result = runEvidence(matrix);
    assert.equal(result.stdout, "");
    assert.notEqual(result.status, 0);
  }
});

test("assembler rejects sensitive wrapper fields outside the two generation logs", () => {
  const valid = { gen1: cloudEntries(), gen2: cloudEntries() };
  const mutations = [
    { ...valid, rawHeaders: { "x-forwarded-for": "192.0.2.99" } },
    { ...valid, metadata: `token ${"a".repeat(64)}` },
    { ...valid, origin: "2001:db8::1" }
  ];
  for (const matrix of mutations) {
    const result = runEvidence(matrix);
    assert.equal(result.stdout, "");
    assert.notEqual(result.status, 0);
  }
});

test("assembler rejects prohibited fields and URL values nested under allowed wrappers", () => {
  const valid = cloudEntries();
  const nestedSensitiveMaterial = [
    ["labels", { body: "raw request payload" }],
    ["labels", { authorizationHeader: "redacted material" }],
    ["labels", { cookieValue: "redacted material" }],
    ["resource", { requestHeaders: { accept: "application/json" } }],
    ["resource", { xForwardedForHeader: "redacted material" }],
    ["operation", { probeToken: "different-token-material" }],
    ["resource", { requestUrl: "https://example.com/private" }],
    ["resource", { requestUri: "/private/path" }],
    ["operation", { requestBody: "raw request payload" }],
    ["operation", { responseSignature: "deadbeef" }],
    ["labels", { serviceCredential: "private credential" }],
    ["labels", { apiKey: "redacted material" }],
    ["labels", { databasePassword: "redacted material" }],
    ["labels", { privateKey: "redacted material" }],
    ["labels", { environmentVariables: ["PRIVATE_KEY=value"] }],
    ["operation", { "x-shipmastr-intake-signature": "deadbeef" }],
    ["labels", { credentials: "private credential" }],
    ["labels", { envList: ["PRIVATE_KEY=value"] }],
    ["labels", { note: "https://example.com/private" }]
  ];
  for (const [wrapperKey, wrapperValue] of nestedSensitiveMaterial) {
    const result = runEvidence({
      gen1: valid.map((entry, index) => index === 0
        ? { ...entry, [wrapperKey]: wrapperValue }
        : entry),
      gen2: valid
    });
    assert.equal(result.stdout, "");
    assert.notEqual(result.status, 0);
  }
});

test("assembler rejects URL and URI semantic tokens anywhere in composite wrapper keys", () => {
  const valid = cloudEntries();
  const fields = [
    ["uriMetadata", "relative-path"],
    ["requestUriValue", "/private/path"],
    ["sourceURLText", "relative-path"],
    ["request_uri_value", "relative-path"],
    ["REQUEST-URI-VALUE", "relative-path"],
    ["canonical_url", "relative-path"],
    ["requesturivalue", "relative-path"],
    ["sourceurltext", "relative-path"]
  ];
  for (const [field, value] of fields) {
    const result = runEvidence({
      gen1: valid.map((entry, index) => index === 0
        ? { ...entry, labels: { [field]: value } }
        : entry),
      gen2: valid
    });
    assert.equal(result.stdout, "", field);
    assert.notEqual(result.status, 0, field);
  }
});

test("assembler rejects IP and address semantic tokens anywhere in composite wrapper keys", () => {
  const valid = cloudEntries();
  const fields = [
    "ipMetadata",
    "clientIpText",
    "sourceIPAddressText",
    "client_ip_text",
    "remoteAddressValue",
    "REMOTE-ADDRESS-VALUE",
    "candidate_address",
    "clientiptext",
    "remoteaddressvalue",
    "sourceipaddresstext",
    "candidateaddress"
  ];
  for (const field of fields) {
    const result = runEvidence({
      gen1: valid.map((entry, index) => index === 0
        ? { ...entry, labels: { [field]: "redacted-text" } }
        : entry),
      gen2: valid
    });
    assert.equal(result.stdout, "", field);
    assert.notEqual(result.status, 0, field);
  }
});

test("assembler accepts benign wrapper names with incidental sensitive-looking substrings", () => {
  const valid = cloudEntries();
  const result = runEvidence({
    gen1: valid.map((entry, index) => index === 0
      ? {
          ...entry,
          labels: {
            description: "ordinary metadata",
            securityLevel: "standard",
            curlVersion: "8",
            scriptVersion: "one",
            addressableState: "ready"
          }
        }
      : entry),
    gen2: valid
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).events.length, 10);
});

test("assembler accepts ordinary safe Cloud Logging wrapper metadata", () => {
  const valid = cloudEntries();
  const result = runEvidence({
    gen1: valid.map((entry, index) => index === 0
      ? {
          ...entry,
          labels: { safeCategory: "probe" },
          resource: {
            type: "cloud_run_revision",
            labels: {
              project_id: "shipmastr-core-prod",
              service_name: "shipmastr-api-staging",
              revision_name: "shipmastr-api-staging-gen1",
              location: "asia-south1"
            }
          },
          operation: { id: "operation-1", producer: "cloud-run", first: true, last: true },
          sourceLocation: { file: "logger.js", line: "10", function: "emitProbe" }
        }
      : entry),
    gen2: valid
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).events.length, 10);
});
