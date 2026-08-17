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

test("partial deployments are recorded for ownership-safe cleanup before failure is preserved", () => {
  const source = readFileSync(runnerPath, "utf8");
  const ownership = source.indexOf('node --input-type=module -e "$DEPLOYED_REVISION_ENV_VALIDATOR"');
  const revisionRecord = source.indexOf('MATRIX_REVISIONS[$matrix_index]="$tag_target"');
  const bindingReadiness = source.indexOf('node --input-type=module -e "$TAG_BINDING_VALIDATOR"');
  assert.match(source, /gcloud run deploy "\$SERVICE"[\s\S]*?\|\| deploy_status="\$\?"/u);
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
  const deploy = deployFunction.indexOf('gcloud run deploy "$SERVICE"');
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
  assert.match(
    source,
    /set -e\s+trap on_int INT\s+trap on_term TERM\s+MUTATION_CRITICAL=0\s+return "\$final_status"/u,
  );
});

test("single-operator lock rejects foreign ownership and guards shared artifact publication", () => {
  const source = readFileSync(runnerPath, "utf8");
  const acquire = source.indexOf("acquire_operator_lock");
  const sharedArtifactGate = source.indexOf('test ! -e "$EVIDENCE_DIR/probe-results.json"');
  const sharedPreflight = source.indexOf('gcloud run services describe "$SERVICE"');
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
