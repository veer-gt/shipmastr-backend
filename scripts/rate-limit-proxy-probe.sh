#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="shipmastr-core-prod"
REGION="asia-south1"
SERVICE="shipmastr-api-staging"
PRODUCTION_SERVICE="shipmastr-api"
EXPECTED_BASE="a965f4314d7af02dc45c05733efaea322acb87eb"
BRANCH="hotfix/rate-limit-proxy-probe"
IMAGE_URI="asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api"
EVIDENCE_DIR=".superpowers/sdd/2026-08-17-cloud-run-rate-limit-header-probe"

for required_command in git gcloud node openssl curl date mv rm; do
  command -v "$required_command" >/dev/null 2>&1
done

test "$(git branch --show-current)" = "$BRANCH"
test "$(git merge-base HEAD "$EXPECTED_BASE")" = "$EXPECTED_BASE"
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain --untracked-files=normal)"
test "$(gcloud config get-value project 2>/dev/null)" = "$PROJECT"
test -d "$EVIDENCE_DIR"
test ! -e "$EVIDENCE_DIR/probe-results.json"

STAGING_SERVICE_JSON="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" --format=json)"

mapfile -t STAGING_SERVICE_FIELDS < <(
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
)
test "${#STAGING_SERVICE_FIELDS[@]}" -eq 5
ORIGINAL_STAGING_URL="${STAGING_SERVICE_FIELDS[0]}"
ORIGINAL_REVISION="${STAGING_SERVICE_FIELDS[1]}"
STAGING_EXECUTION_ENVIRONMENT="${STAGING_SERVICE_FIELDS[2]}"
STAGING_CONTAINER_CONCURRENCY="${STAGING_SERVICE_FIELDS[3]}"
ORIGINAL_TRAFFIC_JSON="${STAGING_SERVICE_FIELDS[4]}"

ORIGINAL_REVISION_JSON="$(gcloud run revisions describe "$ORIGINAL_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json)"

mapfile -t ORIGINAL_REVISION_FIELDS < <(
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
)
test "${#ORIGINAL_REVISION_FIELDS[@]}" -eq 5
ORIGINAL_IMAGE_DIGEST="${ORIGINAL_REVISION_FIELDS[0]}"
ACTIVE_COURIER_AUDIT_INTAKE="${ORIGINAL_REVISION_FIELDS[1]}"
ACTIVE_PROBE_TOKEN_STATE="${ORIGINAL_REVISION_FIELDS[2]}"
STAGING_EXECUTION_ENVIRONMENT="${ORIGINAL_REVISION_FIELDS[3]}"
STAGING_CONTAINER_CONCURRENCY="${ORIGINAL_REVISION_FIELDS[4]}"
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
    const revision = service?.status?.latestReadyRevisionName;
    if (typeof revision !== "string" || revision.length === 0) process.exit(2);
    process.stdout.write(revision);
  '
)"
PRODUCTION_REVISION_JSON="$(gcloud run revisions describe "$PRODUCTION_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json)"

mapfile -t PRODUCTION_RUNTIME_FIELDS < <(
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
)
test "${#PRODUCTION_RUNTIME_FIELDS[@]}" -eq 2
PRODUCTION_EXECUTION_ENVIRONMENT="${PRODUCTION_RUNTIME_FIELDS[0]}"
PRODUCTION_CONTAINER_CONCURRENCY="${PRODUCTION_RUNTIME_FIELDS[1]}"

DOMAIN_MAPPINGS_OUTPUT="$(gcloud beta run domain-mappings list \
  --project="$PROJECT" --region="$REGION" \
  --format='table(metadata.name,spec.routeName,status.conditions[0].status)')"
DOMAIN_MAPPINGS_JSON="$(gcloud beta run domain-mappings list \
  --project="$PROJECT" --region="$REGION" --format=json)"

DOMAIN_MAPPINGS_JSON="$DOMAIN_MAPPINGS_JSON" \
PRODUCTION_SERVICE_TO_CHECK="$PRODUCTION_SERVICE" \
STAGING_SERVICE_TO_CHECK="$SERVICE" \
node --input-type=module -e '
  const mappings = JSON.parse(process.env.DOMAIN_MAPPINGS_JSON ?? "");
  if (!Array.isArray(mappings)) process.exit(2);
  const production = process.env.PRODUCTION_SERVICE_TO_CHECK;
  const staging = process.env.STAGING_SERVICE_TO_CHECK;
  const productionMappings = mappings.filter((mapping) => mapping?.spec?.routeName === production);
  if (productionMappings.length === 0) process.exit(0);
  const stagingEquivalent = mappings.some((mapping) =>
    mapping?.spec?.routeName === staging &&
    Array.isArray(mapping?.status?.conditions) &&
    mapping.status.conditions.some((condition) =>
      condition?.type === "Ready" && String(condition?.status).toLowerCase() === "true"
    )
  );
  if (!stagingEquivalent) process.exit(3);
'

PROBE_TOKEN="$(openssl rand -hex 32)"
test "${#PROBE_TOKEN}" -eq 64
[[ "$PROBE_TOKEN" =~ ^[0-9a-f]{64}$ ]]
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
TAG="rlp-$(date -u +%m%d%H%M%S)"
IMAGE_TAG="rate-limit-proxy-probe-$RUN_ID"
EVIDENCE_TMP="$EVIDENCE_DIR/.probe-results-$RUN_ID.tmp"
test ! -e "$EVIDENCE_TMP"
CLEANUP_DONE=0

cleanup() {
  local incoming_status="${1:-$?}"
  local cleanup_failed=0
  local current_service_json=""
  local token_state=""

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
    SERVICE_JSON="$current_service_json" TAG_TO_FIND="$TAG" node --input-type=module -e '
      const service = JSON.parse(process.env.SERVICE_JSON ?? "");
      const traffic = service?.status?.traffic;
      if (!Array.isArray(traffic)) process.exit(2);
      process.exit(traffic.some((entry) => entry?.tag === process.env.TAG_TO_FIND) ? 0 : 1);
    '
    if [[ "$?" -eq 0 ]]; then
      gcloud run services update-traffic "$SERVICE" \
        --project="$PROJECT" --region="$REGION" \
        --remove-tags="$TAG" --quiet
      if [[ "$?" -ne 0 ]]; then
        cleanup_failed=1
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
mapfile -t TAG_BINDING < <(
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
)
test "${#TAG_BINDING[@]}" -eq 2
TAG_REVISION="${TAG_BINDING[0]}"
TAG_URL="${TAG_BINDING[1]}"

TAG_REVISION_JSON="$(gcloud run revisions describe "$TAG_REVISION" \
  --project="$PROJECT" --region="$REGION" --format=json)"
REVISION_JSON="$TAG_REVISION_JSON" \
EXPECTED_IMAGE_REF="$IMAGE_REF" \
EXPECTED_TOKEN="$PROBE_TOKEN" \
node --input-type=module -e '
  const revision = JSON.parse(process.env.REVISION_JSON ?? "");
  const containers = revision?.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) process.exit(2);
  if (containers[0]?.image !== process.env.EXPECTED_IMAGE_REF) process.exit(3);
  const env = Array.isArray(containers[0]?.env) ? containers[0].env : [];
  const exactValue = (name, value) => {
    const matches = env.filter((entry) => entry?.name === name);
    return matches.length === 1 && matches[0]?.value === value;
  };
  if (!exactValue("COURIER_AUDIT_INTAKE_ENABLED", "false")) process.exit(4);
  if (!exactValue("RATE_LIMIT_PROXY_PROBE_TOKEN", process.env.EXPECTED_TOKEN)) process.exit(5);
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

if cleanup 0; then
  :
else
  cleanup_status="$?"
  exit "$cleanup_status"
fi
trap - EXIT INT TERM

printf '%s\n' \
  'PROBE_COMPLETE' \
  "evidence=$EVIDENCE_DIR/probe-results.json" \
  'active_staging_revision_unchanged=true' \
  'production_mutated=false' \
  'feature_enabled=false'
