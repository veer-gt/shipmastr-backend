#!/usr/bin/env bash
set -Eeuo pipefail

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

PROJECT="shipmastr-core-prod"
REGION="asia-south1"
SERVICE="shipmastr-api-staging"
PRODUCTION_SERVICE="shipmastr-api"
EXPECTED_BASE="a965f4314d7af02dc45c05733efaea322acb87eb"
BRANCH="hotfix/rate-limit-proxy-probe"
IMAGE_URI="asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api"
EVIDENCE_DIR=".superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe"
PARSER="scripts/rate-limit-proxy-probe-parsers.mjs"

for required_command in git gcloud node openssl curl date mv rm; do
  command -v "$required_command" >/dev/null 2>&1
done
test -f "$PARSER"

test "$(git branch --show-current)" = "$BRANCH"
test "$(git merge-base HEAD "$EXPECTED_BASE")" = "$EXPECTED_BASE"
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=normal)"
test "$(gcloud config get-value project 2>/dev/null)" = "$PROJECT"
test -d "$EVIDENCE_DIR"
test ! -e "$EVIDENCE_DIR/probe-results.json"
test ! -e "$EVIDENCE_DIR/probe-context.json"
SOURCE_HEAD="$(git rev-parse HEAD)"
[[ "$SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]]
TESTED_HEAD="$SOURCE_HEAD"

STAGING_SERVICE_JSON="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"

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

ORIGINAL_REVISION_JSON="$(gcloud run revisions describe "$ORIGINAL_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json)"

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

PRODUCTION_SERVICE_JSON="$(gcloud run services describe "$PRODUCTION_SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"

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
PRODUCTION_REVISION_JSON="$(gcloud run revisions describe "$PRODUCTION_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json)"

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

DOMAIN_MAPPINGS_JSON="$(gcloud beta run domain-mappings list \
  --project="$PROJECT" --region="$REGION" --format=json)"

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
PROBE_CONTEXT_PATH="$EVIDENCE_DIR/probe-context.json"
PROBE_CONTEXT_TMP="$EVIDENCE_DIR/.probe-context-$RUN_ID.tmp"
test ! -e "$EVIDENCE_TMP"
test ! -e "$PROBE_CONTEXT_TMP"
MATRIX_GENERATIONS=("gen1" "gen2")
MATRIX_TAGS=("$TAG_G1" "$TAG_G2")
MATRIX_REVISIONS=("" "")
MATRIX_URLS=("" "")
IMAGE_REF=""
EVIDENCE_CAPTURED=0
CLEANUP_DONE=0

# Compatibility aliases for the single-generation body replaced in Task 4.
TAG="$TAG_G1"
TAG_REVISION=""

cleanup() {
  local incoming_status="${1:-$?}"
  local cleanup_failed=0
  local current_service_json=""
  local token_state=""
  local tag_target=""
  local tag_state_status=0
  local owned_revision_json=""
  local ownership_state=""

  if [[ "$CLEANUP_DONE" -eq 1 ]]; then
    return "$incoming_status"
  fi
  CLEANUP_DONE=1
  trap '' INT TERM
  set +e

  current_service_json="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json)"
  if [[ "$?" -ne 0 || -z "$current_service_json" ]]; then
    cleanup_failed=1
  else
    tag_target="$(
      SERVICE_JSON="$current_service_json" \
      TAG_TO_FIND="$TAG" \
      node "$PARSER" tag-state
    )"
    tag_state_status="$?"
    if [[ "$tag_state_status" -ne 0 ]]; then
      cleanup_failed=1
    elif [[ "$tag_target" != "absent" ]]; then
      if [[ -z "$TAG_REVISION" || -z "$IMAGE_REF" || "$tag_target" != "$TAG_REVISION" ]]; then
        cleanup_failed=1
      else
        owned_revision_json="$(gcloud run revisions describe "$TAG_REVISION" \
          --project="$PROJECT" --region="$REGION" --format=json)"
        if [[ "$?" -ne 0 || -z "$owned_revision_json" ]]; then
          cleanup_failed=1
        else
          ownership_state="$(
            SERVICE_JSON="$current_service_json" \
            REVISION_JSON="$owned_revision_json" \
            TAG_TO_FIND="$TAG" \
            EXPECTED_REVISION="$TAG_REVISION" \
            EXPECTED_IMAGE_REF="$IMAGE_REF" \
            node "$PARSER" owned-tag
          )"
          if [[ "$?" -ne 0 || "$ownership_state" != "owned" ]]; then
            cleanup_failed=1
          else
            gcloud run services update-traffic "$SERVICE" \
              --project="$PROJECT" --region="$REGION" \
              --remove-tags="$TAG" --quiet
            if [[ "$?" -ne 0 ]]; then
              cleanup_failed=1
            fi
          fi
        fi
      fi
    fi
  fi

  current_service_json="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json)"
  if [[ "$?" -ne 0 || -z "$current_service_json" ]]; then
    cleanup_failed=1
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
      gcloud run services update "$SERVICE" \
        --project="$PROJECT" --region="$REGION" \
        --remove-env-vars=RATE_LIMIT_PROXY_PROBE_TOKEN --no-traffic --quiet
      if [[ "$?" -ne 0 ]]; then
        cleanup_failed=1
      fi
    elif [[ "$token_state" != "absent" ]]; then
      cleanup_failed=1
    fi
  fi

  unset PROBE_TOKEN
  rm -f -- "$EVIDENCE_TMP"
  if [[ "$?" -ne 0 ]]; then
    cleanup_failed=1
  fi

  current_service_json="$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT" --region="$REGION" --format=json)"
  if [[ "$?" -ne 0 || -z "$current_service_json" ]]; then
    cleanup_failed=1
  else
    SERVICE_JSON="$current_service_json" \
    ORIGINAL_REVISION_TO_VERIFY="$ORIGINAL_REVISION" \
    TAG_TO_VERIFY="$TAG" \
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
      if (traffic.some((entry) => entry?.tag === process.env.TAG_TO_VERIFY)) process.exit(4);
      const containers = service?.spec?.template?.spec?.containers;
      if (!Array.isArray(containers) || containers.length !== 1) process.exit(5);
      const env = containers[0]?.env;
      if (env !== undefined && !Array.isArray(env)) process.exit(5);
      const probeTokens = (env ?? []).filter((entry) => entry?.name === "RATE_LIMIT_PROXY_PROBE_TOKEN");
      if (probeTokens.length !== 0) process.exit(6);
      const intake = (env ?? []).filter((entry) => entry?.name === "COURIER_AUDIT_INTAKE_ENABLED");
      if (
        intake.length > 1 ||
        (intake.length === 1 && intake[0]?.value !== "false")
      ) process.exit(7);
    '
    if [[ "$?" -ne 0 ]]; then
      cleanup_failed=1
    fi
  fi

  if [[ "$incoming_status" -eq 0 && "$cleanup_failed" -eq 0 ]]; then
    mv "$PROBE_CONTEXT_TMP" "$PROBE_CONTEXT_PATH"
    if [[ "$?" -ne 0 ]]; then
      cleanup_failed=1
      rm -f -- "$PROBE_CONTEXT_TMP"
    fi
  else
    rm -f -- "$PROBE_CONTEXT_TMP"
    if [[ "$?" -ne 0 ]]; then
      cleanup_failed=1
    fi
  fi

  local final_status="$incoming_status"
  if [[ "$cleanup_failed" -ne 0 && "$final_status" -eq 0 ]]; then
    final_status=1
  fi
  set -e
  return "$final_status"
}

on_exit() {
  local status="$?"
  trap - EXIT INT TERM
  if cleanup "$status"; then
    status=0
  else
    status="$?"
  fi
  exit "$status"
}

on_int() {
  exit 130
}

on_term() {
  exit 143
}

trap on_exit EXIT
trap on_int INT
trap on_term TERM

gcloud builds submit . \
  --project="$PROJECT" \
  --region="$REGION" \
  --tag="$IMAGE_URI:$IMAGE_TAG" \
  --quiet
DIGEST="$(gcloud artifacts docker images describe "$IMAGE_URI:$IMAGE_TAG" \
  --project="$PROJECT" --format='value(image_summary.digest)')"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
IMAGE_REF="$IMAGE_URI@$DIGEST"

gcloud run deploy "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_REF" \
  --update-env-vars="COURIER_AUDIT_INTAKE_ENABLED=false,RATE_LIMIT_PROXY_PROBE_TOKEN=$PROBE_TOKEN" \
  --no-traffic \
  --tag="$TAG" \
  --quiet

DEPLOYED_SERVICE_JSON="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"
TAG_BINDING_OUTPUT="$(
  SERVICE_JSON="$DEPLOYED_SERVICE_JSON" \
  TAG_TO_VERIFY="$TAG" \
  ORIGINAL_REVISION_TO_VERIFY="$ORIGINAL_REVISION" \
  node --input-type=module -e '
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
)"
read_fields "$TAG_BINDING_OUTPUT"
TAG_BINDING=("${READ_FIELDS[@]}")
test "${#TAG_BINDING[@]}" -eq 2
TAG_REVISION="${TAG_BINDING[0]}"
TAG_URL="${TAG_BINDING[1]}"

TAG_REVISION_JSON="$(gcloud run revisions describe "$TAG_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json)"
REVISION_JSON="$TAG_REVISION_JSON" \
EXPECTED_IMAGE_REF="$IMAGE_REF" \
EXPECTED_TOKEN="$PROBE_TOKEN" \
EXPECTED_EXECUTION_ENVIRONMENT="$STAGING_TEMPLATE_EXECUTION_ENVIRONMENT" \
EXPECTED_CONTAINER_CONCURRENCY="$STAGING_TEMPLATE_CONTAINER_CONCURRENCY" \
node --input-type=module -e '
  const revision = JSON.parse(process.env.REVISION_JSON ?? "");
  const containers = revision?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) process.exit(2);
  if (containers[0]?.image !== process.env.EXPECTED_IMAGE_REF) process.exit(3);
  const executionEnvironment =
    revision?.metadata?.annotations?.["run.googleapis.com/execution-environment"];
  if (String(executionEnvironment ?? "") !== process.env.EXPECTED_EXECUTION_ENVIRONMENT) process.exit(4);
  if (String(revision?.spec?.containerConcurrency ?? "") !== process.env.EXPECTED_CONTAINER_CONCURRENCY) {
    process.exit(5);
  }
  const env = Array.isArray(containers[0]?.env) ? containers[0].env : [];
  const exactValue = (name, value) => {
    const matches = env.filter((entry) => entry?.name === name);
    return matches.length === 1 && matches[0]?.value === value;
  };
  if (!exactValue("COURIER_AUDIT_INTAKE_ENABLED", "false")) process.exit(6);
  if (!exactValue("RATE_LIMIT_PROXY_PROBE_TOKEN", process.env.EXPECTED_TOKEN)) process.exit(7);
'

require_http_status() {
  local expected_status="$1"
  shift
  local actual_status
  actual_status="$(curl -sS -o /dev/null -w '%{http_code}' "$@")"
  test "$actual_status" = "$expected_status"
}

require_http_status 200 "$ORIGINAL_STAGING_URL/api/health"
require_http_status 404 \
  -X POST -H 'content-type: application/json' --data '{}' \
  "$ORIGINAL_STAGING_URL/api/v1/integrations/intakes/courier-audit"
require_http_status 200 "$TAG_URL/api/health"
require_http_status 404 \
  -X POST -H 'content-type: application/json' --data '{}' \
  "$TAG_URL/api/v1/integrations/intakes/courier-audit"

BASELINE_RESULT="$(curl -sS -o /dev/null -w 'baseline=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: baseline' \
  "$TAG_URL/api/health")"
test "$BASELINE_RESULT" = "baseline=200"
printf '%s\n' "$BASELINE_RESULT"

FORWARDED_IPV4_RESULT="$(curl -sS -o /dev/null -w 'forwarded_ipv4=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: forwarded-ipv4' \
  -H 'Forwarded: for=192.0.2.10' \
  "$TAG_URL/api/health")"
test "$FORWARDED_IPV4_RESULT" = "forwarded_ipv4=200"
printf '%s\n' "$FORWARDED_IPV4_RESULT"

XFF_IPV4_RESULT="$(curl -sS -o /dev/null -w 'xff_ipv4=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: xff-ipv4' \
  -H 'X-Forwarded-For: 198.51.100.20' \
  "$TAG_URL/api/health")"
test "$XFF_IPV4_RESULT" = "xff_ipv4=200"
printf '%s\n' "$XFF_IPV4_RESULT"

BOTH_IPV4_RESULT="$(curl -sS -o /dev/null -w 'both_ipv4=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: both-ipv4' \
  -H 'Forwarded: for=192.0.2.30' \
  -H 'X-Forwarded-For: 198.51.100.40' \
  "$TAG_URL/api/health")"
test "$BOTH_IPV4_RESULT" = "both_ipv4=200"
printf '%s\n' "$BOTH_IPV4_RESULT"

BOTH_IPV6_RESULT="$(curl -sS -o /dev/null -w 'both_ipv6=%{http_code}\n' \
  -H "x-shipmastr-rate-limit-probe-token: $PROBE_TOKEN" \
  -H 'x-shipmastr-rate-limit-probe-case: both-ipv6' \
  -H 'Forwarded: for="[2001:db8::1]"' \
  -H 'X-Forwarded-For: 2001:db8::2' \
  "$TAG_URL/api/health")"
test "$BOTH_IPV6_RESULT" = "both_ipv6=200"
printf '%s\n' "$BOTH_IPV6_RESULT"

gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$TAG_REVISION\" AND jsonPayload.eventName=\"rate_limit_proxy_probe\"" \
  --project="$PROJECT" \
  --freshness=30m \
  --order=asc \
  --limit=20 \
  --format=json | \
PROBE_TOKEN_TO_VERIFY="$PROBE_TOKEN" \
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { isIP } from "node:net";

  const evidence = JSON.parse(readFileSync(0, "utf8"));
  const expectedCases = ["baseline", "forwarded-ipv4", "xff-ipv4", "both-ipv4", "both-ipv6"];
  const structuralKeys = [
    "eventName",
    "probeCase",
    "path",
    "forwardedPresent",
    "forwardedParseStatus",
    "forwardedElementCount",
    "forwardedMarkerPosition",
    "xForwardedForPresent",
    "xForwardedForElementCount",
    "xForwardedForMarkerPosition",
    "reqIpEqualsSocket",
    "reqIpXForwardedForPosition",
    "socketXForwardedForPosition",
  ];
  const ordinaryPayloadKeys = ["hostname", "level", "msg", "pid", "time"];
  const ordinaryEnvelopeKeys = new Set([
    "errorGroups",
    "httpRequest",
    "insertId",
    "jsonPayload",
    "labels",
    "logName",
    "operation",
    "receiveTimestamp",
    "resource",
    "severity",
    "sourceLocation",
    "spanId",
    "split",
    "timestamp",
    "trace",
    "traceSampled",
  ]);
  const nullableCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
  const nullablePosition = (value) => value === null || (Number.isInteger(value) && value >= 1);
  const forbiddenKeys = new Set([
    "authorization",
    "clientip",
    "cookie",
    "forwarded",
    "headers",
    "httprequest",
    "rawheaders",
    "remoteip",
    "serverip",
    "x-forwarded-for",
    "x-shipmastr-rate-limit-probe-token",
  ]);
  const containsIpAddress = (value) => {
    const ipv4Candidates = value.match(/(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?=$|[^0-9])/gu) ?? [];
    if (ipv4Candidates.some((candidate) =>
      isIP(candidate.replace(/^[^0-9]+|[^0-9]+$/gu, "")) === 4
    )) return true;
    const addressCandidates = value.match(/[0-9a-f:.%\[\]]+/giu) ?? [];
    return addressCandidates.some((candidate) => {
      const normalized = candidate.replace(/^\[|\]$/gu, "").split("%", 1)[0];
      return isIP(normalized) === 6;
    });
  };
  const containsSensitiveMaterial = (value) => {
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return (
        normalized.includes((process.env.PROBE_TOKEN_TO_VERIFY ?? "").toLowerCase()) ||
        /(?:^|[^a-z0-9-])x-forwarded-for\s*:/iu.test(value) ||
        /(?:^|[^a-z0-9-])forwarded\s*:/iu.test(value) ||
        /(?:^|[^a-z0-9-])for\s*=/iu.test(value) ||
        containsIpAddress(value)
      );
    }
    if (Array.isArray(value)) return value.some(containsSensitiveMaterial);
    if (value === null || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
      forbiddenKeys.has(key.toLowerCase()) || containsSensitiveMaterial(child)
    );
  };

  if (!Array.isArray(evidence) || evidence.length !== 5) process.exit(2);
  if (containsSensitiveMaterial(evidence)) process.exit(3);
  evidence.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) process.exit(4);
    if (Object.keys(entry).some((key) => !ordinaryEnvelopeKeys.has(key))) process.exit(5);
    const payload = entry.jsonPayload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) process.exit(6);
    const payloadKeys = Object.keys(payload).sort();
    const allowedPayloadKeys = [...structuralKeys, ...ordinaryPayloadKeys].sort();
    if (payloadKeys.some((key) => !allowedPayloadKeys.includes(key))) process.exit(7);
    if (structuralKeys.some((key) => !Object.hasOwn(payload, key))) process.exit(8);
    if (payload.msg !== undefined && payload.msg !== "rate limit proxy probe") process.exit(9);
    if (payload.eventName !== "rate_limit_proxy_probe") process.exit(10);
    if (payload.probeCase !== expectedCases[index]) process.exit(11);
    if (payload.path !== "/api/health") process.exit(12);
    if (typeof payload.forwardedPresent !== "boolean") process.exit(13);
    if (!["absent", "simple", "quoted", "malformed"].includes(payload.forwardedParseStatus)) process.exit(14);
    if (!nullableCount(payload.forwardedElementCount)) process.exit(15);
    if (!nullablePosition(payload.forwardedMarkerPosition)) process.exit(16);
    if (typeof payload.xForwardedForPresent !== "boolean") process.exit(17);
    if (!Number.isInteger(payload.xForwardedForElementCount) || payload.xForwardedForElementCount < 0) process.exit(18);
    if (!nullablePosition(payload.xForwardedForMarkerPosition)) process.exit(19);
    if (typeof payload.reqIpEqualsSocket !== "boolean") process.exit(20);
    if (!nullablePosition(payload.reqIpXForwardedForPosition)) process.exit(21);
    if (!nullablePosition(payload.socketXForwardedForPosition)) process.exit(22);
  });

  const projected = evidence.map(({ jsonPayload }) => Object.fromEntries(
    structuralKeys.map((key) => [key, jsonPayload[key]])
  ));
  const projectedKeys = structuralKeys.slice().sort();
  if (projected.some((event) => {
    const keys = Object.keys(event).sort();
    return keys.length !== projectedKeys.length || keys.some((key, index) => key !== projectedKeys[index]);
  })) process.exit(23);
  if (containsSensitiveMaterial(projected)) process.exit(24);
  process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
' > "$EVIDENCE_TMP"
mv "$EVIDENCE_TMP" "$EVIDENCE_DIR/probe-results.json"

PROJECT_TO_RECORD="$PROJECT" \
REGION_TO_RECORD="$REGION" \
SERVICE_TO_RECORD="$SERVICE" \
PRODUCTION_SERVICE_TO_RECORD="$PRODUCTION_SERVICE" \
SOURCE_HEAD_TO_RECORD="$SOURCE_HEAD" \
TESTED_HEAD_TO_RECORD="$TESTED_HEAD" \
ORIGINAL_REVISION_TO_RECORD="$ORIGINAL_REVISION" \
IMAGE_DIGEST_TO_RECORD="$DIGEST" \
TAGGED_REVISION_TO_RECORD="$TAG_REVISION" \
STAGING_TEMPLATE_EXECUTION_ENVIRONMENT_TO_RECORD="$STAGING_TEMPLATE_EXECUTION_ENVIRONMENT" \
STAGING_ACTIVE_EXECUTION_ENVIRONMENT_TO_RECORD="$STAGING_ACTIVE_EXECUTION_ENVIRONMENT" \
PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT_TO_RECORD="$PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT" \
STAGING_TEMPLATE_CONTAINER_CONCURRENCY_TO_RECORD="$STAGING_TEMPLATE_CONTAINER_CONCURRENCY" \
STAGING_ACTIVE_CONTAINER_CONCURRENCY_TO_RECORD="$STAGING_ACTIVE_CONTAINER_CONCURRENCY" \
PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY_TO_RECORD="$PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY" \
PRODUCTION_DOMAIN_MAPPING_COUNT_TO_RECORD="$PRODUCTION_DOMAIN_MAPPING_COUNT" \
node --input-type=module -e '
  const required = (name) => {
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0) process.exit(2);
    return value;
  };
  const sourceHead = required("SOURCE_HEAD_TO_RECORD");
  const testedHead = required("TESTED_HEAD_TO_RECORD");
  const imageDigest = required("IMAGE_DIGEST_TO_RECORD");
  const stagingTemplateExecutionEnvironment = required("STAGING_TEMPLATE_EXECUTION_ENVIRONMENT_TO_RECORD");
  const stagingExecutionEnvironment = required("STAGING_ACTIVE_EXECUTION_ENVIRONMENT_TO_RECORD");
  const productionExecutionEnvironment = required("PRODUCTION_ACTIVE_EXECUTION_ENVIRONMENT_TO_RECORD");
  const stagingTemplateContainerConcurrency = required("STAGING_TEMPLATE_CONTAINER_CONCURRENCY_TO_RECORD");
  const stagingContainerConcurrency = required("STAGING_ACTIVE_CONTAINER_CONCURRENCY_TO_RECORD");
  const productionContainerConcurrency = required("PRODUCTION_ACTIVE_CONTAINER_CONCURRENCY_TO_RECORD");
  const productionDomainMappingCount = Number(required("PRODUCTION_DOMAIN_MAPPING_COUNT_TO_RECORD"));
  if (!/^[0-9a-f]{40}$/u.test(sourceHead) || testedHead !== sourceHead) process.exit(3);
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) process.exit(4);
  if (
    stagingTemplateExecutionEnvironment !== stagingExecutionEnvironment ||
    stagingTemplateExecutionEnvironment !== productionExecutionEnvironment
  ) process.exit(5);
  if (
    stagingTemplateContainerConcurrency !== stagingContainerConcurrency ||
    stagingTemplateContainerConcurrency !== productionContainerConcurrency
  ) process.exit(6);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(stagingTemplateContainerConcurrency)) process.exit(7);
  if (productionDomainMappingCount !== 0) process.exit(8);

  const context = {
    project: required("PROJECT_TO_RECORD"),
    region: required("REGION_TO_RECORD"),
    service: required("SERVICE_TO_RECORD"),
    productionService: required("PRODUCTION_SERVICE_TO_RECORD"),
    sourceHead,
    testedHead,
    originalStagingRevision: required("ORIGINAL_REVISION_TO_RECORD"),
    imageDigest,
    taggedRevision: required("TAGGED_REVISION_TO_RECORD"),
    runtimeParity: {
      stagingTemplateExecutionEnvironment,
      stagingExecutionEnvironment,
      productionExecutionEnvironment,
      taggedExecutionEnvironment: stagingTemplateExecutionEnvironment,
      executionEnvironmentEqual: true,
      stagingTemplateContainerConcurrency: Number(stagingTemplateContainerConcurrency),
      stagingContainerConcurrency: Number(stagingContainerConcurrency),
      productionContainerConcurrency: Number(productionContainerConcurrency),
      taggedContainerConcurrency: Number(stagingTemplateContainerConcurrency),
      containerConcurrencyEqual: true
    },
    productionDomainMappingCount,
    activeTrafficUnchanged: true,
    featureDisabled: true,
    productionMutated: false
  };
  const serialized = JSON.stringify(context, null, 2);
  if (/https?:\/\//iu.test(serialized)) process.exit(9);
  if (/\b(?:headers?|token|credential|secretRef|body|envList)\b/iu.test(serialized)) process.exit(10);
  process.stdout.write(`${serialized}\n`);
' > "$PROBE_CONTEXT_TMP"

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
  if (
    context?.productionDomainMappingCount !== 0 ||
    context?.runtimeParity?.executionEnvironmentEqual !== true ||
    context?.runtimeParity?.containerConcurrencyEqual !== true ||
    context?.activeTrafficUnchanged !== true ||
    context?.featureDisabled !== true ||
    context?.productionMutated !== false
  ) process.exit(2);
'

printf '%s\n' \
  'PROBE_COMPLETE' \
  "evidence=$EVIDENCE_DIR/probe-results.json" \
  'active_staging_revision_unchanged=true' \
  'production_mutated=false' \
  'feature_enabled=false'
