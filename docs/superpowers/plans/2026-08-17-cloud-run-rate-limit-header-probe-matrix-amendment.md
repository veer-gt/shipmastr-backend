# Cloud Run Rate-Limit Header Probe Matrix Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocked single-runtime Cloud Run probe with an isolated Gen1/40 versus Gen2/40 staging matrix that captures ten privacy-preserving structural events, proves or rejects generation-independent behavior, and leaves Courier Audit Intake disabled.

**Architecture:** Keep the existing application instrumentation unchanged. Extend the pure Node parser layer for live-runtime recording, production concurrency enforcement, revision ownership, and production fingerprints; move Cloud Logging projection into a testable evidence module; then make the Bash 3.2-compatible runner build once and orchestrate two explicitly pinned, zero-traffic tagged revisions on the existing staging service. Cleanup independently proves ownership of both tags, removes only this run's token/tags, preserves the original 100%-traffic revision, and retains valid matrix evidence even when Gen1 and Gen2 differ.

**Tech Stack:** Node.js 24, ECMAScript modules, Node's built-in test runner, Bash 3.2, Google Cloud Build, Artifact Registry, Cloud Run, Cloud Logging, `gcloud`, `curl`, and OpenSSL.

## Global Constraints

- Repository: `veer-gt/shipmastr-backend`.
- Branch: `hotfix/rate-limit-proxy-probe`; approved design anchor: `5af6f2f7efa372ac2ef0ca696a8870dd6505dc5e`.
- Original production feature base: `a965f4314d7af02dc45c05733efaea322acb87eb`.
- Worktree on the operator Mac: `/Users/mac/shipmastr-backend-rate-limit-proxy-probe`.
- GCP project: `shipmastr-core-prod`; region: `asia-south1`.
- Diagnostic service: `shipmastr-api-staging`; production service `shipmastr-api` is read-only.
- Shipmastr has no load balancer in this request path.
- The original active staging revision keeps exactly 100% ordinary traffic; its current concurrency may remain `80`.
- Diagnostic cells are exactly Gen1/concurrency `40` and Gen2/concurrency `40`, built from one immutable image digest.
- Both diagnostic deploys use `--no-traffic`, unique run-owned tags, one ephemeral 64-hex token, and `COURIER_AUDIT_INTAKE_ENABLED=false`.
- Production active concurrency must remain exactly `40`; staging and production execution environment may be recorded as `unspecified` but must never be guessed.
- Production must have zero direct Cloud Run domain mappings.
- No migration, database write, Secret Manager mutation, signing-secret change, n8n execution, Gmail call, external-AI call, notification, outbound communication, protected-domain mutation, or production mutation.
- No raw address, forwarding-header value, probe token, signature, authorization value, cookie, body, URL, credential, or environment list may enter diagnostic evidence.
- Cleanup preserves the original active staging revision and its 100% traffic allocation but does not attempt byte-identical service-template restoration; the token-removal revision may remain the latest created zero-traffic revision.
- Do not suppress `ERR_ERL_FORWARDED_HEADER`, implement a limiter correction, enable Courier Audit Intake, open a mergeable PR, or merge this branch.
- Valid matrix evidence is retained on an exact Gen1/Gen2 mismatch; interpretation and enablement still stop.
- Every implementation task uses RED, GREEN, a focused commit, spec-compliance review, and code-quality review before the next task.

---

## File Map

- Modify `scripts/rate-limit-proxy-probe-parsers.mjs`: validate the live runtime shape, require production concurrency `40`, fingerprint production read-only state, and prove tag/revision ownership including generation and concurrency.
- Modify `scripts/rate-limit-proxy-probe.test.mjs`: cover parser contracts, actual runner self-test execution, source ordering, two-cell deployment flags, cleanup ownership, and forbidden behavior.
- Create `scripts/rate-limit-proxy-probe-evidence.mjs`: validate two Cloud Logging result sets, project exactly ten structural events, compare the five case pairs, and emit privacy-safe evidence.
- Create `scripts/rate-limit-proxy-probe-evidence.test.mjs`: cover exact equality, retained mismatch evidence, count/case/key rejection, and sensitive-material rejection.
- Modify `scripts/rate-limit-proxy-probe.sh`: add the Bash self-test, replace the parity gate, create one run identity and two tags, deploy/measure both cells, assemble matrix evidence, and clean up both cells independently.
- Modify `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`: append implementation, verification, review, operator execution, and teardown evidence.
- Create at execution time `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json`: ten structural events plus five equality results; never raw Cloud Logging envelopes.
- Create at execution time `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-context.json`: immutable lineage, digest, two revision identities, recorded live runtime state, matrix result, and containment booleans.
- Create after successful evidence validation `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-report.md`: interpretation under the original approved rules and the next design gate.

### Task 1: Replace runtime parity with fail-closed matrix contracts

**Files:**
- Modify: `scripts/rate-limit-proxy-probe-parsers.mjs`
- Modify: `scripts/rate-limit-proxy-probe.test.mjs`

**Interfaces:**
- Consumes: six live runtime fields from the staging template, active staging revision, and active production revision; full production service JSON; service/tag JSON; revision JSON.
- Produces: CLI commands `matrix-preflight`, `production-fingerprint`, `tag-state`, and `owned-tag`. `matrix-preflight` emits one normalized JSON object; `production-fingerprint` emits one lowercase SHA-256 line; `owned-tag` requires exact revision, digest, generation, and concurrency and emits `owned`.

- [ ] **Step 1: Write failing tests for the observed live runtime and production guard**

Replace the old runtime-parity test with these cases in `scripts/rate-limit-proxy-probe.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Write failing production-fingerprint and extended ownership tests**

Use fixtures containing no credential values:

```javascript
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
```

Change `revisionJson` to accept one object:

```javascript
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
```

Update every existing caller from `revisionJson(containers)` to `revisionJson({ containers })`, and add `EXPECTED_EXECUTION_ENVIRONMENT: "gen1"` plus `EXPECTED_CONTAINER_CONCURRENCY: "40"` to every existing `owned-tag` fixture that is intended to reach image/revision validation. This preserves the meaning of the older foreign/missing/ambiguous ownership tests under the extended contract.

- [ ] **Step 3: Run the parser tests and verify RED**

```bash
node --test scripts/rate-limit-proxy-probe.test.mjs
```

Expected: failures identify the unknown `matrix-preflight` and `production-fingerprint` commands and the missing generation/concurrency ownership checks. No cloud command runs.

- [ ] **Step 4: Implement the minimal pure parser contracts**

Add Node's hash import and these helpers to `scripts/rate-limit-proxy-probe-parsers.mjs`:

```javascript
import { createHash } from "node:crypto";

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
```

Extend `ownedTag()` with exact generation/concurrency checks:

```javascript
const expectedGeneration = requiredText("EXPECTED_EXECUTION_ENVIRONMENT");
const expectedConcurrency = positiveInteger(requiredText("EXPECTED_CONTAINER_CONCURRENCY"));
if (expectedGeneration !== "gen1" && expectedGeneration !== "gen2") fail(2);
if (
  revision?.metadata?.annotations?.["run.googleapis.com/execution-environment"] !== expectedGeneration ||
  revision?.spec?.containerConcurrency !== expectedConcurrency
) fail(5);
```

Route the two new commands and remove the `runtime-parity` branch. Keep `tag-state` unchanged.

The fingerprint includes service-level annotations and labels because Cloud Run's V1 service API exposes them as independently modifiable metadata, and `run.googleapis.com/ingress` is specifically a service annotation: <https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.services> and <https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.services/replaceService>.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
node --test scripts/rate-limit-proxy-probe.test.mjs
git diff --check
git add scripts/rate-limit-proxy-probe-parsers.mjs scripts/rate-limit-proxy-probe.test.mjs
git commit -m "test: define proxy probe matrix contracts"
```

Expected: every script test passes; the commit changes only the parser and its test.

### Task 2: Extract and test the ten-event matrix evidence assembler

**Files:**
- Create: `scripts/rate-limit-proxy-probe-evidence.mjs`
- Create: `scripts/rate-limit-proxy-probe-evidence.test.mjs`

**Interfaces:**
- Consumes: `MATRIX_LOGS_JSON` shaped as `{gen1: CloudLoggingEnvelope[], gen2: CloudLoggingEnvelope[]}`, `PROBE_TOKEN_FOR_LEAK_CHECK`, `GEN1_REVISION`, and `GEN2_REVISION`.
- Produces: JSON shaped as `{schemaVersion: 1, events: MatrixEvent[10], comparison: {exactMatch: boolean, cases: CaseComparison[5]}}`; `MatrixEvent` is `{generation: "gen1" | "gen2", revision: string, event: StructuralEvent}` and `CaseComparison` is `{probeCase: string, equal: boolean}`. A valid structural mismatch exits `0` with `exactMatch:false`; malformed or sensitive input exits nonzero without output.

- [ ] **Step 1: Write failing equality and mismatch-retention tests**

Create fixtures from the existing 13 structural keys:

```javascript
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
```

The test helper must spawn the actual module:

```javascript
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
```

- [ ] **Step 2: Add failing rejection tests**

Cover these exact invalid inputs, each requiring nonzero status and empty stdout:

```javascript
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
```

- [ ] **Step 3: Run the evidence tests and verify RED**

```bash
node --test scripts/rate-limit-proxy-probe-evidence.test.mjs
```

Expected: failure because `scripts/rate-limit-proxy-probe-evidence.mjs` does not exist.

- [ ] **Step 4: Implement the evidence module by extracting the existing validator**

Move the existing runner's `structuralKeys`, `ordinaryPayloadKeys`, `ordinaryEnvelopeKeys`, `nullableCount`, `nullablePosition`, `forbiddenKeys`, `containsIpAddress`, and `containsSensitiveMaterial` definitions into `scripts/rate-limit-proxy-probe-evidence.mjs`. Change the last helper's signature to `containsSensitiveMaterial(value, probeToken)` and pass the same token through every recursive call. Preserve the current per-entry type, allowed-key, case-order, path, enum, count, position, boolean, IP, and token-leak checks exactly. This input proves only that the ephemeral token is absent from captured logs/evidence; revision scoping establishes log provenance.

Add these exact matrix functions around that validator:

```javascript
const expectedCases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];

function requiredRevision(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !/^shipmastr-api-staging-[a-z0-9-]+$/u.test(value)) process.exit(2);
  return value;
}

function projectGeneration(entries, probeToken) {
  if (!Array.isArray(entries) || entries.length !== 5) process.exit(3);
  if (containsSensitiveMaterial(entries, probeToken)) process.exit(4);
  return entries.map((entry, index) => projectValidatedEntry(entry, expectedCases[index]));
}

function assemble() {
  const matrix = JSON.parse(process.env.MATRIX_LOGS_JSON ?? "");
  const token = process.env.PROBE_TOKEN_FOR_LEAK_CHECK ?? "";
  if (!/^[0-9a-f]{64}$/u.test(token) || matrix === null || typeof matrix !== "object") process.exit(2);
  const projected = {
    gen1: projectGeneration(matrix.gen1, token),
    gen2: projectGeneration(matrix.gen2, token)
  };
  const events = [
    ...projected.gen1.map((event) => ({ generation: "gen1", revision: requiredRevision("GEN1_REVISION"), event })),
    ...projected.gen2.map((event) => ({ generation: "gen2", revision: requiredRevision("GEN2_REVISION"), event }))
  ];
  const cases = expectedCases.map((probeCase, index) => ({
    probeCase,
    equal: JSON.stringify(projected.gen1[index]) === JSON.stringify(projected.gen2[index])
  }));
  const result = {
    schemaVersion: 1,
    events,
    comparison: { exactMatch: cases.every(({ equal }) => equal), cases }
  };
  if (containsSensitiveMaterial(result, token)) process.exit(5);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[2] === "assemble") assemble();
else process.exit(64);
```

`projectValidatedEntry(entry, expectedCase)` must return `Object.fromEntries(structuralKeys.map((key) => [key, payload[key]]))` only after all existing validations pass. It must never return an envelope or ordinary Pino field.

- [ ] **Step 5: Run GREEN tests and commit**

```bash
node --test scripts/rate-limit-proxy-probe-evidence.test.mjs
git diff --check
git add scripts/rate-limit-proxy-probe-evidence.mjs scripts/rate-limit-proxy-probe-evidence.test.mjs
git commit -m "test: add proxy probe matrix evidence assembler"
```

Expected: equality, mismatch retention, and every rejection case pass without cloud access.

### Task 3: Add the actual Bash self-test and matrix-safe preflight

**Files:**
- Modify: `scripts/rate-limit-proxy-probe.sh`
- Modify: `scripts/rate-limit-proxy-probe.test.mjs`

**Interfaces:**
- Consumes: Task 1's `matrix-preflight` and `production-fingerprint` commands.
- Produces: `scripts/rate-limit-proxy-probe.sh --bash32-self-test`, normalized `LIVE_RUNTIME_STATE_JSON`, `PRODUCTION_FINGERPRINT_BEFORE`, a UTC/source/nonce `RUN_ID`, and two tags ending `-g1` and `-g2`. The self-test prints exactly `RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK` and exits before any external preflight.

- [ ] **Step 1: Write failing actual-runner and source-order tests**

Add:

```javascript
test("actual runner self-test exercises array and two-cell bookkeeping", () => {
  const result = spawnSync("bash", [runnerPath, "--bash32-self-test"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK\n");
  assert.equal(result.stderr, "");
});

test("runner uses a lowercase-safe numeric UTC timestamp for run-owned tags", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /RUN_TIMESTAMP="\$\(date -u \+%Y%m%d%H%M%S\)"/u);
  assert.doesNotMatch(source, /RUN_TIMESTAMP="\$\(date -u \+%Y%m%dT%H%M%SZ\)"/u);
});

test("self-test and all read-only gates precede token build and deploy", () => {
  const source = readFileSync(runnerPath, "utf8");
  const selfTest = source.indexOf("--bash32-self-test");
  const commandPreflight = source.indexOf("for required_command");
  const matrixPreflight = source.indexOf('node "$PARSER" matrix-preflight');
  const domainMapping = source.indexOf("domain-mappings list");
  const token = source.indexOf('PROBE_TOKEN="$(openssl rand -hex 32)"');
  const build = source.indexOf("gcloud builds submit");
  assert.ok(selfTest >= 0 && selfTest < commandPreflight);
  assert.ok(matrixPreflight > commandPreflight && matrixPreflight < token);
  assert.ok(domainMapping > matrixPreflight && domainMapping < token);
  assert.ok(token < build);
  assert.equal(source.includes('node "$PARSER" runtime-parity'), false);
});
```

Keep the existing `mapfile|readarray` absence test.

- [ ] **Step 2: Run the runner tests and verify RED**

```bash
node --test scripts/rate-limit-proxy-probe.test.mjs
```

Expected: the self-test returns nonzero because the current runner enters repository/gcloud preflight, and source-order assertions fail on the old parity command.

- [ ] **Step 3: Implement a shared Bash 3.2-safe field reader and early self-test**

Insert immediately after `set -Eeuo pipefail`, before constants or command checks:

```bash
read_fields() {
  local input="$1"
  local field=""
  READ_FIELDS=()
  while IFS= read -r field; do
    READ_FIELDS[${#READ_FIELDS[@]}]="$field"
  done <<EOF
$input
EOF
}

create_run_identity() {
  local timestamp="$1"
  local commit_prefix="$2"
  local nonce="$3"
  RUN_ID="$timestamp-$commit_prefix-$nonce"
  TAG_G1="rlp-$RUN_ID-g1"
  TAG_G2="rlp-$RUN_ID-g2"
  [[ "$RUN_ID" =~ ^[0-9]{14}-[0-9a-f]{12}-[0-9a-f]{12}$ ]]
  [[ "$TAG_G1" =~ ^rlp-[0-9a-z-]+-g1$ && "${#TAG_G1}" -le 63 ]]
  [[ "$TAG_G2" =~ ^rlp-[0-9a-z-]+-g2$ && "${#TAG_G2}" -le 63 ]]
  test "$TAG_G1" != "$TAG_G2"
}

bash32_self_test() {
  local matrix_text="gen1
40
gen2
40"
  local generations=()
  local concurrencies=()
  read_fields "$matrix_text"
  test "${#READ_FIELDS[@]}" -eq 4
  generations[0]="${READ_FIELDS[0]}"
  concurrencies[0]="${READ_FIELDS[1]}"
  generations[1]="${READ_FIELDS[2]}"
  concurrencies[1]="${READ_FIELDS[3]}"
  test "${generations[0]}:${concurrencies[0]}" = "gen1:40"
  test "${generations[1]}:${concurrencies[1]}" = "gen2:40"
  create_run_identity \
    "$(date -u +%Y%m%d%H%M%S)" \
    "$(git rev-parse --short=12 HEAD)" \
    "001122334455"
  printf '%s\n' 'RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK'
}

if [[ "${1:-}" == "--bash32-self-test" ]]; then
  test "$#" -eq 1
  bash32_self_test
  exit 0
fi
test "$#" -eq 0
```

Use `read_fields` for every multiline Node output currently decoded by repeated `while read` blocks so the actual production path and self-test exercise the same array mechanism. The self-test also calls the same `create_run_identity` function with the real `date` and `git rev-parse` outputs, so an uppercase or otherwise malformed timestamp fails before any cloud action.

- [ ] **Step 4: Replace parity with normalized runtime state and production fingerprint**

Call Task 1's command with the existing six variables:

```bash
LIVE_RUNTIME_STATE_JSON="$(
  STAGING_TEMPLATE_EXECUTION_ENVIRONMENT="$STAGING_TEMPLATE_EXECUTION_ENVIRONMENT" \
  STAGING_TEMPLATE_CONTAINER_CONCURRENCY="$STAGING_TEMPLATE_CONTAINER_CONCURRENCY" \
  STAGING_ACTIVE_EXECUTION_ENVIRONMENT="$STAGING_ACTIVE_EXECUTION_ENVIRONMENT" \
  STAGING_ACTIVE_CONTAINER_CONCURRENCY="$STAGING_ACTIVE_CONTAINER_CONCURRENCY" \
  PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT="$PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT" \
  PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY="$PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY" \
  node "$PARSER" matrix-preflight
)"
node -e 'const state=JSON.parse(process.argv[1]); if(state.productionActive.concurrency!==40) process.exit(2)' \
  "$LIVE_RUNTIME_STATE_JSON"

PRODUCTION_FINGERPRINT_BEFORE="$(
  SERVICE_JSON="$PRODUCTION_SERVICE_JSON" node "$PARSER" production-fingerprint
)"
[[ "$PRODUCTION_FINGERPRINT_BEFORE" =~ ^[0-9a-f]{64}$ ]]
```

Keep the zero-domain-mapping check after this and before token generation.

- [ ] **Step 5: Create one run identity and two collision-checked tags**

After every read-only preflight passes:

```bash
PROBE_TOKEN="$(openssl rand -hex 32)"
RUN_NONCE="$(openssl rand -hex 6)"
RUN_TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
[[ "$PROBE_TOKEN" =~ ^[0-9a-f]{64}$ ]]
create_run_identity \
  "$RUN_TIMESTAMP" \
  "$(git rev-parse --short=12 HEAD)" \
  "$RUN_NONCE"
```

Initialize independent state before the cleanup trap is installed:

```bash
MATRIX_GENERATIONS=("gen1" "gen2")
MATRIX_TAGS=("$TAG_G1" "$TAG_G2")
MATRIX_REVISIONS=("" "")
MATRIX_URLS=("" "")
IMAGE_REF=""
EVIDENCE_CAPTURED=0
CLEANUP_DONE=0
```

- [ ] **Step 6: Run GREEN tests, syntax-check, and commit**

```bash
bash -n scripts/rate-limit-proxy-probe.sh
bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
node --test scripts/rate-limit-proxy-probe.test.mjs
git diff --check
git add scripts/rate-limit-proxy-probe.sh scripts/rate-limit-proxy-probe.test.mjs
git commit -m "test: gate proxy probe matrix preflight"
```

Expected: the self-test emits its one fixed line; no gcloud/network/build command runs; script tests pass.

### Task 4: Orchestrate two no-traffic revisions and independent cleanup

**Files:**
- Modify: `scripts/rate-limit-proxy-probe.sh`
- Modify: `scripts/rate-limit-proxy-probe.test.mjs`

**Interfaces:**
- Consumes: Task 1 ownership/fingerprint commands, Task 2 evidence CLI, and Task 3's run state.
- Produces: one build, two explicitly pinned deployments, ten controlled requests/log events, matrix/context files, and independent cleanup of two owned tags plus the owned token. No ordinary traffic or production mutation occurs.

- [ ] **Step 1: Write failing source-contract tests for the two-cell runner**

Add assertions that inspect the actual script:

```javascript
test("runner builds once and deploys explicit Gen1 and Gen2 cells at concurrency 40", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.equal((source.match(/gcloud builds submit/gu) ?? []).length, 1);
  assert.match(source, /deploy_matrix_cell\s+"gen1"\s+"\$TAG_G1"/u);
  assert.match(source, /deploy_matrix_cell\s+"gen2"\s+"\$TAG_G2"/u);
  assert.match(source, /--execution-environment="\$generation"/u);
  assert.match(source, /--concurrency=40/u);
  assert.match(source, /--no-traffic/u);
  assert.match(source, /COURIER_AUDIT_INTAKE_ENABLED=false/u);
});

test("cleanup treats both run-owned cells independently and fingerprints production", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /cleanup_owned_tag\s+"\$TAG_G1"\s+"\$\{MATRIX_REVISIONS\[0\]\}"\s+"gen1"/u);
  assert.match(source, /cleanup_owned_tag\s+"\$TAG_G2"\s+"\$\{MATRIX_REVISIONS\[1\]\}"\s+"gen2"/u);
  assert.match(source, /PRODUCTION_FINGERPRINT_AFTER/u);
  assert.match(source, /test "\$PRODUCTION_FINGERPRINT_AFTER" = "\$PRODUCTION_FINGERPRINT_BEFORE"/u);
  assert.equal(/gcloud run (?:deploy|services update|services update-traffic) "?\$PRODUCTION_SERVICE/u.test(source), false);
});

test("valid matrix mismatch is retained but blocks success", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /EVIDENCE_CAPTURED=1/u);
  assert.match(source, /MATRIX_EXACT_MATCH/u);
  assert.match(source, /test "\$MATRIX_EXACT_MATCH" = "true"/u);
});
```

- [ ] **Step 2: Run the script tests and verify RED**

```bash
node --test scripts/rate-limit-proxy-probe.test.mjs
```

Expected: new source-contract tests fail because the current runner has one tag and one unpinned deploy.

- [ ] **Step 3: Install cleanup before the build and validate each tag independently**

Replace the one-tag cleanup with:

```bash
cleanup_owned_tag() {
  local tag="$1"
  local expected_revision="$2"
  local expected_generation="$3"
  local service_json=""
  local tag_target=""
  local revision_json=""

  service_json="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json)" || return 1
  tag_target="$(SERVICE_JSON="$service_json" TAG_TO_FIND="$tag" node "$PARSER" tag-state)" || return 1
  if [[ "$tag_target" == "absent" ]]; then return 0; fi
  if [[ -z "$expected_revision" || -z "$IMAGE_REF" || "$tag_target" != "$expected_revision" ]]; then return 1; fi
  revision_json="$(gcloud run revisions describe "$expected_revision" \
    --project="$PROJECT" --region="$REGION" --format=json)" || return 1
  SERVICE_JSON="$service_json" \
  REVISION_JSON="$revision_json" \
  TAG_TO_FIND="$tag" \
  EXPECTED_REVISION="$expected_revision" \
  EXPECTED_IMAGE_REF="$IMAGE_REF" \
  EXPECTED_EXECUTION_ENVIRONMENT="$expected_generation" \
  EXPECTED_CONTAINER_CONCURRENCY="40" \
  node "$PARSER" owned-tag >/dev/null || return 1
  gcloud run services update-traffic "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --remove-tags="$tag" --quiet
}
```

The cleanup body must call both cells regardless of the first result:

```bash
cleanup_owned_tag "$TAG_G1" "${MATRIX_REVISIONS[0]}" "gen1" || cleanup_failed=1
cleanup_owned_tag "$TAG_G2" "${MATRIX_REVISIONS[1]}" "gen2" || cleanup_failed=1
```

Keep the current exact-token ownership check before `--remove-env-vars`. After tag/token removal, require both `tag-state` calls to emit `absent`, require the original revision to be the sole 100%-traffic entry, and require the intake flag to be absent or `false`.

Re-read production and compare the fingerprint:

```bash
PRODUCTION_SERVICE_JSON_AFTER="$(gcloud run services describe "$PRODUCTION_SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)" || cleanup_failed=1
if [[ -n "$PRODUCTION_SERVICE_JSON_AFTER" ]]; then
  PRODUCTION_FINGERPRINT_AFTER="$(
    SERVICE_JSON="$PRODUCTION_SERVICE_JSON_AFTER" node "$PARSER" production-fingerprint
  )" || cleanup_failed=1
  test "$PRODUCTION_FINGERPRINT_AFTER" = "$PRODUCTION_FINGERPRINT_BEFORE" || cleanup_failed=1
fi
```

Install `EXIT`, `INT`, and `TERM` traps immediately before `gcloud builds submit`. Preserve incoming nonzero status and upgrade only a successful result when cleanup fails.

- [ ] **Step 4: Build once and deploy one verified matrix cell at a time**

Create a Bash function:

```bash
deploy_matrix_cell() {
  local generation="$1"
  local tag="$2"
  local deployed_service_json=""
  local binding_output=""
  local revision_json=""

  gcloud run deploy "$SERVICE" \
    --project="$PROJECT" \
    --region="$REGION" \
    --image="$IMAGE_REF" \
    --execution-environment="$generation" \
    --concurrency=40 \
    --update-env-vars="COURIER_AUDIT_INTAKE_ENABLED=false,RATE_LIMIT_PROXY_PROBE_TOKEN=$PROBE_TOKEN" \
    --no-traffic \
    --tag="$tag" \
    --quiet

  deployed_service_json="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json)"
  binding_output="$(SERVICE_JSON="$deployed_service_json" TAG_TO_VERIFY="$tag" \
    ORIGINAL_REVISION_TO_VERIFY="$ORIGINAL_REVISION" node --input-type=module -e "$TAG_BINDING_VALIDATOR")"
  read_fields "$binding_output"
  test "${#READ_FIELDS[@]}" -eq 2
  DEPLOYED_TAG_REVISION="${READ_FIELDS[0]}"
  DEPLOYED_TAG_URL="${READ_FIELDS[1]}"
  revision_json="$(gcloud run revisions describe "$DEPLOYED_TAG_REVISION" \
    --project="$PROJECT" --region="$REGION" --format=json)"
  SERVICE_JSON="$deployed_service_json" REVISION_JSON="$revision_json" \
    TAG_TO_FIND="$tag" EXPECTED_REVISION="$DEPLOYED_TAG_REVISION" \
    EXPECTED_IMAGE_REF="$IMAGE_REF" EXPECTED_EXECUTION_ENVIRONMENT="$generation" \
    EXPECTED_CONTAINER_CONCURRENCY="40" node "$PARSER" owned-tag >/dev/null
}
```

Store the existing tag-binding Node validator in the quoted constant `TAG_BINDING_VALIDATOR`; retain its exact checks for one tag, zero tagged normal traffic, and the original revision at 100%.

Build once, resolve the digest once, then call:

```bash
deploy_matrix_cell "gen1" "$TAG_G1"
MATRIX_REVISIONS[0]="$DEPLOYED_TAG_REVISION"
MATRIX_URLS[0]="$DEPLOYED_TAG_URL"
run_five_cases "${MATRIX_URLS[0]}"

deploy_matrix_cell "gen2" "$TAG_G2"
MATRIX_REVISIONS[1]="$DEPLOYED_TAG_REVISION"
MATRIX_URLS[1]="$DEPLOYED_TAG_URL"
run_five_cases "${MATRIX_URLS[1]}"
```

`run_five_cases(tag_url)` must contain the current five `curl` requests unchanged except for using its function argument. Every request still targets `/api/health`, carries the token/case headers, uses the existing distinct RFC documentation markers, and requires HTTP `200`.

- [ ] **Step 5: Capture two log sets without persisting raw envelopes and assemble evidence**

Read only each recorded revision into shell variables:

```bash
GEN1_LOGS_JSON="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"${MATRIX_REVISIONS[0]}\" AND jsonPayload.eventName=\"rate_limit_proxy_probe\"" \
  --project="$PROJECT" --freshness=30m --order=asc --limit=20 --format=json)"
GEN2_LOGS_JSON="$(gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"${MATRIX_REVISIONS[1]}\" AND jsonPayload.eventName=\"rate_limit_proxy_probe\"" \
  --project="$PROJECT" --freshness=30m --order=asc --limit=20 --format=json)"
MATRIX_LOGS_JSON="$(GEN1_LOGS_JSON="$GEN1_LOGS_JSON" GEN2_LOGS_JSON="$GEN2_LOGS_JSON" \
  node --input-type=module -e 'process.stdout.write(JSON.stringify({gen1:JSON.parse(process.env.GEN1_LOGS_JSON),gen2:JSON.parse(process.env.GEN2_LOGS_JSON)}))')"
MATRIX_LOGS_JSON="$MATRIX_LOGS_JSON" \
PROBE_TOKEN_FOR_LEAK_CHECK="$PROBE_TOKEN" \
GEN1_REVISION="${MATRIX_REVISIONS[0]}" \
GEN2_REVISION="${MATRIX_REVISIONS[1]}" \
node scripts/rate-limit-proxy-probe-evidence.mjs assemble > "$EVIDENCE_TMP"
mv "$EVIDENCE_TMP" "$EVIDENCE_DIR/probe-results.json"
EVIDENCE_CAPTURED=1
unset GEN1_LOGS_JSON GEN2_LOGS_JSON MATRIX_LOGS_JSON
```

Extract the result only from projected evidence:

```bash
MATRIX_EXACT_MATCH="$(node -e '
  const evidence=require(process.argv[1]);
  if (typeof evidence?.comparison?.exactMatch!=="boolean") process.exit(2);
  process.stdout.write(String(evidence.comparison.exactMatch));
' "$(pwd)/$EVIDENCE_DIR/probe-results.json")"
```

Generate `probe-context.json` from safe scalar inputs only. It must include `sourceHead`, `testedHead`, `imageDigest`, `originalStagingRevision`, `liveRuntime` parsed from `LIVE_RUNTIME_STATE_JSON`, `matrix` with concurrency `40`, both exact generation/revision pairs and `exactMatch`, `productionDomainMappingCount:0`, `productionFingerprintBefore`, `activeTrafficUnchanged:true`, `featureDisabled:true`, and `productionMutated:false`. Reject URLs and the existing sensitive field-name regex before writing. The context records only the SHA-256 fingerprint, never production annotations, labels, spec, or environment material.

If `EVIDENCE_CAPTURED=1`, cleanup preserves both final JSON files regardless of matrix equality. After cleanup, require:

```bash
test "$MATRIX_EXACT_MATCH" = "true"
```

Thus a valid mismatch exits nonzero after retaining evidence and completing teardown.

- [ ] **Step 6: Run GREEN tests, syntax-check, and commit**

```bash
bash -n scripts/rate-limit-proxy-probe.sh
bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
node --test scripts/rate-limit-proxy-probe.test.mjs scripts/rate-limit-proxy-probe-evidence.test.mjs
git diff --check
git add scripts/rate-limit-proxy-probe.sh scripts/rate-limit-proxy-probe.test.mjs
git commit -m "chore: automate two-runtime Cloud Run proxy probe"
```

Expected: all local tests pass; no cloud command has run.

### Task 5: Verify and independently review before any cloud action

**Files:**
- Modify: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: Tasks 1–4 commits.
- Produces: exact tested head, full-suite evidence, boundary audit, two-stage independent review, and an explicit push-approval gate.

- [ ] **Step 1: Verify lineage and run the complete focused batch**

```bash
git merge-base --is-ancestor 5af6f2f7efa372ac2ef0ca696a8870dd6505dc5e HEAD
test "$(git branch --show-current)" = "hotfix/rate-limit-proxy-probe"
test -z "$(git status --porcelain)"
git diff --check
bash -n scripts/rate-limit-proxy-probe.sh
test "$(bash scripts/rate-limit-proxy-probe.sh --bash32-self-test)" = \
  "RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK"
npm run build
node --test \
  dist/config/rate-limit-proxy-probe-env.test.js \
  dist/lib/logger.test.js \
  dist/middleware/rate-limit-proxy-probe.test.js \
  dist/modules/courierAuditIntake/courier-audit-intake.routes.test.js \
  dist/server.middleware-order.test.js \
  scripts/rate-limit-proxy-probe.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs
```

Expected: build and every focused test pass. Restore generated tracked `dist`/`node_modules` paths after recording results; no generated artifact enters a commit.

- [ ] **Step 2: Run the approved synthetic full-suite process**

```bash
FULL_REPORT="/tmp/shipmastr-rate-limit-proxy-probe-matrix-full-suite-$(date -u +%Y%m%dT%H%M%SZ).log"
set -o pipefail
env \
  NODE_ENV=test \
  APP_ENV=test \
  DATABASE_URL='postgresql://synthetic:synthetic@127.0.0.1:1/shipmastr_synthetic' \
  JWT_SECRET='synthetic-test-only-jwt-secret-000000000000000000000000000001' \
  APP_SECRET_PEPPER='synthetic-test-only-app-pepper-0000000000000000000000000001' \
  WEBHOOK_SECRET='synthetic-test-only-webhook-secret-00000000000000000000000001' \
  npm test 2>&1 | tee "$FULL_REPORT"
FULL_STATUS=$?
set +o pipefail
grep -n -E '^ℹ tests |^ℹ suites |^ℹ pass |^ℹ fail |^ℹ skipped ' "$FULL_REPORT"
```

Exit `0` is accepted. A nonzero result is accepted only for exactly the two already approved topology-only ENOENT failures:

```text
../seller-panel/src/pages/MerchantSetupCrudPage.jsx
../docs/n8n/shipmastr-domains-mock-provisioning.workflow.json
```

and exactly three skips. Any additional failure, changed path/signature, missing baseline evidence, or arithmetic mismatch blocks execution.

- [ ] **Step 3: Run the privacy and containment audit**

```bash
! rg -n '\b(mapfile|readarray)\b' scripts/rate-limit-proxy-probe.sh
! rg -n 'forwardedHeader:\s*false|xForwardedForHeader:\s*false|validate:\s*false' src scripts
rg -n -- '--no-traffic|--execution-environment="\$generation"|--concurrency=40|COURIER_AUDIT_INTAKE_ENABLED=false' \
  scripts/rate-limit-proxy-probe.sh
! rg -n 'gcloud run (deploy|services update|services update-traffic).*PRODUCTION_SERVICE' \
  scripts/rate-limit-proxy-probe.sh
git diff a965f4314d7af02dc45c05733efaea322acb87eb...HEAD -- \
  prisma src/modules/courierAuditIntake/courier-audit-intake.service.ts
git diff --check
```

Inspect both evidence validator and runner to confirm raw Cloud Logging envelopes never reach a file, the token is never printed, and only structural fields enter `probe-results.json`.

- [ ] **Step 4: Obtain two-stage independent review**

The spec-compliance reviewer checks every requirement in the approved matrix design, including exact two-cell isolation, live-state recording, production concurrency/domain/fingerprint gates, run-specific ownership, valid mismatch retention, cleanup on success/failure/`INT`/`TERM`, actual self-test path, and the post-evidence stop gate.

After spec compliance passes, the code-quality reviewer checks parser failure modes, Bash 3.2 semantics, quote/word-splitting safety, cleanup status preservation, no ambiguous deletion, evidence privacy, test quality, and the absence of application/limiter changes. Any Critical or Important finding is fixed with a fresh RED→GREEN cycle and both reviews repeat.

- [ ] **Step 5: Record and commit verification, then stop for push approval**

Append exact commits, command outputs, test totals, accepted exceptions, audit results, and review verdicts to `progress.md`, then:

```bash
git add .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md
git commit -m "docs: verify proxy probe runtime matrix"
TESTED_HEAD="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
printf 'APPROVE PUSH hotfix/rate-limit-proxy-probe at %s to veer-gt/shipmastr-backend\n' "$TESTED_HEAD"
```

Do not push until the user approves that exact SHA. Do not open a PR.

### Task 6: Execute the two-runtime probe on the operator Mac

**Files:**
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json`
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-context.json`
- Modify: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: explicitly approved and transferred tested head, macOS `/bin/bash` 3.2, authenticated read/write staging operator access, and read-only production access.
- Produces: ten structural events, five case comparisons, a matrix verdict, immutable terminal log, and independently verified teardown.

- [ ] **Step 1: Prove the actual scripts run under macOS Bash 3.2 before cloud action**

```bash
cd /Users/mac/shipmastr-backend-rate-limit-proxy-probe
test "$(git branch --show-current)" = "hotfix/rate-limit-proxy-probe"
test "$(git rev-parse HEAD)" = "$APPROVED_TESTED_HEAD"
test -z "$(git status --porcelain)"
test "$(/bin/bash -c 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"')" = "3.2"
/bin/bash -n scripts/rate-limit-proxy-probe.sh
test "$(/bin/bash scripts/rate-limit-proxy-probe.sh --bash32-self-test)" = \
  "RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK"
```

Set `APPROVED_TESTED_HEAD` to the exact SHA the user approved. Any mismatch stops before gcloud, token generation, build, or deploy.

- [ ] **Step 2: Run one small command and retain the terminal log**

```bash
REPORT="/tmp/shipmastr-rate-limit-proxy-probe-matrix-$(date -u +%Y%m%dT%H%M%SZ).log"
set -o pipefail
/bin/bash scripts/rate-limit-proxy-probe.sh 2>&1 | tee "$REPORT"
STATUS=$?
set +o pipefail
echo "probe_exit=$STATUS"
echo "report=$REPORT"
```

An exit `0` requires exact five-of-five matrix equality and successful cleanup. A nonzero matrix-mismatch result is informative only if both final JSON evidence files exist and cleanup independently passes; every other nonzero result is a failed execution requiring diagnosis before reuse.

- [ ] **Step 3: Independently verify teardown with read-only commands**

```bash
PROJECT="shipmastr-core-prod"
REGION="asia-south1"
SERVICE="shipmastr-api-staging"
gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --format='yaml(status.traffic,spec.template.spec.containers[0].env)'
PRODUCTION_SERVICE_JSON_AFTER="$(gcloud run services describe shipmastr-api \
  --project="$PROJECT" --region="$REGION" --format=json)"
PRODUCTION_FINGERPRINT_AFTER="$(SERVICE_JSON="$PRODUCTION_SERVICE_JSON_AFTER" \
  node scripts/rate-limit-proxy-probe-parsers.mjs production-fingerprint)"
PRODUCTION_FINGERPRINT_BEFORE="$(node -e '
  const context=require("./.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-context.json");
  if(!/^[0-9a-f]{64}$/.test(context.productionFingerprintBefore??"")) process.exit(2);
  process.stdout.write(context.productionFingerprintBefore);
')"
test "$PRODUCTION_FINGERPRINT_AFTER" = "$PRODUCTION_FINGERPRINT_BEFORE"
unset PRODUCTION_SERVICE_JSON_AFTER
```

Require one original staging revision at 100% ordinary traffic, no `rlp-` tags, no probe token, intake absent or `false`, and an exact production fingerprint match. Because the fingerprint includes canonicalized service annotations and labels—including the Cloud Run ingress annotation—this check detects annotation/label-only changes without printing their values. POST `{}` to the normal staging Courier Audit Intake route and require `404`.

- [ ] **Step 4: Validate evidence locally without displaying sensitive inputs**

```bash
node -e '
  const evidence=require("./.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json");
  if(evidence.events.length!==10||evidence.comparison.cases.length!==5) process.exit(2);
  console.log(JSON.stringify(evidence.comparison));
'
shasum -a 256 \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-context.json
```

Record only projected evidence, hashes, revisions, digest, runtime labels, matrix verdict, and teardown booleans in `progress.md`. Never attach the raw terminal log if it contains a token or raw Cloud Logging envelope.

- [ ] **Step 5: Commit the independently verified safe evidence**

Append the operator command status, report path, tested head, digest, both revision names, both JSON hashes, comparison booleans, and teardown checks to `progress.md`. Then commit only projected evidence and the ledger:

```bash
git add \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-context.json \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md
git diff --cached --check
git commit -m "docs: record Cloud Run runtime matrix evidence"
EVIDENCE_HEAD="$(git rev-parse HEAD)"
printf 'APPROVE PUSH hotfix/rate-limit-proxy-probe evidence at %s to veer-gt/shipmastr-backend\n' \
  "$EVIDENCE_HEAD"
```

Do not push the evidence commit without approval for that exact SHA.

- [ ] **Step 6: Apply the mismatch gate**

If any comparison is false, keep the feature disabled, retain the safe evidence, and stop. A later separately approved design must either pin production to one explicit generation through normal deployment or introduce a production-safe runtime fingerprint/probe; neither is authorized here.

If all five comparisons are true, proceed only to Task 7 interpretation. Do not implement or deploy a limiter fix.

### Task 7: Interpret evidence and stop before the limiter hotfix

**Files:**
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-report.md`
- Modify: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: exact ten-event evidence, exact five comparison results, context hashes, and verified cleanup.
- Produces: independently reviewed generation-independent classification or an explicit mismatch block; no code fix or enablement.

- [ ] **Step 1: Write the report from projected fields only**

Include:

- exact tested head, image digest, Gen1 revision, Gen2 revision, and both evidence SHA-256 values;
- one structural row per case with separate Gen1 and Gen2 values;
- exact equality verdict for each case;
- recorded staging-template, active-staging, and active-production runtime states without inferring an unspecified generation;
- `Forwarded`, `X-Forwarded-For`, and current limiter classifications using the original design's rules only when all five pairs match;
- production read-only fingerprint result, original active staging revision at 100%, tag/token removal, and feature-disabled proof;
- explicit statement that no limiter correction, feature enablement, production deployment, migration, or n8n/Gmail processing occurred.

- [ ] **Step 2: Independently review evidence and interpretation**

The reviewer recomputes all five equality comparisons from `probe-results.json`, verifies there are exactly ten structural events and no sensitive fields, checks context/evidence hashes, confirms teardown, and challenges each trust inference against the original decision rules. Any ambiguity blocks classification and keeps the feature disabled.

- [ ] **Step 3: Commit safe evidence and stop**

```bash
git add \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-report.md \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md
git diff --cached --check
git commit -m "docs: classify Cloud Run runtime matrix evidence"
```

Request separate approval before pushing this evidence commit. Stop without a PR, limiter hotfix, feature enablement, or production action.

## Self-Review Result

- Spec coverage: the observed unspecified generations and 80/40 concurrency split, explicit Gen1/40 and Gen2/40 matrix, five cases per cell, same digest/token, production read-only fingerprint, zero domain mappings, run-specific ownership, independent cleanup, valid mismatch retention, Bash 3.2 execution, reviews, and final stop gate each map to a task.
- Contract consistency: `matrix-preflight`, `production-fingerprint`, `owned-tag`, `assemble`, `LIVE_RUNTIME_STATE_JSON`, `MATRIX_REVISIONS`, `MATRIX_EXACT_MATCH`, and the evidence JSON shapes have one definition and the same spelling across producers and consumers.
- Scope: only diagnostic scripts, script tests, and append-only evidence documents change. Application instrumentation, Courier Audit Intake, Prisma, n8n, Secret Manager, limiter behavior, and production remain untouched.
