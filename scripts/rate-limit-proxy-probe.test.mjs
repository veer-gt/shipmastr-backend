import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runFakeProbe } from "./rate-limit-proxy-probe-runner-fixture.mjs";

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
  concurrency = 40,
  labels = { environment: "diagnostic", matrixGeneration: "one" }
} = {}) {
  return JSON.stringify({
    metadata: {
      name,
      labels,
      annotations: { "run.googleapis.com/execution-environment": generation }
    },
    spec: { containers, containerConcurrency: concurrency }
  });
}

test("runner remains compatible with macOS Bash 3.2 array parsing", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.equal(/\b(?:mapfile|readarray)\b/u.test(source), false);
});

test("every gcloud boundary is routed through the portable deadline supervisor", () => {
  const source = readFileSync(runnerPath, "utf8");
  const gcloudBoundaryLines = source.split("\n").filter((line) =>
    /\bgcloud\b/u.test(line) && !line.includes("for required_command")
  );
  assert.equal(gcloudBoundaryLines.length, 5);
  for (const line of gcloudBoundaryLines) assert.match(line, /^\s+run_command_/u);
  assert.doesNotMatch(source, /command -v (?:g?timeout)\b/u);
});

test("Cloud Logging matrix reads use a separate bounded deadline", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /GCLOUD_LOG_READ_TIMEOUT_SECONDS=300\b/u);
  assert.match(source, /gcloud_log_read_capture\(\) \{[\s\S]*?GCLOUD_LOG_READ_TIMEOUT_SECONDS/u);
  assert.equal((source.match(/gcloud_log_read_capture GEN[12]_LOGS_JSON/gu) ?? []).length, 2);
  assert.equal((source.match(/gcloud_read_capture GEN[12]_LOGS_JSON/gu) ?? []).length, 0);
});

test("actual runner self-test exercises array and two-cell bookkeeping", () => {
  const result = spawnSync("bash", [runnerPath, "--bash32-self-test"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK\n");
  assert.equal(result.stderr, "");
});

test("runner builds once and deploys explicit Gen1 and Gen2 cells at concurrency 40", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.equal((source.match(/gcloud_build builds submit/gu) ?? []).length, 1);
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

test("partial deployments are recorded for ownership-safe cleanup before failure is preserved", () => {
  const source = readFileSync(runnerPath, "utf8");
  const ownership = source.indexOf('node --input-type=module -e "$DEPLOYED_REVISION_ENV_VALIDATOR"');
  const revisionRecord = source.indexOf('MATRIX_REVISIONS[$matrix_index]="$tag_target"');
  const bindingReadiness = source.indexOf('node --input-type=module -e "$TAG_BINDING_VALIDATOR"');
  assert.match(source, /gcloud_deploy run deploy "\$SERVICE"[\s\S]*?\|\| deploy_status="\$\?"/u);
  assert.match(source, /record_matrix_cell "\$generation" "\$tag" "\$matrix_index"/u);
  assert.match(source, /if \[\[ "\$deploy_status" -ne 0 \]\]; then\s+return "\$deploy_status"/u);
  assert.match(source, /record_matrix_cell "gen1" "\$TAG_G1" "0" \|\| cleanup_failed=1/u);
  assert.match(source, /record_matrix_cell "gen2" "\$TAG_G2" "1" \|\| cleanup_failed=1/u);
  assert.ok(ownership >= 0 && ownership < revisionRecord);
  assert.ok(revisionRecord < bindingReadiness);
});

test("deploy mutation is cancellation-safe and cleanup performs bounded stable discovery", () => {
  const source = readFileSync(runnerPath, "utf8");
  const deployFunction = source.slice(
    source.indexOf("deploy_matrix_cell()"),
    source.indexOf("run_five_cases()"),
  );
  const criticalStart = deployFunction.indexOf("MUTATION_CRITICAL=1");
  const deploy = deployFunction.indexOf('gcloud_deploy run deploy "$SERVICE"');
  const stableDiscovery = deployFunction.indexOf(
    'discover_matrix_cell_stably "$generation" "$tag" "$matrix_index" "1"',
  );
  const criticalEnd = deployFunction.indexOf("MUTATION_CRITICAL=0", criticalStart);
  assert.ok(criticalStart >= 0 && criticalStart < deploy);
  assert.ok(deploy < stableDiscovery && stableDiscovery < criticalEnd);
  assert.match(source, /DISCOVERY_MAX_ATTEMPTS=[1-9][0-9]*/u);
  assert.match(source, /DISCOVERY_INTERVAL_SECONDS=[1-9][0-9]*/u);
  assert.match(source, /MATRIX_DEPLOY_ATTEMPTED\[\$matrix_index\]=1/u);
  assert.match(source, /discover_matrix_cell_stably "gen1" "\$TAG_G1" "0" "0"/u);
  assert.match(source, /discover_matrix_cell_stably "gen2" "\$TAG_G2" "1" "0"/u);
  assert.match(source, /stabilize_owned_tag_cleanup "\$TAG_G1" "0" "gen1"/u);
  assert.match(source, /stabilize_owned_tag_cleanup "\$TAG_G2" "1" "gen2"/u);
});

test("context is validated and published only after cleanup verification", () => {
  const source = readFileSync(runnerPath, "utf8");
  const cleanupVerified = source.indexOf("CLEANUP_VERIFIED=1");
  const generateContext = source.indexOf("generate_probe_context", cleanupVerified);
  const publishContext = source.indexOf('mv "$PROBE_CONTEXT_RUN_PATH" "$PROBE_CONTEXT_PATH"', generateContext);
  assert.match(source, /CONTEXT_GENERATED=0/u);
  assert.match(source, /CONTEXT_VALIDATED=0/u);
  assert.match(source, /CLEANUP_VERIFIED=0/u);
  assert.match(source, /CONTEXT_GENERATED=1/u);
  assert.match(source, /CONTEXT_VALIDATED=1/u);
  assert.ok(cleanupVerified >= 0 && cleanupVerified < generateContext);
  assert.ok(generateContext < publishContext);
  assert.doesNotMatch(source, /if \[\[ -e "\$PROBE_CONTEXT_TMP" \]\]/u);
});

test("INT and TERM are latched through cleanup and retain signal exit status", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /latch_signal 130/u);
  assert.match(source, /latch_signal 143/u);
  assert.match(source, /trap 'latch_signal 130' INT/u);
  assert.match(source, /trap 'latch_signal 143' TERM/u);
  assert.match(source, /if \[\[ "\$SIGNAL_STATUS" -ne 0 \]\]; then\s+final_status="\$SIGNAL_STATUS"/u);
  assert.doesNotMatch(source, /trap '' INT TERM/u);
  assert.match(
    source,
    /cleanup\(\) \{[\s\S]*?MUTATION_CRITICAL=1\s+trap 'latch_signal 130' INT\s+trap 'latch_signal 143' TERM\s+[\s\S]*?CLEANUP_DONE=1/u,
  );
  assert.match(
    source,
    /preflight_on_exit\(\) \{[\s\S]*?trap - EXIT\s+trap 'latch_signal 130' INT\s+trap 'latch_signal 143' TERM/u,
  );
});

test("cleanup re-arbitrates a late signal after leaving its critical section", () => {
  const source = readFileSync(runnerPath, "utf8");
  const cleanupBody = source.slice(source.indexOf("\ncleanup() {"), source.indexOf("\non_exit() {"));
  const restoreInt = cleanupBody.lastIndexOf("trap on_int INT");
  const restoreTerm = cleanupBody.lastIndexOf("trap on_term TERM");
  const criticalClear = cleanupBody.lastIndexOf("MUTATION_CRITICAL=0");
  const lateArbitration = cleanupBody.indexOf(
    'if [[ "$SIGNAL_STATUS" -ne 0 ]]; then',
    criticalClear,
  );
  const signalStatusReturn = cleanupBody.indexOf('final_status="$SIGNAL_STATUS"', lateArbitration);
  const finalReturn = cleanupBody.lastIndexOf('return "$final_status"');
  assert.ok(restoreInt >= 0 && restoreInt < restoreTerm);
  assert.ok(restoreTerm < criticalClear && criticalClear < lateArbitration);
  assert.ok(lateArbitration < signalStatusReturn && signalStatusReturn < finalReturn);
});

test("partial promotion rollback clears state only after both shared paths are absent", () => {
  const source = readFileSync(runnerPath, "utf8");
  const rollbackBody = source.slice(
    source.indexOf("rollback_published_artifacts()"),
    source.indexOf("\nlatch_signal()"),
  );
  const resultProof = rollbackBody.indexOf('artifact_path_absent "$PROBE_RESULTS_PATH"');
  const contextProof = rollbackBody.indexOf('artifact_path_absent "$PROBE_CONTEXT_PATH"');
  const clearState = rollbackBody.indexOf("ARTIFACTS_PUBLISHED=0");
  assert.match(source, /RESULTS_PROMOTED=0/u);
  assert.match(source, /CONTEXT_PROMOTED=0/u);
  assert.match(rollbackBody, /if \[\[ "\$RESULTS_PROMOTED" -eq 1 \]\]/u);
  assert.match(rollbackBody, /if \[\[ "\$CONTEXT_PROMOTED" -eq 1 \]\]/u);
  assert.ok(resultProof >= 0 && resultProof < contextProof);
  assert.ok(contextProof < clearState);
  assert.doesNotMatch(rollbackBody, /\|\| true/u);
});

test("unproven publication rollback retains lock and publication ownership state", () => {
  const source = readFileSync(runnerPath, "utf8");
  const cleanupBody = source.slice(source.indexOf("\ncleanup() {"), source.indexOf("\non_exit() {"));
  assert.match(source, /PUBLICATION_ROLLBACK_FAILED=0/u);
  assert.match(
    cleanupBody,
    /if \[\[ "\$PUBLICATION_ROLLBACK_FAILED" -eq 0 && "\$REMOTE_CLEANUP_UNRESOLVED" -eq 0 \]\]; then\s+if ! release_operator_lock; then[\s\S]*?rollback_published_artifacts \|\| PUBLICATION_ROLLBACK_FAILED=1/u,
  );
  assert.match(
    cleanupBody,
    /if \[\[ "\$PUBLICATION_ROLLBACK_FAILED" -ne 0 \]\]; then\s+cleanup_failed=1/u,
  );
  assert.match(
    source,
    /if ! rmdir "\$OPERATOR_LOCK_DIR"; then[\s\S]*?printf '%s\\n' "\$OPERATOR_LOCK_OWNER" > "\$OPERATOR_LOCK_OWNER_FILE"[\s\S]*?return 1/u,
  );
});

test("single-operator lock rejects foreign ownership and guards shared artifact publication", () => {
  const source = readFileSync(runnerPath, "utf8");
  const acquire = source.indexOf("\nacquire_operator_lock\n");
  const sharedArtifactGate = source.indexOf('test ! -e "$EVIDENCE_DIR/probe-results.json"');
  const sharedPreflight = source.indexOf('gcloud_read_capture STAGING_SERVICE_JSON run services describe "$SERVICE"');
  const publish = source.indexOf('mv "$PROBE_CONTEXT_RUN_PATH" "$PROBE_CONTEXT_PATH"');
  const release = source.indexOf("release_operator_lock", publish);
  assert.match(source, /mkdir "\$OPERATOR_LOCK_DIR"/u);
  assert.match(source, /test "\$lock_owner_on_disk" = "\$OPERATOR_LOCK_OWNER"/u);
  assert.match(source, /PROBE_RESULTS_RUN_PATH=.*\$RUN_ID/u);
  assert.match(source, /PROBE_CONTEXT_RUN_PATH=.*\$RUN_ID/u);
  assert.doesNotMatch(source, /rm -rf .*OPERATOR_LOCK/u);
  assert.ok(acquire >= 0 && acquire < sharedArtifactGate && sharedArtifactGate < sharedPreflight);
  assert.ok(publish >= 0 && publish < release);
});

test("runner uses a lowercase-safe numeric UTC timestamp for run-owned tags", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /RUN_TIMESTAMP="\$\(date -u \+%Y%m%d%H%M%S\)"/u);
  assert.doesNotMatch(source, /RUN_TIMESTAMP="\$\(date -u \+%Y%m%dT%H%M%SZ\)"/u);
});

function extractedRunIdentityFunction(source) {
  const start = source.indexOf("create_run_identity() {");
  const end = source.indexOf("\n\nacquire_operator_lock()", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("run-owned tags fit the observed staging service budget", () => {
  const source = readFileSync(runnerPath, "utf8");
  const service = source.match(/^SERVICE="([^"]+)"$/mu)?.[1];
  assert.equal(service, "shipmastr-api-staging");
  const script = `${extractedRunIdentityFunction(source)}
create_run_identity 20260818051610 13123c4ebf2a 5004c74d6a49 ${JSON.stringify(service)}
printf '%s\\n%s\\n%s\\n' "$RUN_ID" "$TAG_G1" "$TAG_G2"
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [runId, tagG1, tagG2] = result.stdout.trim().split("\n");
  assert.equal(runId, "20260818051610-13123c4ebf2a-5004c74d6a49");
  assert.equal(tagG1, "rlp-18051613125004c74d-g1");
  assert.equal(tagG2, "rlp-18051613125004c74d-g2");
  assert.match(tagG1, /^rlp-[0-9a-f]{18}-g1$/u);
  assert.match(tagG2, /^rlp-[0-9a-f]{18}-g2$/u);
  assert.notEqual(tagG1, tagG2);
  assert.equal(service.length + tagG1.length <= 46, true);
  assert.equal(service.length + tagG2.length <= 46, true);
});

test("self-test and all read-only gates precede token build and deploy", () => {
  const source = readFileSync(runnerPath, "utf8");
  const selfTest = source.indexOf("--bash32-self-test");
  const commandPreflight = source.indexOf("for required_command");
  const matrixPreflight = source.indexOf('node "$PARSER" matrix-preflight');
  const domainMapping = source.indexOf("domain-mappings list");
  const token = source.indexOf('PROBE_TOKEN="$(openssl rand -hex 32)"');
  const build = source.indexOf("gcloud_build builds submit");
  assert.ok(selfTest >= 0 && selfTest < commandPreflight);
  assert.ok(matrixPreflight > commandPreflight && matrixPreflight < token);
  assert.ok(domainMapping > matrixPreflight && domainMapping < token);
  assert.ok(token < build);
  assert.equal(source.includes('node "$PARSER" runtime-parity'), false);
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

test("revision-log-labels rejects missing and non-object label maps without output", () => {
  const invalidRevisions = [
    { metadata: { name: revision } },
    { metadata: { name: revision, labels: null } },
    { metadata: { name: revision, labels: [] } },
    { metadata: { name: revision, labels: "diagnostic" } },
    { metadata: { name: revision, labels: 1 } }
  ];
  for (const invalidRevision of invalidRevisions) {
    const result = runParser("revision-log-labels", {
      REVISION_JSON: JSON.stringify(invalidRevision)
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.notEqual(result.status, 0);
  }
});

test("revision-log-labels enforces label count, string, bounds, and control-character limits", () => {
  const invalidLabels = [
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key-${index}`, "value"])),
    { "": "value" },
    { ["k".repeat(129)]: "value" },
    { key: 1 },
    { key: "v".repeat(257) },
    { "key\u0000": "value" },
    { key: "value\u007f" }
  ];
  for (const labels of invalidLabels) {
    const result = runParser("revision-log-labels", {
      REVISION_JSON: revisionJson({ labels })
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.notEqual(result.status, 0);
  }
});

test("revision-log-labels rejects canonical maps above 16,384 UTF-8 bytes", () => {
  const labels = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    `key-${String(index).padStart(2, "0")}-${"k".repeat(121)}`,
    "v".repeat(256)
  ]));
  const result = runParser("revision-log-labels", {
    REVISION_JSON: revisionJson({ labels })
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.notEqual(result.status, 0);
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
    EXPECTED_IMAGE_REF: image,
    EXPECTED_EXECUTION_ENVIRONMENT: "gen1",
    EXPECTED_CONTAINER_CONCURRENCY: "40"
  });
  assert.equal(result.stderr, "");
  assert.equal(result.status, 4);
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

function gcloudCalls(run, prefix) {
  return run.calls.filter(({ command, args }) =>
    command === "gcloud" && prefix.every((part, index) => args[index] === part)
  );
}

function deployedTags(run) {
  return gcloudCalls(run, ["run", "deploy"])
    .map(({ args }) => args.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length))
    .filter(Boolean);
}

function removedTags(run) {
  return gcloudCalls(run, ["run", "services", "update-traffic"])
    .map(({ args }) => args.find((arg) => arg.startsWith("--remove-tags="))?.slice("--remove-tags=".length))
    .filter(Boolean);
}

function assertNoProductionMutation(run) {
  const serviceMutations = run.calls.filter(({ command, args }) => {
    if (command !== "gcloud" || args[0] !== "run") return false;
    return args[1] === "deploy" ||
      (args[1] === "services" && ["update", "update-traffic"].includes(args[2]));
  });
  const expectedTags = new Set(deployedTags(run));
  for (const { args } of serviceMutations) {
    const service = args[1] === "deploy" ? args[2] : args[3];
    assert.equal(service, "shipmastr-api-staging");
    assert.ok(args.includes("--project=shipmastr-core-prod"));
    assert.ok(args.includes("--region=asia-south1"));
    if (args[2] === "update-traffic") {
      const tag = args.find((arg) => arg.startsWith("--remove-tags="))
        ?.slice("--remove-tags=".length);
      assert.ok(expectedTags.has(tag));
    }
  }
}

function assertNoRawLabelMaps(run) {
  const serializedArtifacts = JSON.stringify({ result: run.result, context: run.context });
  for (const output of [run.stdout, run.stderr, serializedArtifacts]) {
    for (const forbidden of [
      "MATRIX_EXPECTED_LOG_LABELS_JSON",
      "GEN1_EXPECTED_LOG_LABELS_JSON",
      "GEN2_EXPECTED_LOG_LABELS_JSON",
      "expectedLabels",
      "labelsJson",
      "canonicalJson"
    ]) assert.equal(output.includes(forbidden), false);
    assert.equal(output.includes('"matrixGeneration":"one"'), false);
    assert.equal(output.includes('"matrixGeneration":"two"'), false);
  }
}

test("normal runner succeeds through fake cloud boundaries and mutates only its staging cells", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe();
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.equal(run.status, 0, run.stderr);
  const deploys = gcloudCalls(run, ["run", "deploy"]);
  assert.equal(deploys.length, 2);
  assert.deepEqual(deploys.map(({ args }) => args[2]), [
    "shipmastr-api-staging", "shipmastr-api-staging"
  ]);
  assert.deepEqual(new Set(deploys.map(({ args }) =>
    args.find((arg) => arg.startsWith("--execution-environment="))
  )), new Set(["--execution-environment=gen1", "--execution-environment=gen2"]));
  const curls = run.calls.filter(({ command }) => command === "curl");
  assert.equal(curls.length, 10);
  for (const { args } of curls) {
    assert.deepEqual(args.slice(args.indexOf("--connect-timeout"), args.indexOf("--connect-timeout") + 2), [
      "--connect-timeout", "10"
    ]);
    assert.deepEqual(args.slice(args.indexOf("--max-time"), args.indexOf("--max-time") + 2), [
      "--max-time", "30"
    ]);
  }
  assert.deepEqual(new Set(removedTags(run)), new Set(deployedTags(run)));
  assert.equal(gcloudCalls(run, ["run", "services", "update"]).length, 1);
  assert.equal(run.resultExists, true);
  assert.equal(run.contextExists, true);
  assert.equal(run.lockExists, false);
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
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

test("post-capture Gen2 log label mismatch fails closed and reconciles owned staging state", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "log_label_mismatch" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.notEqual(run.status, 0);
  assert.equal(deployedTags(run).length, 2);
  assert.deepEqual(new Set(removedTags(run)), new Set(deployedTags(run)));
  assert.equal(run.state.cells.gen1.removed, true);
  assert.equal(run.state.cells.gen2.removed, true);
  assert.equal(run.state.tokenPresent, false);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, false);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

test("timed-out partial deploy returns 124 after late owned-tag discovery and cleanup", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "deploy_timeout_late_tag" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.equal(run.status, 124, run.stderr);
  const [tag] = deployedTags(run);
  assert.ok(tag);
  assert.ok(removedTags(run).includes(tag));
  assert.equal(run.state.cells.gen1.removed, true);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, false);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

test("unresolved timed-out deploy retains its operator lock for reconciliation", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "deploy_timeout_unresolved" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.equal(run.status, 124, run.stderr);
  assert.deepEqual(removedTags(run), []);
  assert.equal(run.state.cells.gen1.visible, false);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, true);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

test("ambiguous tag ownership fails closed without deleting or publishing", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "ambiguous_ownership" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.notEqual(run.status, 0);
  assert.deepEqual(removedTags(run), []);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, true);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

test("cleanup failure still attempts both exact cells and returns nonzero", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "cleanup_failure" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.notEqual(run.status, 0);
  const tags = deployedTags(run);
  assert.equal(tags.length, 2);
  for (const tag of tags) assert.ok(removedTags(run).includes(tag));
  assert.equal(run.state.cells.gen1.removed, false);
  assert.equal(run.state.cells.gen2.removed, true);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, true);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

test("a timed-out cleanup command returns 124 after bounded successful reconciliation", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "cleanup_timeout" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.equal(run.status, 124, run.stderr);
  const tags = deployedTags(run);
  assert.equal(tags.length, 2);
  for (const tag of tags) assert.ok(removedTags(run).includes(tag));
  assert.equal(run.state.cells.gen1.removed, true);
  assert.equal(run.state.cells.gen2.removed, true);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, false);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});

for (const [signal, expectedStatus] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`normal runner handles ${signal} during a stalled deploy`, { timeout: 30_000 }, async (t) => {
    const run = await runFakeProbe({ scenario: "signal", signals: [signal] });
    t.after(() => run.dispose());
    assert.equal(run.harnessTimedOut, false, run.stderr);
    assert.equal(run.status, expectedStatus, run.stderr);
    const [tag] = deployedTags(run);
    assert.ok(tag);
    assert.ok(removedTags(run).includes(tag));
    assert.equal(run.state.cells.gen1.removed, true);
    assert.equal(run.resultExists, false);
    assert.equal(run.contextExists, false);
    assertNoRawLabelMaps(run);
    assertNoProductionMutation(run);
  });
}

for (const [first, second, expectedStatus] of [
  ["SIGINT", "SIGTERM", 130],
  ["SIGTERM", "SIGINT", 143]
]) {
  test(`${first} status survives a late ${second} during cleanup`, {
    timeout: 30_000
  }, async (t) => {
    const run = await runFakeProbe({
      scenario: "late_second_signal",
      signals: [first, second]
    });
    t.after(() => run.dispose());
    assert.equal(run.harnessTimedOut, false, run.stderr);
    assert.equal(run.status, expectedStatus, run.stderr);
    const [tag] = deployedTags(run);
    assert.ok(removedTags(run).includes(tag));
    assert.equal(run.state.cells.gen1.removed, true);
    assert.equal(run.resultExists, false);
    assert.equal(run.contextExists, false);
    assertNoRawLabelMaps(run);
    assertNoProductionMutation(run);
  });
}

test("partial artifact publication is rolled back behaviorally", {
  timeout: 30_000
}, async (t) => {
  const run = await runFakeProbe({ scenario: "partial_publication" });
  t.after(() => run.dispose());
  assert.equal(run.harnessTimedOut, false, run.stderr);
  assert.notEqual(run.status, 0);
  assert.equal(run.resultExists, false);
  assert.equal(run.contextExists, false);
  assert.equal(run.lockExists, false);
  assertNoRawLabelMaps(run);
  assertNoProductionMutation(run);
});
