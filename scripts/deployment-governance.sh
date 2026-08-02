#!/usr/bin/env bash
set -euo pipefail
set -f

# Shipmastr I5B-1 governed deployment gate.
# This file validates authority and deployment inputs only.
# It performs no deployment by itself and authorizes no load-balancer work.

SHIPMASTR_GOVERNANCE_VERSION="7"

shipmastr_governance_fail() {
  echo "SHIPMASTR_DEPLOYMENT_BLOCKED=$1" >&2
  return 1
}

shipmastr_governance_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

shipmastr_governance_is_sha40() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

shipmastr_governance_is_sha256() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]]
}

shipmastr_governance_is_image_digest() {
  [[ "$1" =~ ^asia-south1-docker\.pkg\.dev/shipmastr-core-prod/shipmastr/shipmastr-api@sha256:[0-9a-f]{64}$ ]]
}

shipmastr_governance_is_rfc3339_utc() {
  local value="$1"

  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  node - "$value" <<'NODE'
const value = process.argv[2] || "";
const parsed = new Date(value);
if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
  process.exit(1);
}
NODE
}

shipmastr_governance_validate_production_database_name() {
  local database_name="${1:-}"

  if [[ ! "$database_name" =~ ^[a-z][a-z0-9_]*$ || \
    "$database_name" =~ (staging|stage|dev|development|local|scratch|test|ci) ]]; then
    shipmastr_governance_fail "NON_PRODUCTION_DATABASE_NAME"
    return 1
  fi

  case "$database_name" in
    shipmastr|shipmastr_prod|shipmastr_production)
      return 0
      ;;
    *)
      shipmastr_governance_fail "DATABASE_NAME_NOT_ALLOWLISTED"
      return 1
      ;;
  esac
}

shipmastr_governance_is_staging_revision() {
  local revision="$1"

  [[ "${#revision}" -le 63 && \
    "$revision" =~ ^shipmastr-api-staging-[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
}

shipmastr_governance_validate_cloud_run_traffic_tag() {
  local service_name="${1:-}"
  local traffic_tag="${2:-}"

  if [[ -z "$service_name" || -z "$traffic_tag" || \
    ! "$service_name" =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ || \
    ! "$traffic_tag" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ || \
    $(( ${#service_name} + ${#traffic_tag} )) -gt 46 ]]; then
    shipmastr_governance_fail "CLOUD_RUN_TRAFFIC_TAG_INVALID"
    return 1
  fi
}

shipmastr_governance_format_pid_fragment() {
  local process_id="${1:-}"
  local fragment

  if [[ ! "$process_id" =~ ^[0-9]+$ ]]; then
    shipmastr_governance_fail "STAGING_PID_FRAGMENT_INVALID"
    return 1
  fi

  if [[ "${#process_id}" -gt 5 ]]; then
    fragment="${process_id: -5}"
  else
    fragment="$process_id"
  fi
  while [[ "${#fragment}" -gt 1 && "$fragment" == 0* ]]; do
    fragment="${fragment#0}"
  done

  printf '%05d\n' "$fragment"
}

shipmastr_governance_validate_staging_generated_names() {
  local service_name="${1:-}"
  local commit_prefix="${2:-}"
  local invocation_utc="${3:-}"
  local pid_fragment="${4:-}"
  local revision_suffix="${5:-}"
  local candidate_tag="${6:-}"
  local expected_revision_suffix
  local expected_candidate_tag
  local expected_revision

  if [[ "$service_name" != "shipmastr-api-staging" || \
    ! "$service_name" =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]]; then
    shipmastr_governance_fail "STAGING_SERVICE_INVALID"
    return 1
  fi

  if [[ ! "$commit_prefix" =~ ^[0-9a-f]{7}$ ]]; then
    shipmastr_governance_fail "STAGING_COMMIT_PREFIX_INVALID"
    return 1
  fi

  if [[ ! "$invocation_utc" =~ ^[0-9]{14}$ ]]; then
    shipmastr_governance_fail "STAGING_INVOCATION_TIMESTAMP_INVALID"
    return 1
  fi

  if [[ ! "$pid_fragment" =~ ^[0-9]{5}$ ]]; then
    shipmastr_governance_fail "STAGING_PID_FRAGMENT_INVALID"
    return 1
  fi

  expected_revision_suffix="sf-${commit_prefix}-${invocation_utc}-${pid_fragment}"
  if [[ "$revision_suffix" != "$expected_revision_suffix" || \
    ! "$revision_suffix" =~ ^sf-[0-9a-f]{7}-[0-9]{14}-[0-9]{5}$ ]]; then
    shipmastr_governance_fail "STAGING_REVISION_SUFFIX_INVALID"
    return 1
  fi

  expected_candidate_tag="c-${commit_prefix}-${invocation_utc:6:8}-${pid_fragment}"
  if [[ "$candidate_tag" != "$expected_candidate_tag" || \
    ! "$candidate_tag" =~ ^c-[0-9a-f]{7}-[0-9]{8}-[0-9]{5}$ ]]; then
    shipmastr_governance_fail "STAGING_CANDIDATE_TAG_INVALID"
    return 1
  fi

  expected_revision="${service_name}-${revision_suffix}"
  if [[ "${#service_name}" -ne 21 || \
    "${#candidate_tag}" -ne 24 || \
    $(( ${#service_name} + ${#candidate_tag} )) -ne 45 || \
    "${#revision_suffix}" -ne 31 || \
    "${#expected_revision}" -ne 53 || \
    "${#expected_revision}" -gt 63 ]]; then
    shipmastr_governance_fail "STAGING_GENERATED_NAME_LENGTH_INVALID"
    return 1
  fi

  shipmastr_governance_validate_cloud_run_traffic_tag \
    "$service_name" \
    "$candidate_tag"
}

shipmastr_governance_verify_secret_metadata() {
  local project_id="$1"
  local secret_name="$2"
  local expected_environment="$3"
  local secret_labels
  local describe_status
  local actual_environment
  local actual_purpose
  local enabled_version
  local versions_status

  if [[ -z "$project_id" || -z "$secret_name" || -z "$expected_environment" ]]; then
    shipmastr_governance_fail "PLATFORM_CREDENTIAL_SECRET_METADATA_ARGUMENTS_INVALID"
    return 1
  fi

  set +e
  secret_labels="$(gcloud secrets describe "$secret_name" \
    --project "$project_id" \
    --format='value(labels.environment,labels.purpose)' 2>/dev/null)"
  describe_status=$?
  set -e

  if [[ "$describe_status" -ne 0 || -z "$secret_labels" ]]; then
    shipmastr_governance_fail "PLATFORM_CREDENTIAL_SECRET_NOT_FOUND"
    return 1
  fi

  actual_environment=""
  actual_purpose=""
  IFS=$'\t ' read -r actual_environment actual_purpose <<< "$secret_labels"

  if [[ "$actual_environment" != "$expected_environment" || \
    "$actual_purpose" != "platform-credential-encryption" ]]; then
    shipmastr_governance_fail "PLATFORM_CREDENTIAL_SECRET_LABELS_INVALID"
    return 1
  fi

  set +e
  enabled_version="$(gcloud secrets versions list "$secret_name" \
    --project "$project_id" \
    --filter='state=ENABLED' \
    --limit=1 \
    --format='value(name)' 2>/dev/null)"
  versions_status=$?
  set -e

  if [[ "$versions_status" -ne 0 || -z "$enabled_version" ]]; then
    shipmastr_governance_fail "PLATFORM_CREDENTIAL_SECRET_ENABLED_VERSION_REQUIRED"
    return 1
  fi

  echo "Platform credential secret metadata verified: ${secret_name}"
}

shipmastr_governance_sha256_file() {
  local path="$1"

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" |
      awk '{print $1}'
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" |
      awk '{print $1}'
    return
  fi

  shipmastr_governance_fail "SHA256_TOOL_NOT_FOUND"
  return 1
}

shipmastr_governance_validate_new_evidence_output() {
  local output_path="$1"
  local parent_dir
  local repo_root

  if [[ -z "$output_path" || "$output_path" != /* ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_OUTPUT_ABSOLUTE_PATH_REQUIRED"
    return 1
  fi

  if [[ -e "$output_path" || -L "$output_path" ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_OUTPUT_MUST_NOT_ALREADY_EXIST"
    return 1
  fi

  parent_dir="$(dirname "$output_path")"
  if [[ ! -d "$parent_dir" || ! -w "$parent_dir" ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_OUTPUT_PARENT_NOT_WRITABLE"
    return 1
  fi

  repo_root="$(shipmastr_governance_repo_root)"
  case "$output_path" in
    "$repo_root"|"$repo_root"/*)
      shipmastr_governance_fail \
        "STAGING_EVIDENCE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY"
      return 1
      ;;
  esac
}

shipmastr_governance_write_staging_evidence() {
  local output_path="$1"
  local commit_sha="$2"
  local image_digest="$3"
  local revision="$4"
  local temp_path
  local created_utc
  local evidence_sha

  if ! shipmastr_governance_validate_new_evidence_output \
    "$output_path"; then
    return 1
  fi

  if ! shipmastr_governance_is_sha40 "$commit_sha"; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_COMMIT_SHA_INVALID"
    return 1
  fi

  if ! shipmastr_governance_is_image_digest "$image_digest"; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_IMAGE_DIGEST_INVALID"
    return 1
  fi

  if ! shipmastr_governance_is_staging_revision "$revision"; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_REVISION_INVALID"
    return 1
  fi

  temp_path="$(mktemp "${output_path}.tmp.XXXXXX")"
  created_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat > "$temp_path" <<EOF
evidence_type=SHIPMASTR_STAGING_DEPLOYMENT_EVIDENCE_V2
project_id=shipmastr-core-prod
region=asia-south1
service=shipmastr-api-staging
commit_sha=$commit_sha
image_digest=$image_digest
revision=$revision
migration_status=PASS
candidate_health_v1=PASS
candidate_health_api=PASS
active_revision_digest=PASS
active_traffic_percent=100
active_health_v1=PASS
active_health_api=PASS
public_access_mutation=disabled
created_utc=$created_utc
EOF

  if ! chmod 600 "$temp_path"; then
    rm -f "$temp_path"
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_PERMISSIONS_FAILED"
    return 1
  fi

  if ! evidence_sha="$(
    shipmastr_governance_sha256_file "$temp_path"
  )"; then
    rm -f "$temp_path"
    return 1
  fi

  if ! shipmastr_governance_is_sha256 "$evidence_sha"; then
    rm -f "$temp_path"
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_SHA256_INVALID"
    return 1
  fi

  if ! mv "$temp_path" "$output_path"; then
    rm -f "$temp_path"
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_ATOMIC_RENAME_FAILED"
    return 1
  fi

  printf '%s\n' "$evidence_sha"
}

shipmastr_governance_verify_staging_evidence() {
  local evidence_path="$1"
  local expected_sha="$2"
  local expected_commit="$3"
  local expected_digest="$4"
  local actual_sha
  local verify_status

  if [[ -z "$evidence_path" || "$evidence_path" != /* ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_FILE_ABSOLUTE_PATH_REQUIRED"
    return 1
  fi

  if [[ ! -f "$evidence_path" || -L "$evidence_path" ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_FILE_MISSING_OR_UNSAFE"
    return 1
  fi

  if ! shipmastr_governance_is_sha256 "$expected_sha"; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_SHA256_REQUIRED"
    return 1
  fi

  if ! shipmastr_governance_is_sha40 "$expected_commit"; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_EXPECTED_COMMIT_INVALID"
    return 1
  fi

  if ! shipmastr_governance_is_image_digest "$expected_digest"; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_EXPECTED_DIGEST_INVALID"
    return 1
  fi

  actual_sha="$(
    shipmastr_governance_sha256_file "$evidence_path"
  )"

  if [[ "$actual_sha" != "$expected_sha" ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_SHA256_MISMATCH"
    return 1
  fi

  set +e
  node - "$evidence_path" "$expected_commit" "$expected_digest" <<'NODE'
const fs = require("node:fs");

const [path, expectedCommit, expectedDigest] = process.argv.slice(2);
const text = fs.readFileSync(path, "utf8");

if (!text.endsWith("\n")) {
  process.exit(2);
}

const lines = text.slice(0, -1).split("\n");
const values = new Map();

for (const line of lines) {
  const separator = line.indexOf("=");
  if (separator <= 0) {
    process.exit(3);
  }

  const key = line.slice(0, separator);
  const value = line.slice(separator + 1);

  if (values.has(key)) {
    process.exit(4);
  }

  values.set(key, value);
}

const expected = new Map([
  ["evidence_type", "SHIPMASTR_STAGING_DEPLOYMENT_EVIDENCE_V2"],
  ["project_id", "shipmastr-core-prod"],
  ["region", "asia-south1"],
  ["service", "shipmastr-api-staging"],
  ["commit_sha", expectedCommit],
  ["image_digest", expectedDigest],
  ["migration_status", "PASS"],
  ["candidate_health_v1", "PASS"],
  ["candidate_health_api", "PASS"],
  ["active_revision_digest", "PASS"],
  ["active_traffic_percent", "100"],
  ["active_health_v1", "PASS"],
  ["active_health_api", "PASS"],
  ["public_access_mutation", "disabled"],
]);

if (values.size !== expected.size + 2) {
  process.exit(5);
}

for (const [key, value] of expected) {
  if (values.get(key) !== value) {
    process.exit(6);
  }
}

const createdUtc = values.get("created_utc") || "";
const utcShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const parsedUtc = new Date(createdUtc);
const roundTripUtc = Number.isNaN(parsedUtc.getTime())
  ? ""
  : parsedUtc.toISOString().replace(".000Z", "Z");
if (!utcShape.test(createdUtc) || roundTripUtc !== createdUtc) {
  process.exit(7);
}

const revision = values.get("revision") || "";
if (
  revision.length > 63 ||
  !/^shipmastr-api-staging-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(revision)
) {
  process.exit(9);
}

for (const key of values.keys()) {
  if (key !== "created_utc" && key !== "revision" && !expected.has(key)) {
    process.exit(8);
  }
}
NODE
  verify_status=$?
  set -e

  if [[ "$verify_status" -ne 0 ]]; then
    shipmastr_governance_fail \
      "STAGING_EVIDENCE_SEMANTIC_VALIDATION_FAILED"
    return 1
  fi
}

shipmastr_governance_validate_new_production_evidence_output() {
  local output_path="$1"
  local parent_dir
  local parent_real
  local repo_root
  local repo_real
  local output_name
  local resolved_output

  if [[ -z "$output_path" || "$output_path" != /* ]]; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_EVIDENCE_OUTPUT_ABSOLUTE_PATH_REQUIRED"
    return 1
  fi

  if [[ -e "$output_path" || -L "$output_path" ]]; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_EVIDENCE_OUTPUT_MUST_NOT_ALREADY_EXIST"
    return 1
  fi

  parent_dir="$(dirname "$output_path")"
  if [[ ! -d "$parent_dir" || ! -w "$parent_dir" ]]; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_EVIDENCE_OUTPUT_PARENT_NOT_WRITABLE"
    return 1
  fi

  repo_root="$(shipmastr_governance_repo_root)"
  if ! parent_real="$(cd -P "$parent_dir" && pwd)" || \
    ! repo_real="$(cd -P "$repo_root" && pwd)"; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_EVIDENCE_OUTPUT_PATH_NOT_RESOLVED"
    return 1
  fi
  output_name="$(basename "$output_path")"
  resolved_output="${parent_real}/${output_name}"
  case "$resolved_output" in
    "$repo_real"|"$repo_real"/*)
      shipmastr_governance_fail \
        "PRODUCTION_MIGRATION_EVIDENCE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY"
      return 1
      ;;
  esac
}

shipmastr_governance_file_mode() {
  local path="$1"

  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
    return
  fi
  stat -c '%a' "$path"
}

shipmastr_governance_backup_id_for_invocation() {
  local expected_instance="$1"
  local expected_description="$2"
  local input_json

  input_json="$(cat)"
  BACKUP_LIST_JSON_TO_VERIFY="$input_json" \
  EXPECTED_BACKUP_INSTANCE="$expected_instance" \
  EXPECTED_BACKUP_DESCRIPTION="$expected_description" \
  node <<'NODE'
const backups = JSON.parse(process.env.BACKUP_LIST_JSON_TO_VERIFY || "null");
const expectedInstance = process.env.EXPECTED_BACKUP_INSTANCE || "";
const expectedDescription = process.env.EXPECTED_BACKUP_DESCRIPTION || "";

if (!Array.isArray(backups) || backups.length !== 1) process.exit(2);
const backup = backups[0] || {};
const id = String(backup.id || "");
if (!/^\d+$/.test(id)) process.exit(3);
if (backup.instance !== expectedInstance || backup.description !== expectedDescription) process.exit(4);
process.stdout.write(`${id}\n`);
NODE
}

shipmastr_governance_verify_backup_run() {
  local expected_instance="$1"
  local expected_description="$2"
  local invocation_utc="$3"
  local verification_utc="$4"
  local input_json

  input_json="$(cat)"
  BACKUP_JSON_TO_VERIFY="$input_json" \
  EXPECTED_BACKUP_INSTANCE="$expected_instance" \
  EXPECTED_BACKUP_DESCRIPTION="$expected_description" \
  EXPECTED_INVOCATION_UTC="$invocation_utc" \
  BACKUP_VERIFICATION_UTC="$verification_utc" \
  node <<'NODE'
const backup = JSON.parse(process.env.BACKUP_JSON_TO_VERIFY || "null");
const expectedInstance = process.env.EXPECTED_BACKUP_INSTANCE || "";
const expectedDescription = process.env.EXPECTED_BACKUP_DESCRIPTION || "";
const invocationUtc = process.env.EXPECTED_INVOCATION_UTC || "";
const verificationUtc = process.env.BACKUP_VERIFICATION_UTC || "";
const id = String(backup?.id || "");
const start = String(backup?.startTime || "");
const end = String(backup?.endTime || "");
const invocationMs = Date.parse(invocationUtc);
const verificationMs = Date.parse(verificationUtc);
const startMs = Date.parse(start);
const endMs = Date.parse(end);

if (!/^\d+$/.test(id)) process.exit(2);
if (backup?.instance !== expectedInstance || backup?.description !== expectedDescription) process.exit(3);
if (backup?.status !== "SUCCESSFUL" || backup?.type !== "ON_DEMAND") process.exit(4);
if ([invocationMs, verificationMs, startMs, endMs].some(Number.isNaN)) process.exit(5);
if (startMs < invocationMs || endMs < startMs || endMs > verificationMs) process.exit(6);
process.stdout.write(`${id}\t${start}\t${end}\n`);
NODE
}

shipmastr_governance_production_service_snapshot() {
  local input_json

  input_json="$(cat)"
  PRODUCTION_SERVICE_JSON_TO_VERIFY="$input_json" node <<'NODE'
const service = JSON.parse(process.env.PRODUCTION_SERVICE_JSON_TO_VERIFY || "null");
const rawName = String(service?.metadata?.name || service?.name || "");
const name = rawName.split("/").pop() || "";
const status = service?.status || {};
const traffic = Array.isArray(status.traffic) ? status.traffic : [];
const positive = traffic.filter((entry) => Number(entry.percent || 0) > 0);

if (name !== "shipmastr-api") process.exit(2);
if (positive.length !== 1 || Number(positive[0].percent) !== 100) process.exit(3);
const revision = String(positive[0].revisionName || "");
if (!/^shipmastr-api-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(revision)) process.exit(4);

const normalizedTraffic = traffic.map((entry) => ({
  revisionName: String(entry.revisionName || ""),
  percent: Number(entry.percent || 0),
  tag: String(entry.tag || ""),
  type: String(entry.type || ""),
})).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
const snapshot = {
  latestCreatedRevisionName: String(status.latestCreatedRevisionName || ""),
  latestReadyRevisionName: String(status.latestReadyRevisionName || ""),
  traffic: normalizedTraffic,
};
process.stdout.write(`${revision}\t${Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64")}\n`);
NODE
}

shipmastr_governance_verify_production_migration_result() {
  local expected_phase="$1"
  local input_json
  local database_name

  input_json="$(cat)"
  database_name="$(
    PRODUCTION_MIGRATION_RESULT_TO_VERIFY="$input_json" \
    EXPECTED_MIGRATION_RESULT_PHASE="$expected_phase" \
    node <<'NODE'
const value = JSON.parse(process.env.PRODUCTION_MIGRATION_RESULT_TO_VERIFY || "null");
const phase = process.env.EXPECTED_MIGRATION_RESULT_PHASE || "";
const expectedMigrations = [
  "20260712180000_h2a_platform_webhook_credentials",
  "20260714100000_h2a_synthetic_tenant_lifecycle",
].sort();
const expectedSchemaObjects = [
  "enum:PlatformCredentialPurpose",
  "enum:SecurityFixtureKind",
  "enum:SecurityFixtureStatus",
  "foreign_key:platform_webhook_credentials_connection_id_fkey",
  "foreign_key:security_fixture_tenants_creator_internal_user_id_fkey",
  "foreign_key:security_fixture_tenants_merchant_id_fkey",
  "foreign_key:security_fixture_tenants_owner_user_id_fkey",
  "index:platform_webhook_credentials_connection_id_idx",
  "index:platform_webhook_credentials_connection_id_purpose_key",
  "index:platform_webhook_credentials_merchant_id_idx",
  "index:platform_webhook_credentials_merchant_id_platform_idx",
  "index:platform_webhook_credentials_pkey",
  "index:security_fixture_tenants_active_slot_key",
  "index:security_fixture_tenants_expires_at_idx",
  "index:security_fixture_tenants_fixture_kind_status_idx",
  "index:security_fixture_tenants_merchant_id_key",
  "index:security_fixture_tenants_owner_user_id_key",
  "index:security_fixture_tenants_pkey",
  "table:platform_webhook_credentials",
  "table:security_fixture_tenants",
].sort();
const expectedKeys = [
  "phase",
  "databaseName",
  "prismaStatusExit",
  "prismaReportedDrift",
  "prismaPendingNames",
  "structuredPendingNames",
  "failedMigrationNames",
  "rolledBackMigrationNames",
  "unexpectedAppliedMigrationNames",
  "verifiedMigrationNames",
  "schemaObjects",
].sort();
const keys = value && typeof value === "object" && !Array.isArray(value)
  ? Object.keys(value).sort()
  : [];
const same = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const arrays = [
  "prismaPendingNames",
  "structuredPendingNames",
  "failedMigrationNames",
  "rolledBackMigrationNames",
  "unexpectedAppliedMigrationNames",
  "verifiedMigrationNames",
  "schemaObjects",
];

if (!same(keys, expectedKeys) || value.phase !== phase) process.exit(2);
if (!arrays.every((key) => Array.isArray(value[key]) && value[key].every((item) => typeof item === "string"))) process.exit(3);
if (
  typeof value.databaseName !== "string"
  || !Number.isInteger(value.prismaStatusExit)
  || typeof value.prismaReportedDrift !== "boolean"
) process.exit(4);
if (
  value.prismaReportedDrift
  || value.failedMigrationNames.length
  || value.rolledBackMigrationNames.length
  || value.unexpectedAppliedMigrationNames.length
) process.exit(5);

if (phase === "precheck") {
  if (
    value.prismaStatusExit !== 1
    || !same(value.prismaPendingNames, expectedMigrations)
    || !same(value.structuredPendingNames, expectedMigrations)
    || value.verifiedMigrationNames.length
    || value.schemaObjects.length
  ) process.exit(6);
} else if (phase === "postcheck") {
  if (
    value.prismaStatusExit !== 0
    || value.prismaPendingNames.length
    || value.structuredPendingNames.length
    || !same(value.verifiedMigrationNames, expectedMigrations)
    || !same(value.schemaObjects, expectedSchemaObjects)
  ) process.exit(7);
} else {
  process.exit(8);
}

process.stdout.write(`${value.databaseName}\n`);
NODE
  )" || {
    shipmastr_governance_fail "PRODUCTION_MIGRATION_RESULT_INVALID"
    return 1
  }

  if ! shipmastr_governance_validate_production_database_name \
    "$database_name"; then
    return 1
  fi
  printf '%s\n' "$database_name"
}

shipmastr_governance_write_production_backup_evidence() {
  local output_path="$1"
  local commit_sha="$2"
  local image_digest="$3"
  local cloud_sql_instance="$4"
  local backup_id="$5"
  local backup_description="$6"
  local invocation_utc="$7"
  local backup_start_utc="$8"
  local backup_end_utc="$9"
  local temp_path
  local created_utc
  local evidence_sha

  shipmastr_governance_validate_new_production_evidence_output "$output_path" || return 1
  shipmastr_governance_is_sha40 "$commit_sha" || return 1
  shipmastr_governance_is_image_digest "$image_digest" || return 1
  [[ "$cloud_sql_instance" == "shipmastr-core-prod:asia-south1:shipmastr-postgres" ]] || return 1
  [[ "$backup_id" =~ ^[0-9]+$ ]] || return 1
  [[ "$backup_description" =~ ^shipmastr-prod-migration-[0-9]{14}-[0-9a-f]{7}-[0-9]{5}$ ]] || return 1
  shipmastr_governance_is_rfc3339_utc "$invocation_utc" || return 1
  [[ -n "$backup_start_utc" && -n "$backup_end_utc" ]] || return 1

  if ! created_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
    return 1
  fi
  shipmastr_governance_is_rfc3339_utc "$created_utc" || return 1
  if ! temp_path="$(mktemp "${output_path}.tmp.XXXXXX")"; then
    return 1
  fi
  if ! cat > "$temp_path" <<EOF
evidence_type=SHIPMASTR_PRODUCTION_DATABASE_BACKUP_EVIDENCE_V1
project_id=shipmastr-core-prod
region=asia-south1
commit_sha=$commit_sha
image_digest=$image_digest
cloud_sql_instance=$cloud_sql_instance
backup_id=$backup_id
backup_status=SUCCESSFUL
backup_type=ON_DEMAND
backup_description=$backup_description
invocation_utc=$invocation_utc
backup_start_utc=$backup_start_utc
backup_end_utc=$backup_end_utc
created_utc=$created_utc
EOF
  then
    rm -f "$temp_path"
    return 1
  fi
  if ! chmod 600 "$temp_path"; then
    rm -f "$temp_path"
    return 1
  fi
  if ! evidence_sha="$(shipmastr_governance_sha256_file "$temp_path")" || \
    ! shipmastr_governance_is_sha256 "$evidence_sha"; then
    rm -f "$temp_path"
    return 1
  fi
  if [[ -e "$output_path" || -L "$output_path" ]] || \
    ! mv "$temp_path" "$output_path"; then
    rm -f "$temp_path"
    return 1
  fi
  printf '%s\n' "$evidence_sha"
}

shipmastr_governance_verify_production_backup_evidence() {
  local path="$1"
  local expected_sha="$2"
  local expected_commit="$3"
  local expected_digest="$4"
  local expected_instance="$5"
  local expected_backup_id="$6"
  local expected_description="$7"
  local expected_invocation="$8"
  local input_text

  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(shipmastr_governance_file_mode "$path")" == "600" ]] || return 1
  [[ "$(shipmastr_governance_sha256_file "$path")" == "$expected_sha" ]] || return 1
  input_text="$(cat "$path")"$'\n'
  PRODUCTION_BACKUP_EVIDENCE_TO_VERIFY="$input_text" \
  EXPECTED_EVIDENCE_COMMIT="$expected_commit" \
  EXPECTED_EVIDENCE_DIGEST="$expected_digest" \
  EXPECTED_EVIDENCE_INSTANCE="$expected_instance" \
  EXPECTED_EVIDENCE_BACKUP_ID="$expected_backup_id" \
  EXPECTED_EVIDENCE_DESCRIPTION="$expected_description" \
  EXPECTED_EVIDENCE_INVOCATION="$expected_invocation" \
  node <<'NODE'
const text = process.env.PRODUCTION_BACKUP_EVIDENCE_TO_VERIFY || "";
if (!text.endsWith("\n")) process.exit(2);
const values = new Map();
for (const line of text.slice(0, -1).split("\n")) {
  const separator = line.indexOf("=");
  if (separator <= 0) process.exit(3);
  const key = line.slice(0, separator);
  if (values.has(key)) process.exit(4);
  values.set(key, line.slice(separator + 1));
}
const expected = new Map([
  ["evidence_type", "SHIPMASTR_PRODUCTION_DATABASE_BACKUP_EVIDENCE_V1"],
  ["project_id", "shipmastr-core-prod"],
  ["region", "asia-south1"],
  ["commit_sha", process.env.EXPECTED_EVIDENCE_COMMIT || ""],
  ["image_digest", process.env.EXPECTED_EVIDENCE_DIGEST || ""],
  ["cloud_sql_instance", process.env.EXPECTED_EVIDENCE_INSTANCE || ""],
  ["backup_id", process.env.EXPECTED_EVIDENCE_BACKUP_ID || ""],
  ["backup_status", "SUCCESSFUL"],
  ["backup_type", "ON_DEMAND"],
  ["backup_description", process.env.EXPECTED_EVIDENCE_DESCRIPTION || ""],
  ["invocation_utc", process.env.EXPECTED_EVIDENCE_INVOCATION || ""],
]);
const allowedDynamic = new Set(["backup_start_utc", "backup_end_utc", "created_utc"]);
if (values.size !== expected.size + allowedDynamic.size) process.exit(5);
for (const [key, value] of expected) if (values.get(key) !== value) process.exit(6);
for (const key of values.keys()) if (!expected.has(key) && !allowedDynamic.has(key)) process.exit(7);
for (const key of allowedDynamic) if (Number.isNaN(Date.parse(values.get(key) || ""))) process.exit(8);
NODE
}

shipmastr_governance_write_production_migration_evidence() {
  local output_path="$1"
  local commit_sha="$2"
  local image_digest="$3"
  local database_name="$4"
  local cloud_sql_instance="$5"
  local backup_id="$6"
  local revision_before="$7"
  local revision_after="$8"
  local temp_path
  local created_utc
  local evidence_sha

  shipmastr_governance_validate_new_production_evidence_output "$output_path" || return 1
  shipmastr_governance_is_sha40 "$commit_sha" || return 1
  shipmastr_governance_is_image_digest "$image_digest" || return 1
  shipmastr_governance_validate_production_database_name "$database_name" || return 1
  [[ "$cloud_sql_instance" == "shipmastr-core-prod:asia-south1:shipmastr-postgres" ]] || return 1
  [[ "$backup_id" =~ ^[0-9]+$ ]] || return 1
  [[ "$revision_before" =~ ^shipmastr-api-[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  [[ "$revision_after" == "$revision_before" ]] || return 1

  if ! created_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
    return 1
  fi
  shipmastr_governance_is_rfc3339_utc "$created_utc" || return 1
  if ! temp_path="$(mktemp "${output_path}.tmp.XXXXXX")"; then
    return 1
  fi
  if ! cat > "$temp_path" <<EOF
evidence_type=SHIPMASTR_PRODUCTION_DATABASE_MIGRATION_EVIDENCE_V1
project_id=shipmastr-core-prod
region=asia-south1
commit_sha=$commit_sha
image_digest=$image_digest
database_name=$database_name
cloud_sql_instance=$cloud_sql_instance
backup_id=$backup_id
backup_status=SUCCESSFUL
pending_migrations_before=20260712180000_h2a_platform_webhook_credentials,20260714100000_h2a_synthetic_tenant_lifecycle
migration_execution=PASS
migration_status_after=PASS
verified_migration_1=20260712180000_h2a_platform_webhook_credentials
verified_migration_2=20260714100000_h2a_synthetic_tenant_lifecycle
production_service_revision_before=$revision_before
production_service_revision_after=$revision_after
production_traffic_mutation=none
created_utc=$created_utc
EOF
  then
    rm -f "$temp_path"
    return 1
  fi
  if ! chmod 600 "$temp_path"; then
    rm -f "$temp_path"
    return 1
  fi
  if ! evidence_sha="$(shipmastr_governance_sha256_file "$temp_path")" || \
    ! shipmastr_governance_is_sha256 "$evidence_sha"; then
    rm -f "$temp_path"
    return 1
  fi
  if [[ -e "$output_path" || -L "$output_path" ]] || \
    ! mv "$temp_path" "$output_path"; then
    rm -f "$temp_path"
    return 1
  fi
  printf '%s\n' "$evidence_sha"
}

shipmastr_governance_verify_production_migration_evidence() {
  local path="$1"
  local expected_sha="$2"
  local expected_commit="$3"
  local expected_digest="$4"
  local input_text

  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(shipmastr_governance_file_mode "$path")" == "600" ]] || return 1
  [[ "$(shipmastr_governance_sha256_file "$path")" == "$expected_sha" ]] || return 1
  input_text="$(cat "$path")"$'\n'
  PRODUCTION_MIGRATION_EVIDENCE_TO_VERIFY="$input_text" \
  EXPECTED_EVIDENCE_COMMIT="$expected_commit" \
  EXPECTED_EVIDENCE_DIGEST="$expected_digest" \
  node <<'NODE'
const text = process.env.PRODUCTION_MIGRATION_EVIDENCE_TO_VERIFY || "";
if (!text.endsWith("\n")) process.exit(2);
const values = new Map();
for (const line of text.slice(0, -1).split("\n")) {
  const separator = line.indexOf("=");
  if (separator <= 0) process.exit(3);
  const key = line.slice(0, separator);
  if (values.has(key)) process.exit(4);
  values.set(key, line.slice(separator + 1));
}
const expected = new Map([
  ["evidence_type", "SHIPMASTR_PRODUCTION_DATABASE_MIGRATION_EVIDENCE_V1"],
  ["project_id", "shipmastr-core-prod"],
  ["region", "asia-south1"],
  ["commit_sha", process.env.EXPECTED_EVIDENCE_COMMIT || ""],
  ["image_digest", process.env.EXPECTED_EVIDENCE_DIGEST || ""],
  ["cloud_sql_instance", "shipmastr-core-prod:asia-south1:shipmastr-postgres"],
  ["backup_status", "SUCCESSFUL"],
  ["pending_migrations_before", "20260712180000_h2a_platform_webhook_credentials,20260714100000_h2a_synthetic_tenant_lifecycle"],
  ["migration_execution", "PASS"],
  ["migration_status_after", "PASS"],
  ["verified_migration_1", "20260712180000_h2a_platform_webhook_credentials"],
  ["verified_migration_2", "20260714100000_h2a_synthetic_tenant_lifecycle"],
  ["production_traffic_mutation", "none"],
]);
const dynamic = new Set([
  "database_name",
  "backup_id",
  "production_service_revision_before",
  "production_service_revision_after",
  "created_utc",
]);
if (values.size !== expected.size + dynamic.size) process.exit(5);
for (const [key, value] of expected) if (values.get(key) !== value) process.exit(6);
for (const key of values.keys()) if (!expected.has(key) && !dynamic.has(key)) process.exit(7);
if (!/^\d+$/.test(values.get("backup_id") || "")) process.exit(8);
const before = values.get("production_service_revision_before") || "";
if (before !== values.get("production_service_revision_after")) process.exit(9);
if (!/^shipmastr-api-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(before)) process.exit(10);
if (Number.isNaN(Date.parse(values.get("created_utc") || ""))) process.exit(11);
const databaseName = values.get("database_name") || "";
if (!new Set(["shipmastr", "shipmastr_prod", "shipmastr_production"]).has(databaseName)) process.exit(12);
NODE
}

shipmastr_governance_indirect_value() {
  local variable_name="$1"
  local value
  eval "value=\${${variable_name}-}"
  printf '%s\n' "$value"
}

shipmastr_governance_assert_unset_or_equal() {
  local variable_name="$1"
  local expected="$2"
  local actual

  actual="$(shipmastr_governance_indirect_value "$variable_name")"
  if [[ -n "$actual" && "$actual" != "$expected" ]]; then
    shipmastr_governance_fail "UNAPPROVED_${variable_name}_OVERRIDE"
    return 1
  fi
}

shipmastr_governance_git_clean() {
  local repo_root="$1"

  [[ -z "$(
    git -C "$repo_root" status --porcelain=v1 --untracked-files=all
  )" ]]
}

shipmastr_governance_head_sha() {
  local repo_root="$1"
  git -C "$repo_root" rev-parse HEAD
}

shipmastr_governance_is_canonical_backend_url() {
  case "$1" in
    https://github.com/veer-gt/shipmastr-backend|\
    https://github.com/veer-gt/shipmastr-backend.git|\
    git@github.com:veer-gt/shipmastr-backend.git|\
    ssh://git@github.com/veer-gt/shipmastr-backend.git)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

shipmastr_governance_validate_canonical_origin() {
  local repo_root="$1"
  local configured_origin
  local effective_origin

  set +e
  configured_origin="$(
    git -C "$repo_root" remote get-url origin 2>/dev/null
  )"
  local configured_status=$?
  set -e

  if [[ "$configured_status" -ne 0 || -z "$configured_origin" ]]; then
    shipmastr_governance_fail "CANONICAL_BACKEND_ORIGIN_NOT_CONFIGURED"
    return 1
  fi

  if ! shipmastr_governance_is_canonical_backend_url \
    "$configured_origin"; then
    shipmastr_governance_fail "BACKEND_ORIGIN_URL_NOT_CANONICAL"
    return 1
  fi

  set +e
  effective_origin="$(
    git -C "$repo_root" ls-remote --get-url origin 2>/dev/null
  )"
  local effective_status=$?
  set -e

  if [[ "$effective_status" -ne 0 || -z "$effective_origin" ]]; then
    shipmastr_governance_fail "BACKEND_EFFECTIVE_ORIGIN_NOT_RESOLVED"
    return 1
  fi

  if ! shipmastr_governance_is_canonical_backend_url \
    "$effective_origin"; then
    shipmastr_governance_fail \
      "BACKEND_ORIGIN_REWRITTEN_OR_NOT_CANONICAL"
    return 1
  fi
}

shipmastr_governance_remote_main_sha() {
  local repo_root="$1"
  local remote_output
  local remote_count
  local remote_sha

  if ! shipmastr_governance_validate_canonical_origin     "$repo_root"; then
    return 1
  fi

  set +e
  remote_output="$(
    git -C "$repo_root" ls-remote \
      --exit-code \
      origin \
      refs/heads/main \
      2>/dev/null
  )"
  local remote_status=$?
  set -e

  if [[ "$remote_status" -ne 0 || -z "$remote_output" ]]; then
    shipmastr_governance_fail "REMOTE_MAIN_COULD_NOT_BE_RESOLVED"
    return 1
  fi

  remote_count="$(
    printf '%s\n' "$remote_output" |
      awk 'NF { count += 1 } END { print count + 0 }'
  )"

  if [[ "$remote_count" != "1" ]]; then
    shipmastr_governance_fail "REMOTE_MAIN_RESOLUTION_AMBIGUOUS"
    return 1
  fi

  remote_sha="$(
    printf '%s\n' "$remote_output" |
      awk 'NF { print $1 }'
  )"

  if ! shipmastr_governance_is_sha40 "$remote_sha"; then
    shipmastr_governance_fail "REMOTE_MAIN_SHA_INVALID"
    return 1
  fi

  printf '%s\n' "$remote_sha"
}

shipmastr_governance_effective_identity() {
  local active_accounts
  local active_count
  local impersonated

  if ! command -v gcloud >/dev/null 2>&1; then
    shipmastr_governance_fail "GCLOUD_NOT_FOUND"
    return 1
  fi

  active_accounts="$(
    gcloud auth list \
      --filter='status:ACTIVE' \
      --format='value(account)' \
      2>/dev/null |
    awk 'NF'
  )"

  active_count="$(
    printf '%s\n' "$active_accounts" |
      awk 'NF { count += 1 } END { print count + 0 }'
  )"

  if [[ "$active_count" != "1" ]]; then
    shipmastr_governance_fail \
      "EXACTLY_ONE_ACTIVE_GCLOUD_ACCOUNT_REQUIRED"
    return 1
  fi

  impersonated="$(
    gcloud config get-value auth/impersonate_service_account \
      2>/dev/null |
    awk 'NF && $0 != "(unset)"'
  )"

  if [[ -n "$impersonated" ]]; then
    printf '%s\n' "$impersonated"
  else
    printf '%s\n' "$active_accounts"
  fi
}

shipmastr_governance_validate_identity() {
  local environment="$1"
  local effective_identity="$2"
  local owner="indraveer.chauhan@gmail.com"
  local expected_deployer

  case "$environment" in
    staging)
      expected_deployer="shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com"
      ;;
    production|production-migration|migration-status|migration-build)
      expected_deployer="shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com"
      ;;
    *)
      shipmastr_governance_fail "UNKNOWN_ENVIRONMENT"
      return 1
      ;;
  esac

  if [[ "$effective_identity" == "$owner" ]]; then
    if [[ "${SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL:-}" != \
      "APPROVE SHIPMASTR OWNER BREAK GLASS DEPLOYMENT" ]]; then
      shipmastr_governance_fail \
        "OWNER_IDENTITY_REQUIRES_BREAK_GLASS_APPROVAL"
      return 1
    fi
    return 0
  fi

  if [[ "$effective_identity" != "$expected_deployer" ]]; then
    shipmastr_governance_fail \
      "WRONG_DEPLOYMENT_IDENTITY_FOR_${environment}"
    return 1
  fi
}

shipmastr_governance_validate_common() {
  local environment="$1"
  local expected_service="$2"
  local repo_root
  local approved_commit
  local head_sha
  local effective_identity
  local variable_name

  if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
    shipmastr_governance_fail \
      "SERVICE_ACCOUNT_KEY_CREDENTIALS_PROHIBITED"
    return 1
  fi

  repo_root="$(shipmastr_governance_repo_root)"

  if ! shipmastr_governance_git_clean "$repo_root"; then
    shipmastr_governance_fail "SOURCE_REPOSITORY_MUST_BE_CLEAN"
    return 1
  fi

  approved_commit="${SHIPMASTR_APPROVED_COMMIT_SHA:-}"
  if ! shipmastr_governance_is_sha40 "$approved_commit"; then
    shipmastr_governance_fail "APPROVED_COMMIT_SHA_REQUIRED"
    return 1
  fi

  head_sha="$(shipmastr_governance_head_sha "$repo_root")"
  if [[ "$head_sha" != "$approved_commit" ]]; then
    shipmastr_governance_fail "APPROVED_COMMIT_DOES_NOT_MATCH_HEAD"
    return 1
  fi

  if ! effective_identity="$(
    shipmastr_governance_effective_identity
  )"; then
    return 1
  fi

  if [[ -z "$effective_identity" ]]; then
    shipmastr_governance_fail \
      "EFFECTIVE_DEPLOYMENT_IDENTITY_EMPTY"
    return 1
  fi

  if ! shipmastr_governance_validate_identity \
    "$environment" "$effective_identity"; then
    return 1
  fi

  if [[ "${SHIPMASTR_PUBLIC_ACCESS_EXPECTATION:-}" != "public" ]]; then
    shipmastr_governance_fail \
      "PUBLIC_ACCESS_EXPECTATION_MUST_BE_EXPLICIT"
    return 1
  fi

  if [[ "${SHIPMASTR_PUBLIC_ACCESS_APPROVAL:-}" != \
    "APPROVE RETAIN CURRENT PUBLIC INVOCATION STATE" ]]; then
    shipmastr_governance_fail "PUBLIC_ACCESS_APPROVAL_REQUIRED"
    return 1
  fi

  for variable_name in PROJECT PROJECT_ID; do
    if ! shipmastr_governance_assert_unset_or_equal \
      "$variable_name" "shipmastr-core-prod"; then
      return 1
    fi
  done

  if ! shipmastr_governance_assert_unset_or_equal \
    REGION "asia-south1"; then
    return 1
  fi

  for variable_name in CLOUD_RUN_SERVICE SERVICE SERVICE_NAME; do
    if ! shipmastr_governance_assert_unset_or_equal \
      "$variable_name" "$expected_service"; then
      return 1
    fi
  done

  if ! shipmastr_governance_assert_unset_or_equal \
    SERVICE_ACCOUNT \
    "shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com"; then
    return 1
  fi

  if ! shipmastr_governance_assert_unset_or_equal \
    CLOUD_SQL_INSTANCE \
    "shipmastr-core-prod:asia-south1:shipmastr-postgres"; then
    return 1
  fi

  export PROJECT="shipmastr-core-prod"
  export PROJECT_ID="shipmastr-core-prod"
  export REGION="asia-south1"
  export CLOUD_RUN_SERVICE="$expected_service"
  export SERVICE="$expected_service"
  export SERVICE_NAME="$expected_service"
  export SERVICE_ACCOUNT="shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com"
  export CLOUD_SQL_INSTANCE="shipmastr-core-prod:asia-south1:shipmastr-postgres"
  export SHIPMASTR_GOVERNANCE_VERSION
  export SHIPMASTR_GOVERNED_ENVIRONMENT="$environment"
  export SHIPMASTR_GOVERNED_PUBLIC_ACCESS_MUTATION="disabled"
}

shipmastr_deployment_guard() {
  local environment="$1"
  local repo_root
  local remote_main_sha

  case "$environment" in
    staging)
      if ! shipmastr_governance_validate_common         staging shipmastr-api-staging; then
        return 1
      fi

      if [[ "${SHIPMASTR_STAGING_DEPLOY_APPROVAL:-}" != \
        "APPROVE SHIPMASTR STAGING DEPLOY" ]]; then
        shipmastr_governance_fail "STAGING_DEPLOY_APPROVAL_REQUIRED"
        return 1
      fi

      if ! shipmastr_governance_validate_new_evidence_output \
        "${SHIPMASTR_STAGING_EVIDENCE_OUTPUT:-}"; then
        return 1
      fi

      if [[ -n "${IMAGE_DIGEST:-}" ]]; then
        if ! shipmastr_governance_is_image_digest "$IMAGE_DIGEST"; then
          shipmastr_governance_fail "STAGING_IMAGE_DIGEST_INVALID"
          return 1
        fi
      elif [[ "${SHIPMASTR_STAGING_BUILD_APPROVAL:-}" != \
        "APPROVE BUILD IMMUTABLE STAGING ARTIFACT" ]]; then
        shipmastr_governance_fail "STAGING_BUILD_APPROVAL_REQUIRED"
        return 1
      fi
      ;;

    production)
      if ! shipmastr_governance_validate_common         production shipmastr-api; then
        return 1
      fi

      if [[ "${SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL:-}" != \
        "APPROVE SHIPMASTR PRODUCTION PROMOTION" ]]; then
        shipmastr_governance_fail "PRODUCTION_PROMOTION_APPROVAL_REQUIRED"
        return 1
      fi

      if [[ "${CONFIRM_PROD_DEPLOY:-}" != "shipmastr-prod" ]]; then
        shipmastr_governance_fail "LEGACY_PRODUCTION_CONFIRMATION_REQUIRED"
        return 1
      fi

      if ! shipmastr_governance_is_image_digest "${IMAGE_DIGEST:-}"; then
        shipmastr_governance_fail \
          "PRODUCTION_IMMUTABLE_IMAGE_DIGEST_REQUIRED"
        return 1
      fi

      if [[ "${SHIPMASTR_STAGING_IMAGE_DIGEST:-}" != "$IMAGE_DIGEST" ]]; then
        shipmastr_governance_fail \
          "PRODUCTION_DIGEST_MUST_MATCH_STAGING_DIGEST"
        return 1
      fi

      if ! shipmastr_governance_verify_staging_evidence \
        "${SHIPMASTR_STAGING_EVIDENCE_FILE:-}" \
        "${SHIPMASTR_STAGING_EVIDENCE_SHA256:-}" \
        "${SHIPMASTR_APPROVED_COMMIT_SHA}" \
        "${IMAGE_DIGEST}"; then
        return 1
      fi

      repo_root="$(shipmastr_governance_repo_root)"
      if ! remote_main_sha="$(
        shipmastr_governance_remote_main_sha "$repo_root"
      )"; then
        return 1
      fi

      if [[ "$remote_main_sha" != "${SHIPMASTR_APPROVED_COMMIT_SHA}" ]]; then
        shipmastr_governance_fail \
          "PRODUCTION_COMMIT_MUST_EQUAL_CURRENT_REMOTE_MAIN"
        return 1
      fi
      ;;

    *)
      shipmastr_governance_fail \
        "DEPLOYMENT_ENVIRONMENT_NOT_ALLOWLISTED"
      return 1
      ;;
  esac
}

shipmastr_production_migration_guard() {
  local repo_root
  local approved_commit
  local head_sha
  local remote_main_sha
  local effective_identity
  local variable_name

  if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
    shipmastr_governance_fail "SERVICE_ACCOUNT_KEY_CREDENTIALS_PROHIBITED"
    return 1
  fi

  if [[ "${SHIPMASTR_PRODUCTION_MIGRATION_APPROVAL:-}" != \
    "APPROVE SHIPMASTR PRODUCTION DATABASE MIGRATION" ]]; then
    shipmastr_governance_fail "PRODUCTION_DATABASE_MIGRATION_APPROVAL_REQUIRED"
    return 1
  fi

  for variable_name in PROJECT PROJECT_ID; do
    if ! shipmastr_governance_assert_unset_or_equal \
      "$variable_name" "shipmastr-core-prod"; then
      return 1
    fi
  done
  shipmastr_governance_assert_unset_or_equal REGION "asia-south1" || return 1
  for variable_name in CLOUD_RUN_SERVICE SERVICE SERVICE_NAME; do
    shipmastr_governance_assert_unset_or_equal \
      "$variable_name" "shipmastr-api" || return 1
  done
  shipmastr_governance_assert_unset_or_equal \
    SERVICE_ACCOUNT \
    "shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com" || return 1
  shipmastr_governance_assert_unset_or_equal \
    CLOUD_SQL_INSTANCE \
    "shipmastr-core-prod:asia-south1:shipmastr-postgres" || return 1

  approved_commit="${SHIPMASTR_APPROVED_COMMIT_SHA:-}"
  if ! shipmastr_governance_is_sha40 "$approved_commit"; then
    shipmastr_governance_fail "APPROVED_COMMIT_SHA_REQUIRED"
    return 1
  fi

  if ! shipmastr_governance_is_image_digest "${IMAGE_DIGEST:-}"; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_IMMUTABLE_IMAGE_DIGEST_REQUIRED"
    return 1
  fi
  if [[ "${SHIPMASTR_STAGING_IMAGE_DIGEST:-}" != "$IMAGE_DIGEST" ]]; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_DIGEST_MUST_MATCH_STAGING_DIGEST"
    return 1
  fi

  if ! shipmastr_governance_validate_new_production_evidence_output \
    "${SHIPMASTR_PRODUCTION_BACKUP_EVIDENCE_OUTPUT:-}"; then
    return 1
  fi
  if ! shipmastr_governance_validate_new_production_evidence_output \
    "${SHIPMASTR_PRODUCTION_MIGRATION_EVIDENCE_OUTPUT:-}"; then
    return 1
  fi
  if [[ "$SHIPMASTR_PRODUCTION_BACKUP_EVIDENCE_OUTPUT" == \
    "$SHIPMASTR_PRODUCTION_MIGRATION_EVIDENCE_OUTPUT" ]]; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_EVIDENCE_OUTPUTS_MUST_BE_DISTINCT"
    return 1
  fi

  repo_root="$(shipmastr_governance_repo_root)"
  if ! shipmastr_governance_git_clean "$repo_root"; then
    shipmastr_governance_fail "SOURCE_REPOSITORY_MUST_BE_CLEAN"
    return 1
  fi
  head_sha="$(shipmastr_governance_head_sha "$repo_root")"
  if [[ "$head_sha" != "$approved_commit" ]]; then
    shipmastr_governance_fail "APPROVED_COMMIT_DOES_NOT_MATCH_HEAD"
    return 1
  fi
  if ! shipmastr_governance_validate_canonical_origin "$repo_root"; then
    return 1
  fi

  if ! shipmastr_governance_verify_staging_evidence \
    "${SHIPMASTR_STAGING_EVIDENCE_FILE:-}" \
    "${SHIPMASTR_STAGING_EVIDENCE_SHA256:-}" \
    "$approved_commit" \
    "$IMAGE_DIGEST"; then
    return 1
  fi

  if ! effective_identity="$(shipmastr_governance_effective_identity)"; then
    return 1
  fi
  if [[ -z "$effective_identity" ]]; then
    shipmastr_governance_fail "EFFECTIVE_DEPLOYMENT_IDENTITY_EMPTY"
    return 1
  fi
  if ! shipmastr_governance_validate_identity \
    production-migration "$effective_identity"; then
    return 1
  fi

  if ! remote_main_sha="$(shipmastr_governance_remote_main_sha "$repo_root")"; then
    return 1
  fi
  if [[ "$remote_main_sha" != "$approved_commit" ]]; then
    shipmastr_governance_fail \
      "PRODUCTION_MIGRATION_COMMIT_MUST_EQUAL_CURRENT_REMOTE_MAIN"
    return 1
  fi

  export PROJECT="shipmastr-core-prod"
  export PROJECT_ID="shipmastr-core-prod"
  export REGION="asia-south1"
  export CLOUD_RUN_SERVICE="shipmastr-api"
  export SERVICE="shipmastr-api"
  export SERVICE_NAME="shipmastr-api"
  export SERVICE_ACCOUNT="shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com"
  export CLOUD_SQL_INSTANCE="shipmastr-core-prod:asia-south1:shipmastr-postgres"
  export SHIPMASTR_GOVERNED_ENVIRONMENT="production-migration"
  export SHIPMASTR_GOVERNED_PUBLIC_ACCESS_MUTATION="disabled"
}

shipmastr_migration_build_guard() {
  local mode="$1"
  local environment
  local required_approval
  local repo_root
  local approved_commit
  local head_sha
  local effective_identity

  case "$mode" in
    status)
      environment="migration-status"
      required_approval="APPROVE SHIPMASTR MIGRATION STATUS IMAGE BUILD"
      ;;
    build)
      environment="migration-build"
      required_approval="APPROVE SHIPMASTR MIGRATION IMAGE BUILD"
      ;;
    *)
      shipmastr_governance_fail "MIGRATION_BUILD_MODE_NOT_ALLOWLISTED"
      return 1
      ;;
  esac

  if [[ "${SHIPMASTR_MIGRATION_BUILD_APPROVAL:-}" != "$required_approval" ]]; then
    shipmastr_governance_fail "MIGRATION_BUILD_APPROVAL_REQUIRED"
    return 1
  fi

  if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
    shipmastr_governance_fail "SERVICE_ACCOUNT_KEY_CREDENTIALS_PROHIBITED"
    return 1
  fi

  repo_root="$(shipmastr_governance_repo_root)"
  if ! shipmastr_governance_git_clean "$repo_root"; then
    shipmastr_governance_fail "SOURCE_REPOSITORY_MUST_BE_CLEAN"
    return 1
  fi

  approved_commit="${SHIPMASTR_APPROVED_COMMIT_SHA:-}"
  if ! shipmastr_governance_is_sha40 "$approved_commit"; then
    shipmastr_governance_fail "APPROVED_COMMIT_SHA_REQUIRED"
    return 1
  fi

  head_sha="$(shipmastr_governance_head_sha "$repo_root")"
  if [[ "$head_sha" != "$approved_commit" ]]; then
    shipmastr_governance_fail "APPROVED_COMMIT_DOES_NOT_MATCH_HEAD"
    return 1
  fi

  if ! effective_identity="$(
    shipmastr_governance_effective_identity
  )"; then
    return 1
  fi

  if ! shipmastr_governance_validate_identity \
    "$environment" "$effective_identity"; then
    return 1
  fi

  export PROJECT_ID="shipmastr-core-prod"
  export REGION="asia-south1"
}
