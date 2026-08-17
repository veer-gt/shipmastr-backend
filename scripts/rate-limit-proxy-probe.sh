#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

COMMAND_TIMEOUT_STATUS=124
GCLOUD_READ_TIMEOUT_SECONDS=60
GCLOUD_MUTATION_TIMEOUT_SECONDS=600
GCLOUD_BUILD_TIMEOUT_SECONDS=1800
GCLOUD_DEPLOY_TIMEOUT_SECONDS=900
COMMAND_KILL_GRACE_SECONDS=5
CURL_CONNECT_TIMEOUT_SECONDS=10
CURL_TOTAL_TIMEOUT_SECONDS=30
ACTIVE_COMMAND_PID=""
ACTIVE_COMMAND_PGID=""
ACTIVE_WATCHDOG_PID=""
ACTIVE_WATCHDOG_PGID=""
COMMAND_TMP_DIR=""
COMMAND_SEQUENCE=0
LAST_COMMAND_TIMED_OUT=0
ANY_COMMAND_TIMED_OUT=0

kill_process_group() {
  local signal_name="$1"
  local process_group="$2"
  if [[ ! "$process_group" =~ ^[1-9][0-9]*$ || "$process_group" == "$$" ]]; then return 1; fi
  kill "-$signal_name" -- "-$process_group" 2>/dev/null
}

terminate_active_command() {
  if [[ -n "$ACTIVE_COMMAND_PGID" ]]; then
    kill_process_group TERM "$ACTIVE_COMMAND_PGID" || true
    kill_process_group KILL "$ACTIVE_COMMAND_PGID" || true
  fi
  if [[ -n "$ACTIVE_WATCHDOG_PGID" ]]; then
    kill_process_group TERM "$ACTIVE_WATCHDOG_PGID" || true
    kill_process_group KILL "$ACTIVE_WATCHDOG_PGID" || true
  fi
}

cleanup_command_tmp() {
  if [[ -z "$COMMAND_TMP_DIR" ]]; then return 0; fi
  if [[ ! -d "$COMMAND_TMP_DIR" || -L "$COMMAND_TMP_DIR" ]]; then return 1; fi
  rm -f -- "$COMMAND_TMP_DIR"/stdout-* "$COMMAND_TMP_DIR"/timeout-* || return 1
  rmdir "$COMMAND_TMP_DIR" || return 1
  COMMAND_TMP_DIR=""
}

run_command_with_deadline_to_path() {
  local deadline_seconds="$1"
  local output_path="$2"
  shift 2
  local command_status=0
  local command_pid=""
  local command_pgid=""
  local watchdog_pid=""
  local watchdog_pgid=""
  local timeout_marker=""
  local signal_status_at_start="${SIGNAL_STATUS:-0}"

  [[ "$deadline_seconds" =~ ^[1-9][0-9]*$ ]] || return 125
  [[ -n "$COMMAND_TMP_DIR" && -d "$COMMAND_TMP_DIR" && ! -L "$COMMAND_TMP_DIR" ]] || return 125
  [[ "$#" -gt 0 ]] || return 125
  COMMAND_SEQUENCE=$((COMMAND_SEQUENCE + 1))
  timeout_marker="$COMMAND_TMP_DIR/timeout-$COMMAND_SEQUENCE"
  artifact_path_absent "$timeout_marker" || return 125
  LAST_COMMAND_TIMED_OUT=0

  set -m
  if [[ "$output_path" == "__inherit__" ]]; then
    "$@" &
  else
    "$@" > "$output_path" &
  fi
  command_pid="$!"
  command_pgid="$command_pid"
  set +m
  [[ "$command_pgid" != "$$" ]] || return 125
  ACTIVE_COMMAND_PID="$command_pid"
  ACTIVE_COMMAND_PGID="$command_pgid"

  set -m
  (
    sleep "$deadline_seconds"
    if kill -0 -- "-$command_pgid" 2>/dev/null; then
      : > "$timeout_marker"
      kill -TERM -- "-$command_pgid" 2>/dev/null || true
      sleep "$COMMAND_KILL_GRACE_SECONDS"
      kill -KILL -- "-$command_pgid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid="$!"
  watchdog_pgid="$watchdog_pid"
  set +m
  ACTIVE_WATCHDOG_PID="$watchdog_pid"
  ACTIVE_WATCHDOG_PGID="$watchdog_pgid"

  if wait "$command_pid"; then
    command_status=0
  else
    command_status="$?"
  fi
  if [[ -e "$timeout_marker" ]]; then
    LAST_COMMAND_TIMED_OUT=1
    ANY_COMMAND_TIMED_OUT=1
    kill_process_group KILL "$command_pgid" || true
  fi
  kill_process_group TERM "$watchdog_pgid" || true
  kill_process_group KILL "$watchdog_pgid" || true
  wait "$watchdog_pid" 2>/dev/null || true
  ACTIVE_COMMAND_PID=""
  ACTIVE_COMMAND_PGID=""
  ACTIVE_WATCHDOG_PID=""
  ACTIVE_WATCHDOG_PGID=""
  rm -f -- "$timeout_marker" || return 125

  if [[ "$signal_status_at_start" -eq 0 && "${SIGNAL_STATUS:-0}" -ne 0 ]]; then
    return "$SIGNAL_STATUS"
  fi
  if [[ "$LAST_COMMAND_TIMED_OUT" -eq 1 ]]; then return "$COMMAND_TIMEOUT_STATUS"; fi
  return "$command_status"
}

run_command_with_deadline() {
  local deadline_seconds="$1"
  shift
  run_command_with_deadline_to_path "$deadline_seconds" "__inherit__" "$@"
}

run_command_capture() {
  local variable_name="$1"
  local deadline_seconds="$2"
  shift 2
  local output_path=""
  local output_value=""
  local command_status=0

  [[ "$variable_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 125
  COMMAND_SEQUENCE=$((COMMAND_SEQUENCE + 1))
  output_path="$COMMAND_TMP_DIR/stdout-$COMMAND_SEQUENCE"
  COMMAND_SEQUENCE=$((COMMAND_SEQUENCE - 1))
  artifact_path_absent "$output_path" || return 125
  : > "$output_path" || return 125
  run_command_with_deadline_to_path "$deadline_seconds" "$output_path" "$@" || command_status="$?"
  output_value="$(< "$output_path")"
  rm -f -- "$output_path" || return 125
  printf -v "$variable_name" '%s' "$output_value"
  return "$command_status"
}

gcloud_read_capture() {
  local variable_name="$1"
  shift
  run_command_capture "$variable_name" "$GCLOUD_READ_TIMEOUT_SECONDS" gcloud "$@"
}

gcloud_mutation() {
  run_command_with_deadline "$GCLOUD_MUTATION_TIMEOUT_SECONDS" gcloud "$@"
}

gcloud_build() {
  run_command_with_deadline "$GCLOUD_BUILD_TIMEOUT_SECONDS" gcloud "$@"
}

gcloud_deploy() {
  run_command_with_deadline "$GCLOUD_DEPLOY_TIMEOUT_SECONDS" gcloud "$@"
}

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

acquire_operator_lock() {
  mkdir "$OPERATOR_LOCK_DIR" 2>/dev/null || return 1
  if ! printf '%s\n' "$OPERATOR_LOCK_OWNER" > "$OPERATOR_LOCK_OWNER_FILE"; then
    rmdir "$OPERATOR_LOCK_DIR" >/dev/null 2>&1 || true
    return 1
  fi
  LOCK_ACQUIRED=1
}

release_operator_lock() {
  local lock_owner_on_disk=""

  if [[ "$LOCK_ACQUIRED" -ne 1 ]]; then return 0; fi
  if [[ ! -f "$OPERATOR_LOCK_OWNER_FILE" || -L "$OPERATOR_LOCK_OWNER_FILE" ]]; then return 1; fi
  lock_owner_on_disk="$(< "$OPERATOR_LOCK_OWNER_FILE")" || return 1
  test "$lock_owner_on_disk" = "$OPERATOR_LOCK_OWNER" || return 1
  rm -- "$OPERATOR_LOCK_OWNER_FILE" || return 1
  if ! rmdir "$OPERATOR_LOCK_DIR"; then
    if [[ ! -e "$OPERATOR_LOCK_OWNER_FILE" && ! -L "$OPERATOR_LOCK_OWNER_FILE" ]]; then
      printf '%s\n' "$OPERATOR_LOCK_OWNER" > "$OPERATOR_LOCK_OWNER_FILE" || return 1
    fi
    return 1
  fi
  LOCK_ACQUIRED=0
}

artifact_path_absent() {
  local artifact_path="$1"
  [[ ! -e "$artifact_path" && ! -L "$artifact_path" ]]
}

rollback_promoted_artifact() {
  local shared_path="$1"
  local run_path="$2"

  if artifact_path_absent "$shared_path"; then return 0; fi
  if ! mv "$shared_path" "$run_path" >/dev/null 2>&1; then
    rm -f -- "$shared_path" >/dev/null 2>&1 || return 1
  fi
  artifact_path_absent "$shared_path"
}

rollback_published_artifacts() {
  local rollback_failed=0

  if [[ "$RESULTS_PROMOTED" -eq 1 ]]; then
    rollback_promoted_artifact "$PROBE_RESULTS_PATH" "$PROBE_RESULTS_RUN_PATH" || rollback_failed=1
  fi
  if [[ "$CONTEXT_PROMOTED" -eq 1 ]]; then
    rollback_promoted_artifact "$PROBE_CONTEXT_PATH" "$PROBE_CONTEXT_RUN_PATH" || rollback_failed=1
  fi
  artifact_path_absent "$PROBE_RESULTS_PATH" || rollback_failed=1
  artifact_path_absent "$PROBE_CONTEXT_PATH" || rollback_failed=1
  if [[ "$rollback_failed" -ne 0 ]]; then return 1; fi

  RESULTS_PROMOTED=0
  CONTEXT_PROMOTED=0
  ARTIFACTS_PUBLISHED=0
}

latch_signal() {
  local signal_status="$1"
  if [[ "$SIGNAL_STATUS" -eq 0 ]]; then
    SIGNAL_STATUS="$signal_status"
  fi
  terminate_active_command
}

preflight_on_exit() {
  local status="$?"
  MUTATION_CRITICAL=1
  trap - EXIT
  trap 'latch_signal 130' INT
  trap 'latch_signal 143' TERM
  if ! cleanup_command_tmp && [[ "$status" -eq 0 ]]; then
    status=1
  fi
  if ! release_operator_lock && [[ "$status" -eq 0 ]]; then
    status=1
  fi
  trap preflight_on_int INT
  trap preflight_on_term TERM
  MUTATION_CRITICAL=0
  if [[ "$SIGNAL_STATUS" -ne 0 ]]; then
    status="$SIGNAL_STATUS"
  fi
  exit "$status"
}

preflight_on_int() {
  latch_signal 130
  if [[ "$MUTATION_CRITICAL" -eq 0 ]]; then
    exit "$SIGNAL_STATUS"
  fi
}

preflight_on_term() {
  latch_signal 143
  if [[ "$MUTATION_CRITICAL" -eq 0 ]]; then
    exit "$SIGNAL_STATUS"
  fi
}

bash32_self_test() {
  local matrix_text="gen1
40
gen2
40"
  local generations=()
  local concurrencies=()
  local lock_test_root=""
  local saved_lock_owner=""
  local deadline_status=0
  local SELF_TEST_CAPTURE=""
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
  lock_test_root="$(mktemp -d)"
  OPERATOR_LOCK_DIR="$lock_test_root/operator.lock"
  OPERATOR_LOCK_OWNER_FILE="$OPERATOR_LOCK_DIR/owner"
  OPERATOR_LOCK_OWNER="00112233445566778899aabbccddeeff"
  LOCK_ACQUIRED=0
  acquire_operator_lock
  test -d "$OPERATOR_LOCK_DIR"
  if acquire_operator_lock; then return 1; fi
  test -d "$OPERATOR_LOCK_DIR"
  saved_lock_owner="$OPERATOR_LOCK_OWNER"
  OPERATOR_LOCK_OWNER="foreign-owner"
  if release_operator_lock; then return 1; fi
  test -d "$OPERATOR_LOCK_DIR"
  OPERATOR_LOCK_OWNER="$saved_lock_owner"
  release_operator_lock
  test ! -e "$OPERATOR_LOCK_DIR"

  PROBE_RESULTS_PATH="$lock_test_root/shared-results.json"
  PROBE_RESULTS_RUN_PATH="$lock_test_root/run-results.json"
  PROBE_CONTEXT_PATH="$lock_test_root/shared-context.json"
  PROBE_CONTEXT_RUN_PATH="$lock_test_root/run-context.json"
  printf '%s\n' 'safe-results' > "$PROBE_RESULTS_PATH"
  mkdir "$PROBE_CONTEXT_PATH"
  RESULTS_PROMOTED=1
  CONTEXT_PROMOTED=0
  ARTIFACTS_PUBLISHED=1
  if rollback_published_artifacts; then return 1; fi
  test ! -e "$PROBE_RESULTS_PATH"
  test -f "$PROBE_RESULTS_RUN_PATH"
  test -d "$PROBE_CONTEXT_PATH"
  test "$ARTIFACTS_PUBLISHED" -eq 1
  rm -- "$PROBE_RESULTS_RUN_PATH"
  rmdir "$PROBE_CONTEXT_PATH"

  printf '%s\n' 'safe-results' > "$PROBE_RESULTS_PATH"
  printf '%s\n' 'safe-context' > "$PROBE_CONTEXT_PATH"
  RESULTS_PROMOTED=1
  CONTEXT_PROMOTED=1
  ARTIFACTS_PUBLISHED=1
  rollback_published_artifacts
  test ! -e "$PROBE_RESULTS_PATH"
  test ! -e "$PROBE_CONTEXT_PATH"
  test -f "$PROBE_RESULTS_RUN_PATH"
  test -f "$PROBE_CONTEXT_RUN_PATH"
  test "$RESULTS_PROMOTED" -eq 0
  test "$CONTEXT_PROMOTED" -eq 0
  test "$ARTIFACTS_PUBLISHED" -eq 0
  rm -- "$PROBE_RESULTS_RUN_PATH" "$PROBE_CONTEXT_RUN_PATH"

  COMMAND_TMP_DIR="$lock_test_root/commands"
  mkdir "$COMMAND_TMP_DIR"
  COMMAND_SEQUENCE=0
  LAST_COMMAND_TIMED_OUT=0
  ANY_COMMAND_TIMED_OUT=0
  SIGNAL_STATUS=0
  run_command_capture SELF_TEST_CAPTURE 2 "$BASH" -c "printf '%s' deadline-capture"
  test "$SELF_TEST_CAPTURE" = "deadline-capture"
  run_command_with_deadline 1 "$BASH" -c 'sleep 2' || deadline_status="$?"
  test "$deadline_status" -eq "$COMMAND_TIMEOUT_STATUS"
  test "$LAST_COMMAND_TIMED_OUT" -eq 1
  cleanup_command_tmp
  ANY_COMMAND_TIMED_OUT=0
  LAST_COMMAND_TIMED_OUT=0
  rmdir "$lock_test_root"
  SIGNAL_STATUS=0
  latch_signal 130
  latch_signal 143
  test "$SIGNAL_STATUS" -eq 130
  printf '%s\n' 'RATE_LIMIT_PROXY_PROBE_BASH32_SELF_TEST_OK'
}

if [[ "${1:-}" == "--bash32-self-test" ]]; then
  test "$#" -eq 1
  bash32_self_test
  exit 0
fi
test "$#" -eq 0

PROJECT="shipmastr-core-prod"
REGION="asia-south1"
SERVICE="shipmastr-api-staging"
PRODUCTION_SERVICE="shipmastr-api"
EXPECTED_BASE="a965f4314d7af02dc45c05733efaea322acb87eb"
BRANCH="hotfix/rate-limit-proxy-probe"
IMAGE_URI="asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api"
EVIDENCE_DIR=".superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe"
PARSER="scripts/rate-limit-proxy-probe-parsers.mjs"

for required_command in git gcloud node openssl curl date mv rm mkdir rmdir mktemp sleep; do
  command -v "$required_command" >/dev/null 2>&1
done
test -f "$PARSER"

test "$(git branch --show-current)" = "$BRANCH"
test "$(git merge-base HEAD "$EXPECTED_BASE")" = "$EXPECTED_BASE"
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=normal)"
test -d "$EVIDENCE_DIR"
SIGNAL_STATUS=0
MUTATION_CRITICAL=0
LOCK_ACQUIRED=0
OPERATOR_LOCK_DIR="$EVIDENCE_DIR/.rate-limit-proxy-probe.lock"
OPERATOR_LOCK_OWNER_FILE="$OPERATOR_LOCK_DIR/owner"
OPERATOR_LOCK_OWNER="$(openssl rand -hex 16)"
[[ "$OPERATOR_LOCK_OWNER" =~ ^[0-9a-f]{32}$ ]]
trap preflight_on_exit EXIT
trap preflight_on_int INT
trap preflight_on_term TERM
acquire_operator_lock
COMMAND_TMP_DIR="$(mktemp -d "$EVIDENCE_DIR/.rate-limit-proxy-probe-command.XXXXXX")"
[[ -d "$COMMAND_TMP_DIR" && ! -L "$COMMAND_TMP_DIR" ]]
GCLOUD_PROJECT=""
gcloud_read_capture GCLOUD_PROJECT config get-value project
test "$GCLOUD_PROJECT" = "$PROJECT"
test ! -e "$EVIDENCE_DIR/probe-results.json"
test ! -e "$EVIDENCE_DIR/probe-context.json"
SOURCE_HEAD="$(git rev-parse HEAD)"
[[ "$SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]]
TESTED_HEAD="$SOURCE_HEAD"

STAGING_SERVICE_JSON=""
gcloud_read_capture STAGING_SERVICE_JSON run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json

STAGING_SERVICE_FIELDS_OUTPUT="$(
  SERVICE_JSON="$STAGING_SERVICE_JSON" node --input-type=module -e '
    const service = JSON.parse(process.env.SERVICE_JSON ?? "");
    const traffic = service?.status?.traffic;
    const positive = Array.isArray(traffic)
      ? traffic.filter((entry) => Number(entry?.percent ?? 0) > 0)
      : [];
    if (
      typeof service?.status?.url !== "string" ||
      !/^https:\/\/[^\s]+$/.test(service.status.url) ||
      positive.length !== 1 ||
      typeof positive[0]?.revisionName !== "string" ||
      Number(positive[0]?.percent) !== 100
    ) {
      process.exit(2);
    }
    const template = service?.spec?.template;
    const executionEnvironment =
      template?.metadata?.annotations?.["run.googleapis.com/execution-environment"];
    const concurrency = template?.spec?.containerConcurrency;
    process.stdout.write([
      service.status.url,
      positive[0].revisionName,
      executionEnvironment === undefined ? "__absent__" : String(executionEnvironment),
      concurrency === undefined ? "__absent__" : String(concurrency),
      JSON.stringify(traffic),
    ].join("\n") + "\n");
  '
)"
read_fields "$STAGING_SERVICE_FIELDS_OUTPUT"
STAGING_SERVICE_FIELDS=("${READ_FIELDS[@]}")
test "${#STAGING_SERVICE_FIELDS[@]}" -eq 5
ORIGINAL_STAGING_URL="${STAGING_SERVICE_FIELDS[0]}"
ORIGINAL_REVISION="${STAGING_SERVICE_FIELDS[1]}"
STAGING_TEMPLATE_EXECUTION_ENVIRONMENT="${STAGING_SERVICE_FIELDS[2]}"
STAGING_TEMPLATE_CONTAINER_CONCURRENCY="${STAGING_SERVICE_FIELDS[3]}"
ORIGINAL_TRAFFIC_JSON="${STAGING_SERVICE_FIELDS[4]}"

ORIGINAL_REVISION_JSON=""
gcloud_read_capture ORIGINAL_REVISION_JSON run revisions describe "$ORIGINAL_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json

ORIGINAL_REVISION_FIELDS_OUTPUT="$(
  REVISION_JSON="$ORIGINAL_REVISION_JSON" node --input-type=module -e '
    const revision = JSON.parse(process.env.REVISION_JSON ?? "");
    const containers = revision?.spec?.containers;
    if (!Array.isArray(containers) || containers.length !== 1) process.exit(2);
    const digestSource = revision?.status?.imageDigest ?? containers[0]?.image ?? "";
    const digest = String(digestSource).match(/sha256:[0-9a-f]{64}$/)?.[0];
    if (digest === undefined) process.exit(3);
    const env = Array.isArray(containers[0]?.env) ? containers[0].env : [];
    const envState = (name) => {
      const matches = env.filter((entry) => entry?.name === name);
      if (matches.length === 0) return "__absent__";
      if (matches.length !== 1 || typeof matches[0]?.value !== "string") return "__nonliteral__";
      return matches[0].value;
    };
    const executionEnvironment =
      revision?.metadata?.annotations?.["run.googleapis.com/execution-environment"];
    const concurrency = revision?.spec?.containerConcurrency;
    process.stdout.write([
      digest,
      envState("COURIER_AUDIT_INTAKE_ENABLED"),
      envState("RATE_LIMIT_PROXY_PROBE_TOKEN"),
      executionEnvironment === undefined ? "__absent__" : String(executionEnvironment),
      concurrency === undefined ? "__absent__" : String(concurrency),
    ].join("\n") + "\n");
  '
)"
read_fields "$ORIGINAL_REVISION_FIELDS_OUTPUT"
ORIGINAL_REVISION_FIELDS=("${READ_FIELDS[@]}")
test "${#ORIGINAL_REVISION_FIELDS[@]}" -eq 5
ORIGINAL_IMAGE_DIGEST="${ORIGINAL_REVISION_FIELDS[0]}"
ACTIVE_COURIER_AUDIT_INTAKE="${ORIGINAL_REVISION_FIELDS[1]}"
ACTIVE_PROBE_TOKEN_STATE="${ORIGINAL_REVISION_FIELDS[2]}"
STAGING_ACTIVE_EXECUTION_ENVIRONMENT="${ORIGINAL_REVISION_FIELDS[3]}"
STAGING_ACTIVE_CONTAINER_CONCURRENCY="${ORIGINAL_REVISION_FIELDS[4]}"
[[ "$ORIGINAL_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$ACTIVE_COURIER_AUDIT_INTAKE" == "__absent__" || "$ACTIVE_COURIER_AUDIT_INTAKE" == "false" ]]
test "$ACTIVE_PROBE_TOKEN_STATE" = "__absent__"

SERVICE_JSON="$STAGING_SERVICE_JSON" node --input-type=module -e '
  const service = JSON.parse(process.env.SERVICE_JSON ?? "");
  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic)) process.exit(2);
  if (traffic.some((entry) => typeof entry?.tag === "string" && entry.tag.startsWith("rlp-"))) {
    process.exit(3);
  }
  const containers = service?.spec?.template?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) process.exit(4);
  const env = containers[0]?.env;
  if (env !== undefined && !Array.isArray(env)) process.exit(4);
  const probeTokens = (env ?? []).filter((entry) => entry?.name === "RATE_LIMIT_PROXY_PROBE_TOKEN");
  if (probeTokens.length !== 0) process.exit(5);
  const intake = (env ?? []).filter((entry) => entry?.name === "COURIER_AUDIT_INTAKE_ENABLED");
  if (intake.length > 1 || (intake.length === 1 && intake[0]?.value !== "false")) process.exit(6);
'

PRODUCTION_SERVICE_JSON=""
gcloud_read_capture PRODUCTION_SERVICE_JSON run services describe "$PRODUCTION_SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json

PRODUCTION_REVISION="$(
  SERVICE_JSON="$PRODUCTION_SERVICE_JSON" node --input-type=module -e '
    const service = JSON.parse(process.env.SERVICE_JSON ?? "");
    const traffic = service?.status?.traffic;
    const positive = Array.isArray(traffic)
      ? traffic.filter((entry) => Number(entry?.percent ?? 0) > 0)
      : [];
    if (
      positive.length !== 1 ||
      typeof positive[0]?.revisionName !== "string" ||
      Number(positive[0]?.percent) !== 100
    ) process.exit(2);
    process.stdout.write(positive[0].revisionName);
  '
)"
PRODUCTION_REVISION_JSON=""
gcloud_read_capture PRODUCTION_REVISION_JSON run revisions describe "$PRODUCTION_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json

PRODUCTION_RUNTIME_FIELDS_OUTPUT="$(
  REVISION_JSON="$PRODUCTION_REVISION_JSON" node --input-type=module -e '
    const revision = JSON.parse(process.env.REVISION_JSON ?? "");
    const executionEnvironment =
      revision?.metadata?.annotations?.["run.googleapis.com/execution-environment"];
    const concurrency = revision?.spec?.containerConcurrency;
    process.stdout.write([
      executionEnvironment === undefined ? "__absent__" : String(executionEnvironment),
      concurrency === undefined ? "__absent__" : String(concurrency),
    ].join("\n") + "\n");
  '
)"
read_fields "$PRODUCTION_RUNTIME_FIELDS_OUTPUT"
PRODUCTION_RUNTIME_FIELDS=("${READ_FIELDS[@]}")
test "${#PRODUCTION_RUNTIME_FIELDS[@]}" -eq 2
PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT="${PRODUCTION_RUNTIME_FIELDS[0]}"
PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY="${PRODUCTION_RUNTIME_FIELDS[1]}"

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

DOMAIN_MAPPINGS_JSON=""
gcloud_read_capture DOMAIN_MAPPINGS_JSON beta run domain-mappings list \
  --project="$PROJECT" --region="$REGION" --format=json

PRODUCTION_DOMAIN_MAPPING_COUNT="$(
  DOMAIN_MAPPINGS_JSON="$DOMAIN_MAPPINGS_JSON" \
  PRODUCTION_SERVICE_TO_CHECK="$PRODUCTION_SERVICE" \
  node --input-type=module -e '
    const mappings = JSON.parse(process.env.DOMAIN_MAPPINGS_JSON ?? "");
    if (!Array.isArray(mappings)) process.exit(2);
    const production = process.env.PRODUCTION_SERVICE_TO_CHECK;
    if (typeof production !== "string" || production.length === 0) process.exit(2);
    const count = mappings.filter((mapping) => mapping?.spec?.routeName === production).length;
    if (count !== 0) process.exit(3);
    process.stdout.write(String(count));
  '
)"
test "$PRODUCTION_DOMAIN_MAPPING_COUNT" = "0"

PROBE_TOKEN="$(openssl rand -hex 32)"
RUN_NONCE="$(openssl rand -hex 6)"
RUN_TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
[[ "$PROBE_TOKEN" =~ ^[0-9a-f]{64}$ ]]
create_run_identity \
  "$RUN_TIMESTAMP" \
  "$(git rev-parse --short=12 HEAD)" \
  "$RUN_NONCE"
IMAGE_TAG="rate-limit-proxy-probe-$RUN_ID"
EVIDENCE_TMP="$EVIDENCE_DIR/.probe-results-$RUN_ID.tmp"
PROBE_RESULTS_RUN_PATH="$EVIDENCE_DIR/.probe-results-$RUN_ID.ready"
PROBE_RESULTS_PATH="$EVIDENCE_DIR/probe-results.json"
PROBE_CONTEXT_PATH="$EVIDENCE_DIR/probe-context.json"
PROBE_CONTEXT_TMP="$EVIDENCE_DIR/.probe-context-$RUN_ID.tmp"
PROBE_CONTEXT_RUN_PATH="$EVIDENCE_DIR/.probe-context-$RUN_ID.ready"
test ! -e "$EVIDENCE_TMP"
test ! -e "$PROBE_RESULTS_RUN_PATH"
test ! -e "$PROBE_CONTEXT_TMP"
test ! -e "$PROBE_CONTEXT_RUN_PATH"
MATRIX_GENERATIONS=("gen1" "gen2")
MATRIX_TAGS=("$TAG_G1" "$TAG_G2")
MATRIX_REVISIONS=("" "")
MATRIX_URLS=("" "")
MATRIX_EXPECTED_LOG_LABELS_JSON=("" "")
MATRIX_EXPECTED_LOG_LABELS_SHA256=("" "")
MATRIX_EXPECTED_LOG_LABEL_COUNTS=("" "")
MATRIX_DEPLOY_ATTEMPTED=(0 0)
MATRIX_DEPLOY_UNRESOLVED=(0 0)
IMAGE_REF=""
EVIDENCE_CAPTURED=0
CONTEXT_GENERATED=0
CONTEXT_VALIDATED=0
CLEANUP_VERIFIED=0
ARTIFACTS_PUBLISHED=0
RESULTS_PROMOTED=0
CONTEXT_PROMOTED=0
PUBLICATION_ROLLBACK_FAILED=0
REMOTE_CLEANUP_UNRESOLVED=0
CLEANUP_DONE=0
MATRIX_EXACT_MATCH=""
DISCOVERY_MAX_ATTEMPTS=6
DISCOVERY_INTERVAL_SECONDS=5
DISCOVERY_REQUIRED_ABSENT=3

TAG_BINDING_VALIDATOR='
  const service = JSON.parse(process.env.SERVICE_JSON ?? "");
  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic)) process.exit(2);
  const tagged = traffic.filter((entry) => entry?.tag === process.env.TAG_TO_VERIFY);
  if (
    tagged.length !== 1 ||
    typeof tagged[0]?.revisionName !== "string" ||
    !/^https:\/\/[^\s]+$/.test(tagged[0]?.url ?? "") ||
    Number(tagged[0]?.percent ?? 0) !== 0
  ) process.exit(3);
  const positive = traffic.filter((entry) => Number(entry?.percent ?? 0) > 0);
  if (
    positive.length !== 1 ||
    positive[0]?.revisionName !== process.env.ORIGINAL_REVISION_TO_VERIFY ||
    Number(positive[0]?.percent) !== 100
  ) process.exit(4);
  const taggedNormalPercent = traffic
    .filter((entry) => entry?.revisionName === tagged[0].revisionName && entry?.tag === undefined)
    .reduce((sum, entry) => sum + Number(entry?.percent ?? 0), 0);
  if (taggedNormalPercent !== 0) process.exit(5);
  process.stdout.write(`${tagged[0].revisionName}\n${tagged[0].url}\n`);
'

DEPLOYED_REVISION_ENV_VALIDATOR='
  const revision = JSON.parse(process.env.REVISION_JSON ?? "");
  const containers = revision?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) process.exit(2);
  const env = Array.isArray(containers[0]?.env) ? containers[0].env : [];
  const exactValue = (name, value) => {
    const matches = env.filter((entry) => entry?.name === name);
    return matches.length === 1 && matches[0]?.value === value;
  };
  if (!exactValue("COURIER_AUDIT_INTAKE_ENABLED", "false")) process.exit(3);
  if (!exactValue("RATE_LIMIT_PROXY_PROBE_TOKEN", process.env.EXPECTED_TOKEN)) process.exit(4);
'

record_matrix_cell() {
  local generation="$1"
  local tag="$2"
  local matrix_index="$3"
  local service_json=""
  local tag_target=""
  local revision_json=""
  local label_metadata=""
  local binding_output=""

  [[ "$matrix_index" == "0" || "$matrix_index" == "1" ]] || return 1
  RECORDED_MATRIX_CELL=0
  MATRIX_DISCOVERY_STATE="unknown"
  DEPLOYED_TAG_REVISION=""
  DEPLOYED_TAG_URL=""
  gcloud_read_capture service_json run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json || return "$?"
  tag_target="$(SERVICE_JSON="$service_json" TAG_TO_FIND="$tag" node "$PARSER" tag-state)" || return 1
  if [[ "$tag_target" == "absent" ]]; then
    MATRIX_DISCOVERY_STATE="absent"
    return 0
  fi
  if [[ -z "$IMAGE_REF" ]]; then return 1; fi
  gcloud_read_capture revision_json run revisions describe "$tag_target" \
    --project="$PROJECT" --region="$REGION" --format=json || return "$?"
  SERVICE_JSON="$service_json" REVISION_JSON="$revision_json" \
    TAG_TO_FIND="$tag" EXPECTED_REVISION="$tag_target" \
    EXPECTED_IMAGE_REF="$IMAGE_REF" EXPECTED_EXECUTION_ENVIRONMENT="$generation" \
    EXPECTED_CONTAINER_CONCURRENCY="40" node "$PARSER" owned-tag >/dev/null || return 1
  REVISION_JSON="$revision_json" EXPECTED_TOKEN="$PROBE_TOKEN" \
    node --input-type=module -e "$DEPLOYED_REVISION_ENV_VALIDATOR" || return 1
  MATRIX_DISCOVERY_STATE="owned"
  MATRIX_REVISIONS[$matrix_index]="$tag_target"
  label_metadata="$(
    REVISION_JSON="$revision_json" node "$PARSER" revision-log-labels
  )" || return 1
  read_fields "$label_metadata"
  test "${#READ_FIELDS[@]}" -eq 3 || return 1
  [[ "${READ_FIELDS[1]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${READ_FIELDS[2]}" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  MATRIX_EXPECTED_LOG_LABELS_JSON[$matrix_index]="${READ_FIELDS[0]}"
  MATRIX_EXPECTED_LOG_LABELS_SHA256[$matrix_index]="${READ_FIELDS[1]}"
  MATRIX_EXPECTED_LOG_LABEL_COUNTS[$matrix_index]="${READ_FIELDS[2]}"
  binding_output="$(SERVICE_JSON="$service_json" TAG_TO_VERIFY="$tag" \
    ORIGINAL_REVISION_TO_VERIFY="$ORIGINAL_REVISION" node --input-type=module -e "$TAG_BINDING_VALIDATOR")" || return 1
  read_fields "$binding_output"
  test "${#READ_FIELDS[@]}" -eq 2 || return 1
  test "${READ_FIELDS[0]}" = "$tag_target" || return 1
  DEPLOYED_TAG_REVISION="${READ_FIELDS[0]}"
  DEPLOYED_TAG_URL="${READ_FIELDS[1]}"
  MATRIX_URLS[$matrix_index]="$DEPLOYED_TAG_URL"
  test -n "${MATRIX_EXPECTED_LOG_LABELS_JSON[$matrix_index]}" || return 1
  [[ "${MATRIX_EXPECTED_LOG_LABELS_SHA256[$matrix_index]}" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "${MATRIX_EXPECTED_LOG_LABEL_COUNTS[$matrix_index]}" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  MATRIX_DISCOVERY_STATE="ready"
  RECORDED_MATRIX_CELL=1
}

discover_matrix_cell_stably() {
  local generation="$1"
  local tag="$2"
  local matrix_index="$3"
  local require_ready="$4"
  local attempt=0
  local absent_streak=0
  local record_status=0
  local saw_timeout=0

  [[ "$require_ready" == "0" || "$require_ready" == "1" ]] || return 1
  while [[ "$attempt" -lt "$DISCOVERY_MAX_ATTEMPTS" ]]; do
    attempt=$((attempt + 1))
    record_status=0
    record_matrix_cell "$generation" "$tag" "$matrix_index" || record_status="$?"
    if [[ "$record_status" -eq "$COMMAND_TIMEOUT_STATUS" ]]; then saw_timeout=1; fi
    if [[ -n "${MATRIX_REVISIONS[$matrix_index]}" ]]; then
      if [[ "$require_ready" -eq 0 || "$RECORDED_MATRIX_CELL" -eq 1 ]]; then
        return 0
      fi
    fi
    if [[ "$MATRIX_DISCOVERY_STATE" == "absent" ]]; then
      absent_streak=$((absent_streak + 1))
    else
      absent_streak=0
    fi
    if [[ "$attempt" -lt "$DISCOVERY_MAX_ATTEMPTS" ]]; then
      sleep "$DISCOVERY_INTERVAL_SECONDS"
    fi
  done
  if [[ "$require_ready" -eq 0 && "$absent_streak" -ge "$DISCOVERY_REQUIRED_ABSENT" ]]; then
    return 0
  fi
  if [[ "$saw_timeout" -ne 0 ]]; then return "$COMMAND_TIMEOUT_STATUS"; fi
  return 1
}

cleanup_owned_tag() {
  local tag="$1"
  local expected_revision="$2"
  local expected_generation="$3"
  local service_json=""
  local tag_target=""
  local revision_json=""

  gcloud_read_capture service_json run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json || return "$?"
  tag_target="$(SERVICE_JSON="$service_json" TAG_TO_FIND="$tag" node "$PARSER" tag-state)" || return 1
  if [[ "$tag_target" == "absent" ]]; then return 0; fi
  if [[ -z "$expected_revision" || -z "$IMAGE_REF" || "$tag_target" != "$expected_revision" ]]; then return 1; fi
  gcloud_read_capture revision_json run revisions describe "$expected_revision" \
    --project="$PROJECT" --region="$REGION" --format=json || return "$?"
  SERVICE_JSON="$service_json" \
  REVISION_JSON="$revision_json" \
  TAG_TO_FIND="$tag" \
  EXPECTED_REVISION="$expected_revision" \
  EXPECTED_IMAGE_REF="$IMAGE_REF" \
  EXPECTED_EXECUTION_ENVIRONMENT="$expected_generation" \
  EXPECTED_CONTAINER_CONCURRENCY="40" \
  node "$PARSER" owned-tag >/dev/null || return 1
  gcloud_mutation run services update-traffic "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --remove-tags="$tag" --quiet
}

stabilize_owned_tag_cleanup() {
  local tag="$1"
  local matrix_index="$2"
  local generation="$3"
  local attempt=0
  local absent_streak=0
  local service_json=""
  local tag_target=""
  local record_status=0
  local cleanup_status=0
  local read_status=0
  local tag_status=0
  local owned_observed=0

  if [[ -n "${MATRIX_REVISIONS[$matrix_index]}" ]]; then owned_observed=1; fi

  while [[ "$attempt" -lt "$DISCOVERY_MAX_ATTEMPTS" ]]; do
    attempt=$((attempt + 1))
    if [[ -z "${MATRIX_REVISIONS[$matrix_index]}" ]]; then
      record_status=0
      record_matrix_cell "$generation" "$tag" "$matrix_index" >/dev/null 2>&1 || record_status="$?"
      if [[ "$record_status" -eq 0 && -n "${MATRIX_REVISIONS[$matrix_index]}" ]]; then
        owned_observed=1
      fi
    fi
    cleanup_status=0
    cleanup_owned_tag "$tag" "${MATRIX_REVISIONS[$matrix_index]}" "$generation" \
      >/dev/null 2>&1 || cleanup_status="$?"
    read_status=0
    gcloud_read_capture service_json run services describe "$SERVICE" \
      --project="$PROJECT" --region="$REGION" --format=json || read_status="$?"
    tag_status=0
    if [[ "$read_status" -eq 0 && -n "$service_json" ]]; then
      tag_target="$(SERVICE_JSON="$service_json" TAG_TO_FIND="$tag" node "$PARSER" tag-state)" || tag_status="$?"
    else
      tag_target=""
      tag_status=1
    fi
    if [[ "$tag_status" -eq 0 && "$tag_target" == "absent" ]]; then
      absent_streak=$((absent_streak + 1))
    else
      absent_streak=0
    fi
    if [[ "$attempt" -lt "$DISCOVERY_MAX_ATTEMPTS" ]]; then
      sleep "$DISCOVERY_INTERVAL_SECONDS"
    fi
  done
  test "$absent_streak" -ge "$DISCOVERY_REQUIRED_ABSENT" || return 1
  if [[ "${MATRIX_DEPLOY_UNRESOLVED[$matrix_index]}" -eq 1 ]]; then
    if [[ "$owned_observed" -ne 1 ]]; then return 1; fi
    MATRIX_DEPLOY_UNRESOLVED[$matrix_index]=0
  fi
}

generate_probe_context() {
  CONTEXT_GENERATED=0
  CONTEXT_VALIDATED=0
  rm -f -- "$PROBE_CONTEXT_TMP" "$PROBE_CONTEXT_RUN_PATH" || return 1

  PROJECT_TO_RECORD="$PROJECT" \
  REGION_TO_RECORD="$REGION" \
  SERVICE_TO_RECORD="$SERVICE" \
  PRODUCTION_SERVICE_TO_RECORD="$PRODUCTION_SERVICE" \
  SOURCE_HEAD_TO_RECORD="$SOURCE_HEAD" \
  TESTED_HEAD_TO_RECORD="$TESTED_HEAD" \
  ORIGINAL_REVISION_TO_RECORD="$ORIGINAL_REVISION" \
  IMAGE_DIGEST_TO_RECORD="$DIGEST" \
  LIVE_RUNTIME_STATE_JSON_TO_RECORD="$LIVE_RUNTIME_STATE_JSON" \
  GEN1_REVISION_TO_RECORD="${MATRIX_REVISIONS[0]}" \
  GEN2_REVISION_TO_RECORD="${MATRIX_REVISIONS[1]}" \
  GEN1_LOG_LABELS_SHA256_TO_RECORD="${MATRIX_EXPECTED_LOG_LABELS_SHA256[0]}" \
  GEN1_LOG_LABELS_COUNT_TO_RECORD="${MATRIX_EXPECTED_LOG_LABEL_COUNTS[0]}" \
  GEN2_LOG_LABELS_SHA256_TO_RECORD="${MATRIX_EXPECTED_LOG_LABELS_SHA256[1]}" \
  GEN2_LOG_LABELS_COUNT_TO_RECORD="${MATRIX_EXPECTED_LOG_LABEL_COUNTS[1]}" \
  MATRIX_EXACT_MATCH_TO_RECORD="$MATRIX_EXACT_MATCH" \
  PRODUCTION_DOMAIN_MAPPING_COUNT_TO_RECORD="$PRODUCTION_DOMAIN_MAPPING_COUNT" \
  PRODUCTION_FINGERPRINT_BEFORE_TO_RECORD="$PRODUCTION_FINGERPRINT_BEFORE" \
  CLEANUP_VERIFIED_TO_RECORD="$CLEANUP_VERIFIED" \
  node --input-type=module -e '
    const required = (name) => {
      const value = process.env[name];
      if (typeof value !== "string" || value.length === 0) process.exit(2);
      return value;
    };
    const sourceHead = required("SOURCE_HEAD_TO_RECORD");
    const testedHead = required("TESTED_HEAD_TO_RECORD");
    const imageDigest = required("IMAGE_DIGEST_TO_RECORD");
    const gen1Revision = required("GEN1_REVISION_TO_RECORD");
    const gen2Revision = required("GEN2_REVISION_TO_RECORD");
    const gen1LogLabelsSha256 = required("GEN1_LOG_LABELS_SHA256_TO_RECORD");
    const gen2LogLabelsSha256 = required("GEN2_LOG_LABELS_SHA256_TO_RECORD");
    const gen1LogLabelsCount = Number(required("GEN1_LOG_LABELS_COUNT_TO_RECORD"));
    const gen2LogLabelsCount = Number(required("GEN2_LOG_LABELS_COUNT_TO_RECORD"));
    const matrixExactMatchText = required("MATRIX_EXACT_MATCH_TO_RECORD");
    const productionFingerprintBefore = required("PRODUCTION_FINGERPRINT_BEFORE_TO_RECORD");
    const productionDomainMappingCount = Number(required("PRODUCTION_DOMAIN_MAPPING_COUNT_TO_RECORD"));
    if (required("CLEANUP_VERIFIED_TO_RECORD") !== "1") process.exit(3);
    if (!/^[0-9a-f]{40}$/u.test(sourceHead) || testedHead !== sourceHead) process.exit(4);
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) process.exit(5);
    if (!/^shipmastr-api-staging-[a-z0-9-]+$/u.test(gen1Revision)) process.exit(6);
    if (!/^shipmastr-api-staging-[a-z0-9-]+$/u.test(gen2Revision)) process.exit(6);
    if (!/^[0-9a-f]{64}$/u.test(gen1LogLabelsSha256)) process.exit(6);
    if (!/^[0-9a-f]{64}$/u.test(gen2LogLabelsSha256)) process.exit(6);
    if (!Number.isInteger(gen1LogLabelsCount) || gen1LogLabelsCount < 0 || gen1LogLabelsCount > 64) process.exit(6);
    if (!Number.isInteger(gen2LogLabelsCount) || gen2LogLabelsCount < 0 || gen2LogLabelsCount > 64) process.exit(6);
    if (matrixExactMatchText !== "true" && matrixExactMatchText !== "false") process.exit(7);
    if (!/^[0-9a-f]{64}$/u.test(productionFingerprintBefore)) process.exit(8);
    if (productionDomainMappingCount !== 0) process.exit(9);
    const liveRuntime = JSON.parse(required("LIVE_RUNTIME_STATE_JSON_TO_RECORD"));
    if (
      liveRuntime === null ||
      typeof liveRuntime !== "object" ||
      Array.isArray(liveRuntime) ||
      liveRuntime?.productionActive?.concurrency !== 40
    ) process.exit(10);

    const context = {
      project: required("PROJECT_TO_RECORD"),
      region: required("REGION_TO_RECORD"),
      service: required("SERVICE_TO_RECORD"),
      productionService: required("PRODUCTION_SERVICE_TO_RECORD"),
      sourceHead,
      testedHead,
      originalStagingRevision: required("ORIGINAL_REVISION_TO_RECORD"),
      imageDigest,
      liveRuntime,
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
      },
      productionDomainMappingCount,
      productionFingerprintBefore,
      cleanupVerified: true,
      activeTrafficUnchanged: true,
      featureDisabled: true,
      productionMutated: false
    };
    const serialized = JSON.stringify(context, null, 2);
    if (/https?:\/\//iu.test(serialized)) process.exit(11);
    if (/\b(?:headers?|token|credential|secretRef|body|envList|expectedLabels|labelsJson|canonicalJson)\b/iu.test(serialized)) process.exit(12);
    process.stdout.write(`${serialized}\n`);
  ' > "$PROBE_CONTEXT_TMP" || {
    rm -f -- "$PROBE_CONTEXT_TMP"
    return 1
  }
  CONTEXT_GENERATED=1

  PROBE_CONTEXT_PATH_TO_VERIFY="$PROBE_CONTEXT_TMP" \
  GEN1_REVISION_TO_VERIFY="${MATRIX_REVISIONS[0]}" \
  GEN2_REVISION_TO_VERIFY="${MATRIX_REVISIONS[1]}" \
  GEN1_LOG_LABELS_SHA256_TO_VERIFY="${MATRIX_EXPECTED_LOG_LABELS_SHA256[0]}" \
  GEN1_LOG_LABELS_COUNT_TO_VERIFY="${MATRIX_EXPECTED_LOG_LABEL_COUNTS[0]}" \
  GEN2_LOG_LABELS_SHA256_TO_VERIFY="${MATRIX_EXPECTED_LOG_LABELS_SHA256[1]}" \
  GEN2_LOG_LABELS_COUNT_TO_VERIFY="${MATRIX_EXPECTED_LOG_LABEL_COUNTS[1]}" \
  MATRIX_EXACT_MATCH_TO_VERIFY="$MATRIX_EXACT_MATCH" \
  PRODUCTION_FINGERPRINT_TO_VERIFY="$PRODUCTION_FINGERPRINT_BEFORE" \
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const context = JSON.parse(readFileSync(process.env.PROBE_CONTEXT_PATH_TO_VERIFY, "utf8"));
    const serialized = JSON.stringify(context);
    const gen1Keys = Object.keys(context?.matrix?.gen1 ?? {}).sort().join(",");
    const gen2Keys = Object.keys(context?.matrix?.gen2 ?? {}).sort().join(",");
    if (
      context?.cleanupVerified !== true ||
      context?.productionDomainMappingCount !== 0 ||
      context?.productionFingerprintBefore !== process.env.PRODUCTION_FINGERPRINT_TO_VERIFY ||
      context?.matrix?.concurrency !== 40 ||
      context?.matrix?.gen1?.generation !== "gen1" ||
      context?.matrix?.gen1?.revision !== process.env.GEN1_REVISION_TO_VERIFY ||
      context?.matrix?.gen1?.logLabelsSha256 !== process.env.GEN1_LOG_LABELS_SHA256_TO_VERIFY ||
      String(context?.matrix?.gen1?.logLabelsCount) !== process.env.GEN1_LOG_LABELS_COUNT_TO_VERIFY ||
      gen1Keys !== "generation,logLabelsCount,logLabelsSha256,revision" ||
      context?.matrix?.gen2?.generation !== "gen2" ||
      context?.matrix?.gen2?.revision !== process.env.GEN2_REVISION_TO_VERIFY ||
      context?.matrix?.gen2?.logLabelsSha256 !== process.env.GEN2_LOG_LABELS_SHA256_TO_VERIFY ||
      String(context?.matrix?.gen2?.logLabelsCount) !== process.env.GEN2_LOG_LABELS_COUNT_TO_VERIFY ||
      gen2Keys !== "generation,logLabelsCount,logLabelsSha256,revision" ||
      String(context?.matrix?.exactMatch) !== process.env.MATRIX_EXACT_MATCH_TO_VERIFY ||
      context?.activeTrafficUnchanged !== true ||
      context?.featureDisabled !== true ||
      context?.productionMutated !== false ||
      /https?:\/\//iu.test(serialized) ||
      /\b(?:headers?|token|credential|secretRef|body|envList|expectedLabels|labelsJson|canonicalJson)\b/iu.test(serialized)
    ) process.exit(2);
  ' || {
    rm -f -- "$PROBE_CONTEXT_TMP"
    return 1
  }

  mv "$PROBE_CONTEXT_TMP" "$PROBE_CONTEXT_RUN_PATH" || return 1
  CONTEXT_VALIDATED=1
}

cleanup() {
  local incoming_status="${1:-$?}"
  local cleanup_failed=0
  local current_service_json=""
  local token_state=""
  local tag_g1_after=""
  local tag_g1_status=0
  local tag_g2_after=""
  local tag_g2_status=0
  local PRODUCTION_SERVICE_JSON_AFTER=""
  local PRODUCTION_FINGERPRINT_AFTER=""

  MUTATION_CRITICAL=1
  trap 'latch_signal 130' INT
  trap 'latch_signal 143' TERM
  if [[ "$CLEANUP_DONE" -eq 1 ]]; then
    return "$incoming_status"
  fi
  CLEANUP_DONE=1
  set +e

  if [[ -z "${MATRIX_REVISIONS[0]}" ]]; then
    if [[ "${MATRIX_DEPLOY_ATTEMPTED[0]}" -eq 1 ]]; then
      discover_matrix_cell_stably "gen1" "$TAG_G1" "0" "0" || cleanup_failed=1
    else
      record_matrix_cell "gen1" "$TAG_G1" "0" || cleanup_failed=1
    fi
  fi
  if [[ -z "${MATRIX_REVISIONS[1]}" ]]; then
    if [[ "${MATRIX_DEPLOY_ATTEMPTED[1]}" -eq 1 ]]; then
      discover_matrix_cell_stably "gen2" "$TAG_G2" "1" "0" || cleanup_failed=1
    else
      record_matrix_cell "gen2" "$TAG_G2" "1" || cleanup_failed=1
    fi
  fi
  if [[ "${MATRIX_DEPLOY_ATTEMPTED[0]}" -eq 1 ]]; then
    stabilize_owned_tag_cleanup "$TAG_G1" "0" "gen1" || {
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    }
  fi
  if [[ "${MATRIX_DEPLOY_ATTEMPTED[1]}" -eq 1 ]]; then
    stabilize_owned_tag_cleanup "$TAG_G2" "1" "gen2" || {
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    }
  fi
  cleanup_owned_tag "$TAG_G1" "${MATRIX_REVISIONS[0]}" "gen1" || cleanup_failed=1
  cleanup_owned_tag "$TAG_G2" "${MATRIX_REVISIONS[1]}" "gen2" || cleanup_failed=1
  if [[ "${MATRIX_DEPLOY_UNRESOLVED[0]}" -ne 0 || "${MATRIX_DEPLOY_UNRESOLVED[1]}" -ne 0 ]]; then
    cleanup_failed=1
    REMOTE_CLEANUP_UNRESOLVED=1
  fi

  gcloud_read_capture current_service_json run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json
  if [[ "$?" -ne 0 || -z "$current_service_json" ]]; then
    cleanup_failed=1
    REMOTE_CLEANUP_UNRESOLVED=1
  else
    token_state="$(
      SERVICE_JSON="$current_service_json" EXPECTED_TOKEN="$PROBE_TOKEN" \
      node --input-type=module -e '
        const service = JSON.parse(process.env.SERVICE_JSON ?? "");
        const containers = service?.spec?.template?.spec?.containers;
        if (!Array.isArray(containers) || containers.length !== 1) process.exit(2);
        const env = containers[0]?.env;
        if (env !== undefined && !Array.isArray(env)) process.exit(2);
        const matches = (env ?? []).filter((entry) => entry?.name === "RATE_LIMIT_PROXY_PROBE_TOKEN");
        if (matches.length === 0) {
          process.stdout.write("absent");
        } else if (
          matches.length === 1 &&
          typeof matches[0]?.value === "string" &&
          matches[0].value === process.env.EXPECTED_TOKEN
        ) {
          process.stdout.write("owned");
        } else {
          process.stdout.write("foreign");
        }
      '
    )"
    if [[ "$?" -ne 0 ]]; then
      cleanup_failed=1
    elif [[ "$token_state" == "owned" ]]; then
      gcloud_mutation run services update "$SERVICE" \
        --project="$PROJECT" --region="$REGION" \
        --remove-env-vars=RATE_LIMIT_PROXY_PROBE_TOKEN --no-traffic --quiet
      if [[ "$?" -ne 0 ]]; then
        cleanup_failed=1
        REMOTE_CLEANUP_UNRESOLVED=1
      fi
    elif [[ "$token_state" != "absent" ]]; then
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    fi
  fi

  unset \
    PROBE_TOKEN \
    GEN1_LOGS_JSON GEN2_LOGS_JSON MATRIX_LOGS_JSON \
    GEN1_EXPECTED_LOG_LABELS_JSON GEN2_EXPECTED_LOG_LABELS_JSON
  MATRIX_EXPECTED_LOG_LABELS_JSON=("" "")
  rm -f -- "$EVIDENCE_TMP" "$PROBE_CONTEXT_TMP"
  if [[ "$?" -ne 0 ]]; then
    cleanup_failed=1
  fi

  gcloud_read_capture current_service_json run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json
  if [[ "$?" -ne 0 || -z "$current_service_json" ]]; then
    cleanup_failed=1
    REMOTE_CLEANUP_UNRESOLVED=1
  else
    tag_g1_after="$(
      SERVICE_JSON="$current_service_json" TAG_TO_FIND="$TAG_G1" \
      node "$PARSER" tag-state
    )"
    tag_g1_status="$?"
    tag_g2_after="$(
      SERVICE_JSON="$current_service_json" TAG_TO_FIND="$TAG_G2" \
      node "$PARSER" tag-state
    )"
    tag_g2_status="$?"
    if [[ "$tag_g1_status" -ne 0 || "$tag_g1_after" != "absent" ]]; then
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    fi
    if [[ "$tag_g2_status" -ne 0 || "$tag_g2_after" != "absent" ]]; then
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    fi
    SERVICE_JSON="$current_service_json" \
    ORIGINAL_REVISION_TO_VERIFY="$ORIGINAL_REVISION" \
    node --input-type=module -e '
      const service = JSON.parse(process.env.SERVICE_JSON ?? "");
      const traffic = service?.status?.traffic;
      if (!Array.isArray(traffic)) process.exit(2);
      const positive = traffic.filter((entry) => Number(entry?.percent ?? 0) > 0);
      if (
        positive.length !== 1 ||
        positive[0]?.revisionName !== process.env.ORIGINAL_REVISION_TO_VERIFY ||
        Number(positive[0]?.percent) !== 100
      ) process.exit(3);
      const containers = service?.spec?.template?.spec?.containers;
      if (!Array.isArray(containers) || containers.length !== 1) process.exit(4);
      const env = containers[0]?.env;
      if (env !== undefined && !Array.isArray(env)) process.exit(4);
      const probeTokens = (env ?? []).filter((entry) => entry?.name === "RATE_LIMIT_PROXY_PROBE_TOKEN");
      if (probeTokens.length !== 0) process.exit(5);
      const intake = (env ?? []).filter((entry) => entry?.name === "COURIER_AUDIT_INTAKE_ENABLED");
      if (
        intake.length > 1 ||
        (intake.length === 1 && intake[0]?.value !== "false")
      ) process.exit(6);
    '
    if [[ "$?" -ne 0 ]]; then
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    fi
  fi

  gcloud_read_capture PRODUCTION_SERVICE_JSON_AFTER run services describe "$PRODUCTION_SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json
  if [[ "$?" -ne 0 || -z "$PRODUCTION_SERVICE_JSON_AFTER" ]]; then
    cleanup_failed=1
    REMOTE_CLEANUP_UNRESOLVED=1
  else
    PRODUCTION_FINGERPRINT_AFTER="$(
      SERVICE_JSON="$PRODUCTION_SERVICE_JSON_AFTER" node "$PARSER" production-fingerprint
    )"
    if [[ "$?" -ne 0 ]]; then
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    fi
    if ! test "$PRODUCTION_FINGERPRINT_AFTER" = "$PRODUCTION_FINGERPRINT_BEFORE"; then
      cleanup_failed=1
      REMOTE_CLEANUP_UNRESOLVED=1
    fi
  fi

  if [[ "$ANY_COMMAND_TIMED_OUT" -ne 0 ]]; then
    cleanup_failed=1
  fi

  if [[ "$cleanup_failed" -eq 0 ]]; then
    CLEANUP_VERIFIED=1
  fi

  if [[ "$EVIDENCE_CAPTURED" -eq 1 && "$CLEANUP_VERIFIED" -eq 1 ]]; then
    generate_probe_context || cleanup_failed=1
  fi
  MATRIX_EXPECTED_LOG_LABELS_SHA256=("" "")
  MATRIX_EXPECTED_LOG_LABEL_COUNTS=("" "")

  if [[
    "$cleanup_failed" -eq 0 &&
    "$incoming_status" -eq 0 &&
    "$SIGNAL_STATUS" -eq 0 &&
    "$REMOTE_CLEANUP_UNRESOLVED" -eq 0 &&
    "$EVIDENCE_CAPTURED" -eq 1 &&
    "$CONTEXT_GENERATED" -eq 1 &&
    "$CONTEXT_VALIDATED" -eq 1
  ]]; then
    if mv "$PROBE_RESULTS_RUN_PATH" "$PROBE_RESULTS_PATH"; then
      RESULTS_PROMOTED=1
      ARTIFACTS_PUBLISHED=1
      if mv "$PROBE_CONTEXT_RUN_PATH" "$PROBE_CONTEXT_PATH"; then
        CONTEXT_PROMOTED=1
      else
        cleanup_failed=1
        rollback_published_artifacts || PUBLICATION_ROLLBACK_FAILED=1
      fi
    else
      cleanup_failed=1
      rollback_published_artifacts || PUBLICATION_ROLLBACK_FAILED=1
    fi
  elif [[ "$EVIDENCE_CAPTURED" -eq 0 ]]; then
    rm -f -- "$PROBE_RESULTS_RUN_PATH" "$PROBE_CONTEXT_RUN_PATH"
    if [[ "$?" -ne 0 ]]; then cleanup_failed=1; fi
  else
    rm -f -- "$PROBE_CONTEXT_RUN_PATH"
    if [[ "$?" -ne 0 ]]; then cleanup_failed=1; fi
  fi

  if [[ "$SIGNAL_STATUS" -ne 0 && "$ARTIFACTS_PUBLISHED" -eq 1 ]]; then
    rollback_published_artifacts || PUBLICATION_ROLLBACK_FAILED=1
  fi

  if ! cleanup_command_tmp; then
    cleanup_failed=1
    REMOTE_CLEANUP_UNRESOLVED=1
  fi

  if [[ "$PUBLICATION_ROLLBACK_FAILED" -eq 0 && "$REMOTE_CLEANUP_UNRESOLVED" -eq 0 ]]; then
    if ! release_operator_lock; then
      cleanup_failed=1
      if [[ "$ARTIFACTS_PUBLISHED" -eq 1 ]]; then
        rollback_published_artifacts || PUBLICATION_ROLLBACK_FAILED=1
      fi
    fi
  fi
  if [[ "$PUBLICATION_ROLLBACK_FAILED" -ne 0 ]]; then
    cleanup_failed=1
  fi
  if [[ "$REMOTE_CLEANUP_UNRESOLVED" -ne 0 ]]; then
    cleanup_failed=1
  fi

  local final_status="$incoming_status"
  if [[ "$SIGNAL_STATUS" -ne 0 ]]; then
    final_status="$SIGNAL_STATUS"
  elif [[ "$cleanup_failed" -ne 0 && "$final_status" -eq 0 ]]; then
    if [[ "$ANY_COMMAND_TIMED_OUT" -ne 0 ]]; then
      final_status="$COMMAND_TIMEOUT_STATUS"
    else
      final_status=1
    fi
  fi
  set -e
  trap on_int INT
  trap on_term TERM
  MUTATION_CRITICAL=0
  if [[ "$SIGNAL_STATUS" -ne 0 ]]; then
    final_status="$SIGNAL_STATUS"
  fi
  return "$final_status"
}

on_exit() {
  local status="$?"
  MUTATION_CRITICAL=1
  trap - EXIT
  if cleanup "$status"; then
    status=0
  else
    status="$?"
  fi
  exit "$status"
}

on_int() {
  latch_signal 130
  if [[ "$MUTATION_CRITICAL" -eq 0 ]]; then
    exit "$SIGNAL_STATUS"
  fi
}

on_term() {
  latch_signal 143
  if [[ "$MUTATION_CRITICAL" -eq 0 ]]; then
    exit "$SIGNAL_STATUS"
  fi
}

deploy_matrix_cell() {
  local generation="$1"
  local tag="$2"
  local matrix_index=""
  local deploy_status=0
  local record_status=0

  if [[ "$generation" == "gen1" && "$tag" == "$TAG_G1" ]]; then
    matrix_index="0"
  elif [[ "$generation" == "gen2" && "$tag" == "$TAG_G2" ]]; then
    matrix_index="1"
  else
    return 1
  fi

  MATRIX_DEPLOY_ATTEMPTED[$matrix_index]=1
  MATRIX_DEPLOY_UNRESOLVED[$matrix_index]=1
  MUTATION_CRITICAL=1
  gcloud_deploy run deploy "$SERVICE" \
    --project="$PROJECT" \
    --region="$REGION" \
    --image="$IMAGE_REF" \
    --execution-environment="$generation" \
    --concurrency=40 \
    --update-env-vars="COURIER_AUDIT_INTAKE_ENABLED=false,RATE_LIMIT_PROXY_PROBE_TOKEN=$PROBE_TOKEN" \
    --no-traffic \
    --tag="$tag" \
    --quiet || deploy_status="$?"

  discover_matrix_cell_stably "$generation" "$tag" "$matrix_index" "1" || record_status="$?"
  MUTATION_CRITICAL=0
  if [[ "$SIGNAL_STATUS" -ne 0 ]]; then
    return "$SIGNAL_STATUS"
  fi
  if [[ "$deploy_status" -ne 0 ]]; then
    return "$deploy_status"
  fi
  if [[ "$record_status" -ne 0 ]]; then return "$record_status"; fi
  if [[ "$RECORDED_MATRIX_CELL" -ne 1 ]]; then return 1; fi
  MATRIX_DEPLOY_UNRESOLVED[$matrix_index]=0
}

run_five_cases() {
  local tag_url="$1"

  BASELINE_RESULT="$(curl -sS --connect-timeout="$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time="$CURL_TOTAL_TIMEOUT_SECONDS" -o /dev/null -w 'baseline=%{http_code}\n' \
    -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
    -H 'x-shipmastr-rate-limit-probe-case: baseline' \
    "$tag_url/api/health")"
  test "$BASELINE_RESULT" = "baseline=200"
  printf '%s\n' "$BASELINE_RESULT"

  FORWARDED_IPV4_RESULT="$(curl -sS --connect-timeout="$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time="$CURL_TOTAL_TIMEOUT_SECONDS" -o /dev/null -w 'forwarded_ipv4=%{http_code}\n' \
    -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
    -H 'x-shipmastr-rate-limit-probe-case: forwarded-ipv4' \
    -H 'Forwarded: for=192.0.2.10' \
    "$tag_url/api/health")"
  test "$FORWARDED_IPV4_RESULT" = "forwarded_ipv4=200"
  printf '%s\n' "$FORWARDED_IPV4_RESULT"

  XFF_IPV4_RESULT="$(curl -sS --connect-timeout="$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time="$CURL_TOTAL_TIMEOUT_SECONDS" -o /dev/null -w 'xff_ipv4=%{http_code}\n' \
    -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
    -H 'x-shipmastr-rate-limit-probe-case: xff-ipv4' \
    -H 'X-Forwarded-For: 198.51.100.20' \
    "$tag_url/api/health")"
  test "$XFF_IPV4_RESULT" = "xff_ipv4=200"
  printf '%s\n' "$XFF_IPV4_RESULT"

  BOTH_IPV4_RESULT="$(curl -sS --connect-timeout="$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time="$CURL_TOTAL_TIMEOUT_SECONDS" -o /dev/null -w 'both_ipv4=%{http_code}\n' \
    -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
    -H 'x-shipmastr-rate-limit-probe-case: both-ipv4' \
    -H 'Forwarded: for=192.0.2.30' \
    -H 'X-Forwarded-For: 198.51.100.40' \
    "$tag_url/api/health")"
  test "$BOTH_IPV4_RESULT" = "both_ipv4=200"
  printf '%s\n' "$BOTH_IPV4_RESULT"

  BOTH_IPV6_RESULT="$(curl -sS --connect-timeout="$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time="$CURL_TOTAL_TIMEOUT_SECONDS" -o /dev/null -w 'both_ipv6=%{http_code}\n' \
    -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
    -H 'x-shipmastr-rate-limit-probe-case: both-ipv6' \
    -H 'Forwarded: for="[2001:db8::1]"' \
    -H 'X-Forwarded-For: 2001:db8::2' \
    "$tag_url/api/health")"
  test "$BOTH_IPV6_RESULT" = "both_ipv6=200"
  printf '%s\n' "$BOTH_IPV6_RESULT"
}

trap on_exit EXIT
trap on_int INT
trap on_term TERM

gcloud_build builds submit . \
  --project="$PROJECT" \
  --region="$REGION" \
  --tag="$IMAGE_URI:$IMAGE_TAG" \
  --quiet
DIGEST=""
gcloud_read_capture DIGEST artifacts docker images describe "$IMAGE_URI:$IMAGE_TAG" \
  --project="$PROJECT" --format='value(image_summary.digest)'
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
IMAGE_REF="$IMAGE_URI@$DIGEST"

deploy_matrix_cell "gen1" "$TAG_G1"
MATRIX_REVISIONS[0]="$DEPLOYED_TAG_REVISION"
MATRIX_URLS[0]="$DEPLOYED_TAG_URL"
run_five_cases "${MATRIX_URLS[0]}"

deploy_matrix_cell "gen2" "$TAG_G2"
MATRIX_REVISIONS[1]="$DEPLOYED_TAG_REVISION"
MATRIX_URLS[1]="$DEPLOYED_TAG_URL"
run_five_cases "${MATRIX_URLS[1]}"

GEN1_LOGS_JSON=""
gcloud_read_capture GEN1_LOGS_JSON logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"${MATRIX_REVISIONS[0]}\" AND jsonPayload.eventName=\"rate_limit_proxy_probe\"" \
  --project="$PROJECT" --freshness=30m --order=asc --limit=20 --format=json
GEN2_LOGS_JSON=""
gcloud_read_capture GEN2_LOGS_JSON logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"${MATRIX_REVISIONS[1]}\" AND jsonPayload.eventName=\"rate_limit_proxy_probe\"" \
  --project="$PROJECT" --freshness=30m --order=asc --limit=20 --format=json
MATRIX_LOGS_JSON="$(GEN1_LOGS_JSON="$GEN1_LOGS_JSON" GEN2_LOGS_JSON="$GEN2_LOGS_JSON" \
  node --input-type=module -e 'process.stdout.write(JSON.stringify({gen1:JSON.parse(process.env.GEN1_LOGS_JSON),gen2:JSON.parse(process.env.GEN2_LOGS_JSON)}))')"
MATRIX_LOGS_JSON="$MATRIX_LOGS_JSON" \
PROBE_TOKEN_FOR_LEAK_CHECK="$PROBE_TOKEN" \
GEN1_REVISION="${MATRIX_REVISIONS[0]}" \
GEN2_REVISION="${MATRIX_REVISIONS[1]}" \
GEN1_EXPECTED_LOG_LABELS_JSON="${MATRIX_EXPECTED_LOG_LABELS_JSON[0]}" \
GEN2_EXPECTED_LOG_LABELS_JSON="${MATRIX_EXPECTED_LOG_LABELS_JSON[1]}" \
node scripts/rate-limit-proxy-probe-evidence.mjs assemble > "$EVIDENCE_TMP"
mv "$EVIDENCE_TMP" "$PROBE_RESULTS_RUN_PATH"
EVIDENCE_CAPTURED=1
unset GEN1_LOGS_JSON GEN2_LOGS_JSON MATRIX_LOGS_JSON

MATRIX_EXACT_MATCH="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const evidence=JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (typeof evidence?.comparison?.exactMatch!=="boolean") process.exit(2);
  process.stdout.write(String(evidence.comparison.exactMatch));
' "$(pwd)/$PROBE_RESULTS_RUN_PATH")"

if cleanup 0; then
  :
else
  cleanup_status="$?"
  exit "$cleanup_status"
fi
trap - EXIT INT TERM

PROBE_CONTEXT_PATH_TO_VERIFY="$PROBE_CONTEXT_PATH" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const context = JSON.parse(readFileSync(process.env.PROBE_CONTEXT_PATH_TO_VERIFY, "utf8"));
  const serialized = JSON.stringify(context);
  const validCell = (cell, generation) =>
    cell?.generation === generation &&
    /^shipmastr-api-staging-[a-z0-9-]+$/u.test(cell?.revision ?? "") &&
    /^[0-9a-f]{64}$/u.test(cell?.logLabelsSha256 ?? "") &&
    Number.isInteger(cell?.logLabelsCount) &&
    cell.logLabelsCount >= 0 &&
    cell.logLabelsCount <= 64 &&
    Object.keys(cell).sort().join(",") === "generation,logLabelsCount,logLabelsSha256,revision";
  if (
    context?.cleanupVerified !== true ||
    context?.productionDomainMappingCount !== 0 ||
    context?.productionFingerprintBefore === undefined ||
    context?.matrix?.concurrency !== 40 ||
    !validCell(context?.matrix?.gen1, "gen1") ||
    !validCell(context?.matrix?.gen2, "gen2") ||
    typeof context?.matrix?.exactMatch !== "boolean" ||
    context?.activeTrafficUnchanged !== true ||
    context?.featureDisabled !== true ||
    context?.productionMutated !== false ||
    /\b(?:expectedLabels|labelsJson|canonicalJson)\b/iu.test(serialized)
  ) process.exit(2);
'

test "$MATRIX_EXACT_MATCH" = "true"

printf '%s\n' \
  'PROBE_COMPLETE' \
  "evidence=$EVIDENCE_DIR/probe-results.json" \
  'active_staging_revision_unchanged=true' \
  'production_mutated=false' \
  'feature_enabled=false'
