# Cloud Run Probe Evidence Schema Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the diagnostic probe's semantic denylist with a complete fail-closed Cloud Logging schema, bind every entry to its generation-specific revision and immutable label map, and retain only label-map hashes/counts in final artifacts.

**Architecture:** A new side-effect-free schema module owns canonical JSON, expected-label-map validation, full recursive `LogEntry` validation, and safe metadata derivation. The evidence assembler validates both generations before projection; the parser exposes revision-label extraction to the Bash 3.2 runner; the runner keeps raw maps only in memory, passes them independently to the assembler, and publishes only SHA-256/count summaries after verified cleanup.

**Tech Stack:** Node.js ESM, `node:test`, Node `crypto`, Bash 3.2, fake `gcloud`/`curl` process boundaries, Cloud Run LogEntry JSON

## Global Constraints

- Work only on `hotfix/rate-limit-proxy-probe`, anchored at approved design commit `e27153451128780311c56f0a6c95b1bd9b95b942`.
- The branch is diagnostic-only and must never merge to `main`.
- Use test-driven development: capture the specified genuine RED before each production edit.
- No new runtime dependency; use Node built-ins only.
- Keep `scripts/rate-limit-proxy-probe.sh` compatible with macOS Bash 3.2; do not use `mapfile`, `readarray`, associative arrays, namerefs, or Bash 4 syntax.
- Do not run any real cloud, network, deployment, migration, feature-enablement, Gmail/n8n, notification, outbound-communication, production-mutation, or push command.
- Courier Audit Intake remains disabled; all fake mutation assertions remain staging-only.
- The assembler must reject before projection, exit nonzero, emit empty stdout, and never echo rejected keys or values.
- Raw LogEntries and raw expected-label maps are ephemeral and must not appear in `probe-results.json`, `probe-context.json`, console output, reports, or committed fixtures containing real infrastructure values.
- `labels.instanceId` maximum 256 characters is a safety margin over Google's observed 145-character example, not a documented platform ceiling.
- Gen1 evidence is checked only against `GEN1_REVISION` plus `GEN1_EXPECTED_LOG_LABELS_JSON`; Gen2 uses only the corresponding Gen2 inputs.
- Do not push, deploy, run the real probe, enable the feature, modify production, or merge after implementation. Stop at exact-head verification and review.

---

## File map

- Create `scripts/rate-limit-proxy-probe-evidence-schema.mjs`: pure canonicalization, label-map parsing/metadata, and complete recursive LogEntry validators shared by the parser and assembler.
- Create `scripts/rate-limit-proxy-probe-evidence-schema.test.mjs`: focused unit coverage for every schema type, bound, nested allowlist, identity rule, and expected-label-map constraint.
- Modify `scripts/rate-limit-proxy-probe-evidence.mjs`: remove semantic-key trust logic, enforce raw-size/input validation, invoke the full schema before structural projection, and preserve defense-in-depth value/output scanning.
- Modify `scripts/rate-limit-proxy-probe-evidence.test.mjs`: replace minimal wrappers with canonical full LogEntry fixtures and exercise real-process empty-stdout failures.
- Modify `scripts/rate-limit-proxy-probe-parsers.mjs`: add the `revision-log-labels` command backed by the shared schema module.
- Modify `scripts/rate-limit-proxy-probe.sh`: capture per-generation immutable labels, pass raw maps only to the assembler, record hash/count only in final context, and clear ephemeral values on every cleanup path.
- Modify `scripts/rate-limit-proxy-probe-runner-fixture.mjs`: copy the shared module, return revision labels, emit canonical full LogEntries, and expose published result/context content to behavioral tests.
- Modify `scripts/rate-limit-proxy-probe.test.mjs`: cover parser output, per-generation propagation, artifact minimization, cleanup/lifecycle behavior, Bash 3.2 compatibility, and staging-only containment.
- Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/schema-hardening-task-1-report.md`: Task 1 RED/GREEN/review evidence.
- Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/schema-hardening-task-2-report.md`: Task 2 RED/GREEN/lifecycle review evidence.
- Create `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/schema-hardening-final-report.md`: exact-head verification, privacy audit, retained constraints, and stop-gate handoff.

---

### Task 1: Full LogEntry schema and fail-closed evidence assembler

**Files:**
- Create: `scripts/rate-limit-proxy-probe-evidence-schema.mjs`
- Create: `scripts/rate-limit-proxy-probe-evidence-schema.test.mjs`
- Modify: `scripts/rate-limit-proxy-probe-evidence.mjs`
- Modify: `scripts/rate-limit-proxy-probe-evidence.test.mjs`
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/schema-hardening-task-1-report.md`

**Interfaces:**
- Produces: `canonicalizeJson(value: JsonValue): string` with recursively sorted object keys and stable array order.
- Produces: `parseExpectedLogLabels(raw: string): { value: Record<string,string>, canonicalJson: string, sha256: string, count: number }`; invalid JSON, non-plain objects, more than 64 entries, invalid key/value type or length, ASCII control characters, or canonical UTF-8 size above 16,384 bytes throw `ProbeSchemaError`.
- Produces: `expectedLogLabelMetadata(labels: Record<string,string>): { value: Readonly<Record<string,string>>, canonicalJson: string, sha256: string, count: number }`, applying the same validation and returning a caller-independent validated copy.
- Produces: `validateLogEntry(entry: unknown, options: { expectedCase: string, expectedRevision: string, expectedLabels: Record<string,string>, probeToken: string }): Readonly<Record<string,unknown>>`; returns the validated 13-field projection only after the complete entry passes.
- Produces: `ProbeSchemaError` with fixed `code` values only; its message must not contain rejected keys or values.
- Consumes: existing five-case order and 13 structural fields from `scripts/rate-limit-proxy-probe-evidence.mjs`.
- Preserves: CLI contract `node scripts/rate-limit-proxy-probe-evidence.mjs assemble`, schema version 1, ten projected events, and exact comparison output.

- [ ] **Step 1: Replace minimal fixtures with a canonical complete LogEntry builder and add schema RED tests**

In `scripts/rate-limit-proxy-probe-evidence.test.mjs`, define generation-aware helpers with synthetic-only values:

```js
const revisions = {
  gen1: "shipmastr-api-staging-gen1",
  gen2: "shipmastr-api-staging-gen2"
};
const configuredLabels = {
  gen1: { environment: "diagnostic", generation: "one" },
  gen2: { environment: "diagnostic", generation: "two" }
};

function fullLogEntry(generation, probeCase, overrides = {}) {
  const entry = {
    insertId: `${generation}-${probeCase}`,
    jsonPayload: {
      ...structuralEvent(probeCase),
      hostname: "probe-host",
      level: 30,
      msg: "rate limit proxy probe",
      pid: 42,
      time: 1_787_000_000_000
    },
    labels: {
      instanceId: "a".repeat(145),
      environment: "diagnostic",
      generation: generation === "gen1" ? "one" : "two"
    },
    logName: "projects/shipmastr-core-prod/logs/run.googleapis.com%2Fstdout",
    receiveTimestamp: "2026-08-17T06:00:00.123456789Z",
    resource: {
      type: "cloud_run_revision",
      labels: {
        project_id: "shipmastr-core-prod",
        service_name: "shipmastr-api-staging",
        configuration_name: "shipmastr-api-staging",
        location: "asia-south1",
        revision_name: revisions[generation]
      }
    },
    severity: "INFO",
    timestamp: "2026-08-17T06:00:00Z"
  };
  return deepMergeForTest(entry, overrides);
}
```

Update `runEvidence` to set both raw canonical maps:

```js
GEN1_EXPECTED_LOG_LABELS_JSON: JSON.stringify(configuredLabels.gen1),
GEN2_EXPECTED_LOG_LABELS_JSON: JSON.stringify(configuredLabels.gen2)
```

Add table-driven real-process tests that mutate exactly one field per run and assert `result.stdout === ""` plus `result.status !== 0` for:

- missing each of the eight required envelope keys;
- every explicitly rejected key: `httpRequest`, `metadata`, `split`, `errorGroups`, `apphub`, `apphubDestination`, `apphubSource`, `otel`, `protoPayload`, `textPayload`;
- arbitrary top-level `futureLoggingField`;
- extra keys inside `resource`, `resource.labels`, `operation`, `sourceLocation`, and `jsonPayload`;
- wrong types for every required/optional scalar and object;
- `insertId` lengths 0/257 and ASCII control input;
- timestamp/receiveTimestamp malformed, too short, too long, invalid calendar/time, and valid `Z`, offset, and 1–9 fractional-digit forms;
- wrong log name, severity, trace prefix/hex length/case, span length/case, and non-Boolean `traceSampled`;
- resource wrong/missing/extra labels and wrong project/service/configuration/location/revision;
- a Gen1 entry carrying the Gen2 revision and the inverse;
- `instanceId` missing, non-hex, length 0, and length 257;
- configured-label substituted value and unexpected label key;
- `operation` empty, invalid key, invalid booleans, and string lengths 0/257/control;
- `sourceLocation` empty, invalid key, invalid line forms (`-1`, number, decimal overflow), and string lengths 0/513/control;
- each optional Pino key at wrong type/value/bound, including invalid hostname, `level !== 30`, `pid` 0/2,147,483,648, and `time` -1/`Number.MAX_SAFE_INTEGER + 1`;
- raw `MATRIX_LOGS_JSON` UTF-8 byte sizes below 2 and above 262,144;
- invalid expected-label-map JSON/object/type/count/key/value/control/16,384-byte canonical limits;
- the probe token, URL, IPv4, IPv6, `Forwarded:`, `X-Forwarded-For:`, and `for=` inside an otherwise allowed string;
- sensitive material in the final projection, proving the output scan remains active.

Add positive cases for:

- the full canonical envelope for both generations;
- `instanceId` length 145 and 256;
- expected configured labels present with exact values and absent from an entry;
- optional `operation`, `sourceLocation`, `spanId`, `trace`, and `traceSampled` at their bounds;
- all five optional Pino keys present and all absent;
- configured-label maps with zero and 64 entries, 128-code-point keys, 256-code-point values, and canonical serialized size exactly 16,384 bytes;
- a legitimate structural mismatch that emits all ten events but marks one comparison false.

- [ ] **Step 2: Add pure schema-module RED tests**

Create `scripts/rate-limit-proxy-probe-evidence-schema.test.mjs` importing the not-yet-created module and asserting exact interface behavior:

```js
import {
  ProbeSchemaError,
  canonicalizeJson,
  expectedLogLabelMetadata,
  parseExpectedLogLabels,
  validateLogEntry
} from "./rate-limit-proxy-probe-evidence-schema.mjs";

test("canonical label metadata is stable across input key order", () => {
  const left = expectedLogLabelMetadata({ z: "last", a: "first" });
  const right = expectedLogLabelMetadata({ a: "first", z: "last" });
  assert.deepEqual(left, right);
  assert.equal(left.canonicalJson, '{"a":"first","z":"last"}');
  assert.equal(left.count, 2);
  assert.match(left.sha256, /^[0-9a-f]{64}$/u);
});

test("schema errors expose only fixed codes", () => {
  assert.throws(
    () => validateLogEntry({ secretUnexpectedField: "do-not-echo" }, validOptions),
    (error) => error instanceof ProbeSchemaError &&
      /^[A-Z0-9_]+$/u.test(error.code) &&
      !JSON.stringify(error).includes("secretUnexpectedField") &&
      !JSON.stringify(error).includes("do-not-echo")
  );
});
```

Also verify `parseExpectedLogLabels` returns a frozen or caller-independent validated value: mutating the original parsed input after metadata creation must not change `canonicalJson`, `sha256`, or `count`.

- [ ] **Step 3: Run the schema and assembler tests to capture genuine RED**

Run:

```bash
node --test \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs
```

Expected: FAIL because `rate-limit-proxy-probe-evidence-schema.mjs` does not exist and the current assembler accepts/rejects the old partial-wrapper contract instead of the approved complete schema. Record failing test names and statuses in `schema-hardening-task-1-report.md`; do not edit production files before this RED.

- [ ] **Step 4: Implement the shared schema primitives**

Create `scripts/rate-limit-proxy-probe-evidence-schema.mjs` with these constants and validation structure:

```js
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export class ProbeSchemaError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeSchemaError";
    this.code = code;
  }
}

const fail = (code) => { throw new ProbeSchemaError(code); };
const isPlainObject = (value) => value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const codePointLength = (value) => [...value].length;
const hasAsciiControl = (value) => /[\u0000-\u001f\u007f]/u.test(value);
const utf8Length = (value) => Buffer.byteLength(value, "utf8");

export function canonicalizeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
```

Implement `exactKeys(object, required, optional, code)` so it rejects non-plain objects, missing required keys, and every key outside the fixed sets. It must never include the encountered key in an error.

Implement bounded string/integer/Boolean helpers using Unicode code-point counts, ASCII-control rejection, `Number.isSafeInteger`, and exact literals. Implement RFC 3339 with the explicit syntax:

```js
/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u
```

After regex validation, require `Number.isFinite(Date.parse(value))` and total ASCII length 20–35.

Implement expected-label-map validation and metadata:

```js
export function expectedLogLabelMetadata(labels) {
  validateExpectedLabelsObject(labels);
  const canonicalJson = canonicalizeJson(labels);
  if (utf8Length(canonicalJson) > 16_384) fail("EXPECTED_LABELS_SIZE");
  return Object.freeze({
    value: Object.freeze({ ...labels }),
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"),
    count: Object.keys(labels).length
  });
}

export function parseExpectedLogLabels(raw) {
  if (typeof raw !== "string" || raw.length === 0) fail("EXPECTED_LABELS_INPUT");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail("EXPECTED_LABELS_JSON"); }
  return expectedLogLabelMetadata(parsed);
}
```

Use the returned `value` as the caller-independent validated map passed to `validateLogEntry`.

- [ ] **Step 5: Implement complete recursive LogEntry validation**

In the schema module, implement `validateLogEntry` in this order:

```js
export function validateLogEntry(entry, options) {
  validateOptions(options);
  exactKeys(entry, requiredEnvelopeKeys, optionalEnvelopeKeys, "ENTRY_KEYS");
  validateEnvelopeScalars(entry);
  validateResource(entry.resource, options.expectedRevision);
  validateEntryLabels(entry.labels, options.expectedLabels);
  validateOperation(entry.operation);
  validateSourceLocation(entry.sourceLocation);
  validatePayload(entry.jsonPayload, options.expectedCase);
  if (containsSensitiveValue(entry, options.probeToken)) fail("SENSITIVE_VALUE");
  const projection = Object.freeze(Object.fromEntries(
    structuralKeys.map((key) => [key, entry.jsonPayload[key]])
  ));
  if (containsSensitiveValue(projection, options.probeToken)) fail("SENSITIVE_OUTPUT");
  return projection;
}
```

Use exact accepted envelope sets from the design. Explicit rejects require no special branch because default deny handles them, but tests must name all ten known fields. Apply the exact resource literals and generation-specific `expectedRevision`. For entry labels, require `instanceId` matching `/^[0-9a-f]{1,256}$/u`; every other actual key must be an own key of `expectedLabels` with an exactly equal string value; do not require expected keys to appear.

The defense-in-depth value scan traverses only schema-valid values and retains the existing token/URL/header/IP detection. Delete the semantic-key token/context machinery (`forbiddenSemanticKeyTokens`, `normalizedSemanticContextTokens`, `forbiddenNormalizedKeys`, `semanticKeyTokens`, `containsForbiddenNormalizedSemanticSequence`, and `forbiddenKey`) from the assembler; unknown keys are now rejected by schema.

- [ ] **Step 6: Refactor the assembler to validate inputs and delegate entry validation**

In `scripts/rate-limit-proxy-probe-evidence.mjs`:

1. Import `parseExpectedLogLabels`, `ProbeSchemaError`, and `validateLogEntry`.
2. Check `Buffer.byteLength(rawMatrix, "utf8")` is 2–262,144 before `JSON.parse`.
3. Parse JSON inside `try/catch`; malformed input exits with a fixed status and empty stdout.
4. Validate token and both revisions before validating either generation.
5. Parse Gen1 and Gen2 label maps independently from the required environment variables.
6. Validate exactly two matrix keys, exact five-entry arrays, and fixed case order.
7. Call `validateLogEntry` per entry with the matching revision and validated label map.
8. Construct the existing schema-version/events/comparison output only after both arrays validate.
9. Catch `ProbeSchemaError` and JSON failures at the CLI boundary, set a fixed nonzero status, and write nothing to stdout/stderr.

Use a fixed CLI boundary:

```js
try {
  if (process.argv[2] !== "assemble") process.exitCode = 64;
  else assemble();
} catch (error) {
  process.exitCode = error instanceof ProbeSchemaError ? 4 : 2;
}
```

Do not log `error`, `error.message`, raw inputs, or rejected data.

- [ ] **Step 7: Run Task 1 GREEN and privacy checks**

Run:

```bash
node --check scripts/rate-limit-proxy-probe-evidence-schema.mjs
node --check scripts/rate-limit-proxy-probe-evidence.mjs
node --test \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs
rg -n 'forbiddenSemanticKeyTokens|normalizedSemanticContextTokens|forbiddenNormalizedKeys|semanticKeyTokens|containsForbiddenNormalizedSemanticSequence|forbiddenKey' \
  scripts/rate-limit-proxy-probe-evidence*.mjs
```

Expected: both syntax checks pass; all schema/assembler tests pass; `rg` exits 1 with no matches, demonstrating the semantic denylist is removed rather than expanded.

Run the real assembler against a generated invalid envelope whose unknown key and value are unique sentinel strings. Expected: nonzero status, zero stdout bytes, zero stderr bytes, and neither sentinel appears anywhere in captured output. Record exact commands/counts in the Task 1 report.

- [ ] **Step 8: Self-review Task 1 and commit**

Review the diff against the approved design section by section. Confirm every accepted nested object has exact required/optional key sets and explicit value bounds; the entry is validated before projection; Gen1/Gen2 options never cross; and no raw label map enters the result.

Run:

```bash
git diff --check
git status --short
```

Write `schema-hardening-task-1-report.md` with the RED output, GREEN commands/results, privacy sentinel result, files changed, and retained stop gate. Then commit only Task 1 source/tests:

```bash
git add \
  scripts/rate-limit-proxy-probe-evidence-schema.mjs \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs
git diff --cached --check
git commit -m "fix: enforce strict probe evidence schema"
```

The `.superpowers/sdd` report is ignored evidence and must exist locally but must not be staged unless repository rules explicitly track it.

---

### Task 2: Immutable label capture, runner propagation, artifact minimization, and lifecycle coverage

**Files:**
- Modify: `scripts/rate-limit-proxy-probe-parsers.mjs`
- Modify: `scripts/rate-limit-proxy-probe.sh`
- Modify: `scripts/rate-limit-proxy-probe-runner-fixture.mjs`
- Modify: `scripts/rate-limit-proxy-probe.test.mjs`
- Test: `scripts/rate-limit-proxy-probe-evidence-schema.test.mjs`
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/schema-hardening-task-2-report.md`

**Interfaces:**
- Consumes: `expectedLogLabelMetadata(labels)` from Task 1.
- Produces parser command: `REVISION_JSON=<json> node scripts/rate-limit-proxy-probe-parsers.mjs revision-log-labels`.
- Parser stdout contract: exactly three newline-terminated fields in this order: canonical label JSON, lowercase SHA-256, decimal entry count.
- Produces Bash arrays: `MATRIX_EXPECTED_LOG_LABELS_JSON`, `MATRIX_EXPECTED_LOG_LABELS_SHA256`, `MATRIX_EXPECTED_LOG_LABEL_COUNTS`, indexed 0 for Gen1 and 1 for Gen2.
- Produces final context fields: `matrix.gen1.logLabelsSha256`, `matrix.gen1.logLabelsCount`, `matrix.gen2.logLabelsSha256`, and `matrix.gen2.logLabelsCount`.
- Preserves: existing ownership, no-traffic, cleanup, timeout, signal, lock, publication, and production-fingerprint behavior.

- [ ] **Step 1: Add parser and normal-runner RED tests**

In `scripts/rate-limit-proxy-probe.test.mjs`, extend `revisionJson` with synthetic `metadata.labels` and add parser tests:

```js
test("revision-log-labels emits canonical immutable metadata", () => {
  const result = runParser("revision-log-labels", {
    REVISION_JSON: revisionJson({ labels: { z: "last", a: "first" } })
  });
  assert.equal(result.status, 0, result.stderr);
  const [canonical, sha256, count, trailing] = result.stdout.split("\n");
  assert.equal(canonical, '{"a":"first","z":"last"}');
  assert.match(sha256, /^[0-9a-f]{64}$/u);
  assert.equal(count, "2");
  assert.equal(trailing, "");
});
```

Add negative parser tables for missing/non-object labels, 65 entries, invalid key/value types and bounds, control characters, and canonical size above 16,384 bytes. Each must have empty stdout and nonzero status.

Extend the successful fake-runner test to parse returned `run.result` and `run.context`, then assert:

```js
assert.equal(JSON.stringify(run.result).includes("diagnostic-generation-one"), false);
assert.equal(JSON.stringify(run.context).includes("diagnostic-generation-one"), false);
assert.match(run.context.matrix.gen1.logLabelsSha256, /^[0-9a-f]{64}$/u);
assert.equal(run.context.matrix.gen1.logLabelsCount, 2);
assert.match(run.context.matrix.gen2.logLabelsSha256, /^[0-9a-f]{64}$/u);
assert.equal(run.context.matrix.gen2.logLabelsCount, 2);
assert.notEqual(
  run.context.matrix.gen1.logLabelsSha256,
  run.context.matrix.gen2.logLabelsSha256
);
```

Add a fake scenario `log_label_mismatch` that changes a Gen2 log label after revision-label capture; expected runner outcome: nonzero, no published result/context, both exact staging tags removed, token removed, lock released only if reconciliation succeeds, and zero production mutation.

Add success/failure assertions that raw map variables are absent from final stdout/stderr and artifacts. Preserve all existing timeout, `SIGINT`, `SIGTERM`, late-signal, cleanup-failure, and partial-publication behavioral tests.

- [ ] **Step 2: Run parser/runner tests to capture genuine RED**

Run:

```bash
node --test scripts/rate-limit-proxy-probe.test.mjs
```

Expected: FAIL because `revision-log-labels` is not implemented, the fixture emits partial LogEntries, and context lacks label hashes/counts. Record the exact failing tests in `schema-hardening-task-2-report.md` before changing parser/runner code.

- [ ] **Step 3: Implement the parser command**

Import `expectedLogLabelMetadata` into `scripts/rate-limit-proxy-probe-parsers.mjs`. Add:

```js
function revisionLogLabels() {
  const revision = parseObject("REVISION_JSON");
  const labels = revision?.metadata?.labels;
  const metadata = expectedLogLabelMetadata(labels);
  process.stdout.write(
    `${metadata.canonicalJson}\n${metadata.sha256}\n${metadata.count}\n`
  );
}
```

Dispatch exact command `revision-log-labels`. Wrap its schema exception at the command boundary so invalid input exits a fixed nonzero code with empty stdout/stderr. Do not change the output contracts of `tag-state`, `owned-tag`, `matrix-preflight`, or `production-fingerprint`.

- [ ] **Step 4: Capture immutable label maps in `record_matrix_cell`**

Initialize Bash 3.2 indexed arrays beside the existing matrix arrays:

```bash
MATRIX_EXPECTED_LOG_LABELS_JSON=("" "")
MATRIX_EXPECTED_LOG_LABELS_SHA256=("" "")
MATRIX_EXPECTED_LOG_LABEL_COUNTS=("" "")
```

After `owned-tag` and deployed-env validation succeed, but before binding readiness and before any request, call the parser against the already-read `revision_json`:

```bash
label_metadata="$(
  REVISION_JSON="$revision_json" node "$PARSER" revision-log-labels
)" || return 1
read_fields "$label_metadata"
test "${#READ_FIELDS[@]}" -eq 3 || return 1
[[ "${READ_FIELDS[1]}" =~ ^[0-9a-f]{64}$ ]] || return 1
[[ "${READ_FIELDS[2]}" =~ ^(?:0|[1-9][0-9]*)$ ]] || return 1
MATRIX_EXPECTED_LOG_LABELS_JSON[$matrix_index]="${READ_FIELDS[0]}"
MATRIX_EXPECTED_LOG_LABELS_SHA256[$matrix_index]="${READ_FIELDS[1]}"
MATRIX_EXPECTED_LOG_LABEL_COUNTS[$matrix_index]="${READ_FIELDS[2]}"
```

Before setting `RECORDED_MATRIX_CELL=1`, require the three fields are nonempty/valid. On rediscovery, overwrite the same index only after exact ownership validates; do not combine generation maps.

- [ ] **Step 5: Pass maps to the assembler and retain only hashes/counts in context**

At assembly, add:

```bash
GEN1_EXPECTED_LOG_LABELS_JSON="${MATRIX_EXPECTED_LOG_LABELS_JSON[0]}" \
GEN2_EXPECTED_LOG_LABELS_JSON="${MATRIX_EXPECTED_LOG_LABELS_JSON[1]}" \
node scripts/rate-limit-proxy-probe-evidence.mjs assemble > "$EVIDENCE_TMP"
```

In `generate_probe_context`, pass per-generation hash/count variables, validate hashes as 64 lowercase hex and counts as integers 0–64, and emit:

```js
matrix: {
  concurrency: 40,
  gen1: {
    generation: "gen1",
    revision: gen1Revision,
    logLabelsSha256: gen1LogLabelsSha256,
    logLabelsCount: gen1LogLabelsCount
  },
  gen2: {
    generation: "gen2",
    revision: gen2Revision,
    logLabelsSha256: gen2LogLabelsSha256,
    logLabelsCount: gen2LogLabelsCount
  },
  exactMatch: matrixExactMatchText === "true"
}
```

Update both pre-publication and final context verifiers to require these exact fields and bounds. Assert no `expectedLabels`, `labelsJson`, `canonicalJson`, or raw map appears in serialized context/result.

- [ ] **Step 6: Clear ephemeral maps on every exit path**

Extend the existing cleanup unset line so it runs before context publication and on success, failure, timeout, `INT`, and `TERM`:

```bash
unset \
  PROBE_TOKEN \
  GEN1_LOGS_JSON GEN2_LOGS_JSON MATRIX_LOGS_JSON \
  GEN1_EXPECTED_LOG_LABELS_JSON GEN2_EXPECTED_LOG_LABELS_JSON
MATRIX_EXPECTED_LOG_LABELS_JSON=("" "")
```

Keep hash/count arrays until `generate_probe_context` finishes, then clear them after context verification or at final exit. Do not write raw maps to temporary files. Preserve existing cleanup return/signal arbitration and lock-retention rules.

- [ ] **Step 7: Upgrade the fake Cloud Run boundary to the complete schema**

Add `rate-limit-proxy-probe-evidence-schema.mjs` to `runnerFiles`. Give each fake cell immutable synthetic labels:

```js
labels: generation === "gen1"
  ? { environment: "diagnostic", matrixGeneration: "one" }
  : { environment: "diagnostic", matrixGeneration: "two" }
```

Return those labels under `revision(...).metadata.labels`. Make the logging-read branch resolve the revision from the filter argument and emit five full entries containing:

- required LogEntry envelope keys;
- exact five `cloud_run_revision` resource labels with the resolved revision;
- `labels.instanceId` plus that generation's configured labels;
- synthetic Pino metadata and structural payload;
- no IP, URL, token, raw header, credential, or environment dump.

For `log_label_mismatch`, substitute only the Gen2 entry label value after the captured revision map remains unchanged. Extend `runFakeProbe` return data:

```js
result: resultExists ? JSON.parse(readFileSync(resultPath, "utf8")) : undefined,
context: contextExists ? JSON.parse(readFileSync(contextPath, "utf8")) : undefined
```

Do not expose raw maps from fake state through runner stdout/stderr.

- [ ] **Step 8: Run Task 2 GREEN, Bash, and lifecycle gates**

Run:

```bash
bash -n scripts/rate-limit-proxy-probe.sh
/bin/bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
node --check scripts/rate-limit-proxy-probe-parsers.mjs
node --check scripts/rate-limit-proxy-probe-runner-fixture.mjs
node --test \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs \
  scripts/rate-limit-proxy-probe.test.mjs
```

Expected: Bash syntax passes, self-test prints exactly `RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK`, syntax checks pass, and all schema/assembler/parser/normal-runner tests pass. Confirm behavioral coverage includes success, label mismatch, late-tag timeout 124, unresolved timeout 124 with retained lock, ambiguous ownership, cleanup failure, cleanup timeout 124, `INT` 130, `TERM` 143, both late second-signal orders preserving first status, and partial-publication rollback.

Run:

```bash
rg -n 'MATRIX_EXPECTED_LOG_LABELS_JSON|GEN1_EXPECTED_LOG_LABELS_JSON|GEN2_EXPECTED_LOG_LABELS_JSON' \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-results.json \
  .superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/probe-context.json 2>/dev/null
```

Expected: no raw-map matches if artifacts exist from fixtures; the test suite must independently assert this rather than relying on this optional filesystem check.

- [ ] **Step 9: Self-review Task 2 and commit**

Verify capture occurs after exact ownership/env checks and before `run_five_cases`; distinct maps are passed to distinct generations; only hash/count reaches context; no production mutation is introduced; and cleanup clears ephemeral maps without changing status arbitration.

Run:

```bash
git diff --check
git status --short
```

Write `schema-hardening-task-2-report.md` with RED/GREEN output, all lifecycle statuses, containment assertions, and no-cloud statement. Commit only Task 2 source/tests:

```bash
git add \
  scripts/rate-limit-proxy-probe-parsers.mjs \
  scripts/rate-limit-proxy-probe.sh \
  scripts/rate-limit-proxy-probe-runner-fixture.mjs \
  scripts/rate-limit-proxy-probe.test.mjs
git diff --cached --check
git commit -m "fix: bind probe logs to revision labels"
```

---

### Task 3: Exact-head verification, privacy audit, and review gate

**Files:**
- Verify: all files changed by Tasks 1–2
- Create: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/schema-hardening-final-report.md`
- Modify: `.superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe/progress.md`

**Interfaces:**
- Consumes: completed Task 1 and Task 2 commits.
- Produces: a local exact-head report containing commands, exit statuses, test totals, privacy/containment results, changed-file inventory, and an explicit no-push/no-cloud stop gate.
- Produces no source commit unless review finds a defect; any defect starts a new focused RED→GREEN cycle and requires rerunning this entire task.

- [ ] **Step 1: Pin and inventory the exact head**

Run:

```bash
git branch --show-current
git rev-parse HEAD
git merge-base HEAD a965f4314d7af02dc45c05733efaea322acb87eb
git status --short
git diff --name-status a965f4314d7af02dc45c05733efaea322acb87eb..HEAD
git log --oneline --decorate a965f4314d7af02dc45c05733efaea322acb87eb..HEAD
```

Expected: branch is `hotfix/rate-limit-proxy-probe`; merge base is the approved Courier Audit Intake merge commit; working tree has no staged/source edits; diff contains only approved diagnostic source/tests/docs. Record exact head as `TESTED_HEAD` in the final report.

- [ ] **Step 2: Run the fresh focused verification gate**

Run:

```bash
npm run build
bash -n scripts/rate-limit-proxy-probe.sh
/bin/bash scripts/rate-limit-proxy-probe.sh --bash32-self-test
node --test \
  scripts/rate-limit-proxy-probe-evidence-schema.test.mjs \
  scripts/rate-limit-proxy-probe-evidence.test.mjs \
  scripts/rate-limit-proxy-probe.test.mjs \
  dist/config/env.test.js \
  dist/middleware/logger.test.js \
  dist/middleware/rate-limit-proxy-probe.test.js \
  dist/modules/courierAuditIntake/courier-audit-intake.routes.test.js \
  dist/server.middleware-order.test.js
```

Expected: build, Bash syntax/self-test, and all focused tests pass. Record each suite/test/pass/fail/skip/cancel total from the fresh output.

- [ ] **Step 3: Run the approved synthetic full suite without live services**

Run the exact synthetic environment process already approved for this branch:

```bash
env \
  NODE_ENV=test \
  APP_ENV=test \
  DATABASE_URL='postgresql://synthetic:synthetic@127.0.0.1:1/shipmastr_synthetic' \
  JWT_SECRET='synthetic-test-only-jwt-secret-000000000000000000000000000001' \
  APP_SECRET_PEPPER='synthetic-test-only-app-pepper-0000000000000000000000000001' \
  WEBHOOK_SECRET='synthetic-test-only-webhook-secret-00000000000000000000000001' \
  npm test
```

Expected accepted baseline: exactly the two previously identified missing-sibling-fixture ENOENT failures and three skips; every other test passes. If counts, names, paths, failure text, or skips differ, mark the final result BLOCKED. Do not relabel a new failure as unrelated.

- [ ] **Step 4: Restore generated build state and run privacy/containment audit**

Restore only tracked generated files changed by build/test using the repository's already-established safe restoration method; do not reset source edits. Then run:

```bash
git status --short
git diff --check
git diff -- prisma src/modules/courierAuditIntake
rg -n 'console\.(?:log|error|warn)|req\.headers|rawHeaders|authorization|cookie|DATABASE_URL|JWT_SECRET|APP_SECRET_PEPPER|WEBHOOK_SECRET' \
  scripts/rate-limit-proxy-probe-evidence-schema.mjs \
  scripts/rate-limit-proxy-probe-evidence.mjs \
  scripts/rate-limit-proxy-probe-parsers.mjs \
  scripts/rate-limit-proxy-probe.sh
rg -n 'gcloud run (?:deploy|services update|services update-traffic).*shipmastr-api(?:\s|$)' \
  scripts/rate-limit-proxy-probe.sh
```

Expected: no uncommitted source changes; no diff under Prisma or Courier Audit Intake; no secret/raw-header logging; every mutation command targets staging through the existing `$SERVICE`; no production deployment/update command; feature remains explicitly false and `--no-traffic` remains on diagnostic deploys.

Execute direct real-assembler negative probes for unknown top-level, nested unknown, explicit `httpRequest`, wrong resource revision, substituted configured label, 257-character `instanceId`, probe token, URL, IPv4, and IPv6. For every case record: nonzero status, stdout byte count 0, stderr byte count 0.

- [ ] **Step 5: Perform independent exact-head review**

Review the committed exact-head diff against:

- `docs/superpowers/specs/2026-08-17-cloud-run-probe-evidence-schema-hardening-design.md`;
- this plan;
- Google LogEntry schema assumptions copied into the design;
- all runner lifecycle and production-containment constraints.

Classify findings as Critical, Important, or Minor. A Critical or Important finding blocks handoff. For a fix, first add a focused failing test, implement the smallest correction, rerun Task 1/2 gates plus all of Task 3, commit, and review the new exact head. No cloud command is permitted during review.

- [ ] **Step 6: Write the final report and stop**

Create `schema-hardening-final-report.md` containing:

- exact branch/base/head;
- source commits and changed-file inventory;
- focused and synthetic test totals;
- accepted baseline failure names/paths or BLOCKED status;
- every direct privacy probe's status/stdout/stderr byte counts;
- raw label-map absence and hash/count presence;
- Bash 3.2, lifecycle, staging-only, disabled-feature, no-production-mutation, no-cloud, and no-push evidence;
- review findings and verdict;
- the statement: `Implementation completion does not authorize cloud execution, push, deployment, feature enablement, limiter correction, production action, or merge.`

Append a concise entry to `progress.md` referencing the final report and exact tested head. Finish with:

```bash
git status --short
git diff --check
git log -3 --oneline
```

Expected: clean source tree aside from ignored reports/progress behavior established by the repository; no push or cloud action. Return the tested head and report path for separate explicit approval.
