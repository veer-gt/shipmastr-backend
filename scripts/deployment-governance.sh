#!/usr/bin/env bash
set -euo pipefail
set -f

# Shipmastr I5B-1 governed deployment gate.
# This file validates authority and deployment inputs only.
# It performs no deployment by itself and authorizes no load-balancer work.

SHIPMASTR_GOVERNANCE_VERSION="5"

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

shipmastr_governance_is_staging_revision() {
  local revision="$1"

  [[ "${#revision}" -le 63 && \
    "$revision" =~ ^shipmastr-api-staging-[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]
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
    production|migration-status|migration-build)
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
