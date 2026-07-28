#!/usr/bin/env bash
set -euo pipefail
set -f

# Shipmastr I5B-1 governed deployment gate.
# This file validates authority and deployment inputs only.
# It performs no deployment by itself and authorizes no load-balancer work.

SHIPMASTR_GOVERNANCE_VERSION="2"

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

shipmastr_governance_origin_main_sha() {
  local repo_root="$1"
  git -C "$repo_root" rev-parse refs/remotes/origin/main
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
  local origin_main_sha

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

      if ! shipmastr_governance_is_sha256 \
        "${SHIPMASTR_STAGING_EVIDENCE_SHA256:-}"; then
        shipmastr_governance_fail "STAGING_EVIDENCE_SHA256_REQUIRED"
        return 1
      fi

      repo_root="$(shipmastr_governance_repo_root)"
      origin_main_sha="$(shipmastr_governance_origin_main_sha "$repo_root")"
      if [[ "$origin_main_sha" != "${SHIPMASTR_APPROVED_COMMIT_SHA}" ]]; then
        shipmastr_governance_fail \
          "PRODUCTION_COMMIT_MUST_EQUAL_ORIGIN_MAIN"
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
