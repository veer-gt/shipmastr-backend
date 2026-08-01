#!/usr/bin/env bash
set -euo pipefail
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/deployment-governance.sh"

TEST_SHA="0123456789abcdef0123456789abcdef01234567"
TEST_DIGEST="asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
OTHER_DIGEST="asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api@sha256:2222222222222222222222222222222222222222222222222222222222222222"
TEST_EVIDENCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TEST_REVISION="shipmastr-api-staging-00042-test"
TEST_COMMIT_PREFIX="0123456"
TEST_INVOCATION_UTC="20260801123456"
TEST_PID_FRAGMENT="12345"
TEST_REVISION_SUFFIX="sf-${TEST_COMMIT_PREFIX}-${TEST_INVOCATION_UTC}-${TEST_PID_FRAGMENT}"
TEST_CANDIDATE_TAG="c-${TEST_COMMIT_PREFIX}-${TEST_INVOCATION_UTC:6:8}-${TEST_PID_FRAGMENT}"

pass_count=0

expect_pass() {
  local name="$1"
  local output
  local status
  shift

  set +e
  output="$( ( set -e; "$@" ) 2>&1 )"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    pass_count=$((pass_count + 1))
  else
    echo "TEST_FAILED_EXPECTED_PASS=$name" >&2
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output" >&2
    fi
    exit 1
  fi
}

expect_fail() {
  local name="$1"
  local status
  shift

  set +e
  ( set -e; "$@" ) >/dev/null 2>&1
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    echo "TEST_FAILED_EXPECTED_DENIAL=$name" >&2
    exit 1
  else
    pass_count=$((pass_count + 1))
  fi
}

# Offline mocks live only in this test file. Production governance contains no
# caller-controlled branch that can activate them.
MOCK_REPO_CLEAN=1
MOCK_HEAD_SHA="$TEST_SHA"
MOCK_ORIGIN_MAIN_SHA="$TEST_SHA"
MOCK_REMOTE_MAIN_SHA="$TEST_SHA"
MOCK_EFFECTIVE_IDENTITY=""

shipmastr_governance_git_clean() {
  [[ "$MOCK_REPO_CLEAN" == "1" ]]
}

shipmastr_governance_head_sha() {
  printf '%s\n' "$MOCK_HEAD_SHA"
}

shipmastr_governance_remote_main_sha() {
  printf '%s\n' "$MOCK_REMOTE_MAIN_SHA"
}

shipmastr_governance_effective_identity() {
  printf '%s\n' "$MOCK_EFFECTIVE_IDENTITY"
}

MOCK_SECRET_METADATA_MODE="valid"
MOCK_SECRET_ENVIRONMENT="staging"
MOCK_SECRET_PURPOSE="platform-credential-encryption"

gcloud() {
  if [[ "${1:-}" == "secrets" && "${2:-}" == "describe" ]]; then
    if [[ "$MOCK_SECRET_METADATA_MODE" == "missing" ]]; then
      return 1
    fi

    printf '%s\t%s\n' \
      "$MOCK_SECRET_ENVIRONMENT" \
      "$MOCK_SECRET_PURPOSE"
    return 0
  fi

  if [[ "${1:-}" == "secrets" && "${2:-}" == "versions" && \
    "${3:-}" == "list" ]]; then
    if [[ "$MOCK_SECRET_METADATA_MODE" != "no-enabled-version" ]]; then
      printf '%s\n' '1'
    fi
    return 0
  fi

  return 127
}

base_env() {
  MOCK_REPO_CLEAN=1
  MOCK_HEAD_SHA="$TEST_SHA"
  MOCK_ORIGIN_MAIN_SHA="$TEST_SHA"
  MOCK_REMOTE_MAIN_SHA="$TEST_SHA"
  MOCK_EFFECTIVE_IDENTITY=""

  export SHIPMASTR_APPROVED_COMMIT_SHA="$TEST_SHA"
  export SHIPMASTR_PUBLIC_ACCESS_EXPECTATION=public
  export SHIPMASTR_PUBLIC_ACCESS_APPROVAL='APPROVE RETAIN CURRENT PUBLIC INVOCATION STATE'

  unset GOOGLE_APPLICATION_CREDENTIALS
  unset PROJECT PROJECT_ID REGION
  unset SERVICE SERVICE_NAME CLOUD_RUN_SERVICE
  unset SERVICE_ACCOUNT CLOUD_SQL_INSTANCE
  unset SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL
  unset SHIPMASTR_STAGING_DEPLOY_APPROVAL
  unset SHIPMASTR_STAGING_BUILD_APPROVAL
  unset SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL
  unset SHIPMASTR_MIGRATION_BUILD_APPROVAL
  unset IMAGE_DIGEST
  unset SHIPMASTR_STAGING_IMAGE_DIGEST
  unset SHIPMASTR_STAGING_EVIDENCE_FILE
  unset SHIPMASTR_STAGING_EVIDENCE_SHA256
  export SHIPMASTR_STAGING_EVIDENCE_OUTPUT="/tmp/shipmastr-i5b1-evidence-$$-${RANDOM}.env"
  rm -f "$SHIPMASTR_STAGING_EVIDENCE_OUTPUT"
  unset CONFIRM_PROD_DEPLOY

  # Former production test-mode variables must have no effect.
  unset SHIPMASTR_GOVERNANCE_TEST_MODE
  unset SHIPMASTR_TEST_REPO_CLEAN
  unset SHIPMASTR_TEST_HEAD_SHA
  unset SHIPMASTR_TEST_ORIGIN_MAIN_SHA
  unset SHIPMASTR_TEST_EFFECTIVE_IDENTITY
}

staging_positive() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

staging_prebuilt_positive() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export IMAGE_DIGEST="$TEST_DIGEST"
  shipmastr_deployment_guard staging
}

staging_wrong_identity() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

staging_dirty() {
  base_env
  MOCK_REPO_CLEAN=0
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

staging_legacy_target() {
  base_env
  export SERVICE_NAME='shipmastr-api-canary'
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

production_positive() {
  local temp_dir
  local evidence_file
  local evidence_sha

  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  MOCK_REMOTE_MAIN_SHA="$TEST_SHA"

  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence.env"

  evidence_sha="$(
    shipmastr_governance_write_staging_evidence \
      "$evidence_file" \
      "$TEST_SHA" \
      "$TEST_DIGEST" \
      "$TEST_REVISION"
  )"

  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  export IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_EVIDENCE_FILE="$evidence_file"
  export SHIPMASTR_STAGING_EVIDENCE_SHA256="$evidence_sha"

  shipmastr_deployment_guard production

  rm -rf "$temp_dir"
}

production_missing_digest() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  shipmastr_deployment_guard production
}

production_digest_mismatch() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  export IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_IMAGE_DIGEST="$OTHER_DIGEST"
  export SHIPMASTR_STAGING_EVIDENCE_SHA256="$TEST_EVIDENCE_SHA"
  shipmastr_deployment_guard production
}

owner_without_break_glass() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='indraveer.chauhan@gmail.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

owner_with_break_glass() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='indraveer.chauhan@gmail.com'
  export SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL='APPROVE SHIPMASTR OWNER BREAK GLASS DEPLOYMENT'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

key_file_rejected() {
  base_env
  export GOOGLE_APPLICATION_CREDENTIALS='/tmp/forbidden.json'
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}

public_approval_required() {
  base_env
  unset SHIPMASTR_PUBLIC_ACCESS_APPROVAL
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  shipmastr_deployment_guard staging
}


staging_evidence_output_required() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY'
  export SHIPMASTR_STAGING_BUILD_APPROVAL='APPROVE BUILD IMMUTABLE STAGING ARTIFACT'
  unset SHIPMASTR_STAGING_EVIDENCE_OUTPUT
  shipmastr_deployment_guard staging
}

staging_secret_metadata_positive() {
  MOCK_SECRET_METADATA_MODE="valid"
  MOCK_SECRET_ENVIRONMENT="staging"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY \
    staging
}

staging_secret_wrong_environment_rejected() {
  MOCK_SECRET_METADATA_MODE="valid"
  MOCK_SECRET_ENVIRONMENT="production"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY \
    staging
}

staging_secret_wrong_purpose_rejected() {
  MOCK_SECRET_METADATA_MODE="valid"
  MOCK_SECRET_ENVIRONMENT="staging"
  MOCK_SECRET_PURPOSE="not-platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY \
    staging
}

production_secret_metadata_positive() {
  MOCK_SECRET_METADATA_MODE="valid"
  MOCK_SECRET_ENVIRONMENT="production"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD \
    production
}

production_secret_missing_rejected() {
  MOCK_SECRET_METADATA_MODE="missing"
  MOCK_SECRET_ENVIRONMENT="production"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD \
    production
}

production_secret_staging_label_rejected() {
  MOCK_SECRET_METADATA_MODE="valid"
  MOCK_SECRET_ENVIRONMENT="staging"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD \
    production
}

secret_enabled_version_required() {
  MOCK_SECRET_METADATA_MODE="no-enabled-version"
  MOCK_SECRET_ENVIRONMENT="staging"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY \
    staging
}

production_secret_enabled_version_required() {
  MOCK_SECRET_METADATA_MODE="no-enabled-version"
  MOCK_SECRET_ENVIRONMENT="production"
  MOCK_SECRET_PURPOSE="platform-credential-encryption"
  shipmastr_governance_verify_secret_metadata \
    shipmastr-core-prod \
    PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD \
    production
}

rewrite_evidence_field() {
  local evidence_file="$1"
  local key="$2"
  local value="$3"

  node - "$evidence_file" "$key" "$value" <<'NODE'
const fs = require("node:fs");
const [path, key, value] = process.argv.slice(2);
const lines = fs.readFileSync(path, "utf8").trimEnd().split("\n");
let found = false;
const updated = lines.map((line) => {
  if (line.startsWith(`${key}=`)) {
    found = true;
    return `${key}=${value}`;
  }
  return line;
});
if (!found) process.exit(2);
fs.writeFileSync(path, `${updated.join("\n")}\n`);
NODE
}

remove_evidence_field() {
  local evidence_file="$1"
  local key="$2"

  node - "$evidence_file" "$key" <<'NODE'
const fs = require("node:fs");
const [path, key] = process.argv.slice(2);
const lines = fs.readFileSync(path, "utf8").trimEnd().split("\n");
const updated = lines.filter((line) => !line.startsWith(`${key}=`));
if (updated.length !== lines.length - 1) process.exit(2);
fs.writeFileSync(path, `${updated.join("\n")}\n`);
NODE
}

run_evidence_verification_scenario() {
  local mode="$1"
  local temp_dir
  local evidence_file
  local evidence_sha
  local expected_sha
  local expected_commit="$TEST_SHA"
  local expected_digest="$TEST_DIGEST"
  local verify_status

  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence.env"
  evidence_sha="$(
    shipmastr_governance_write_staging_evidence \
      "$evidence_file" \
      "$TEST_SHA" \
      "$TEST_DIGEST" \
      "$TEST_REVISION"
  )"
  expected_sha="$evidence_sha"

  case "$mode" in
    valid)
      ;;
    duplicate-key)
      printf '%s\n' 'service=shipmastr-api-staging' >> "$evidence_file"
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    unknown-key)
      printf '%s\n' 'unexpected=value' >> "$evidence_file"
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    missing-key)
      remove_evidence_field "$evidence_file" active_health_api
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    malformed-expected-commit)
      expected_commit='not-a-sha'
      ;;
    malformed-expected-digest)
      expected_digest='sha256:not-an-allowlisted-digest'
      ;;
    invalid-revision-prefix)
      rewrite_evidence_field "$evidence_file" revision 'shipmastr-api-prod-00042-test'
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    trailing-hyphen-revision)
      rewrite_evidence_field "$evidence_file" revision 'shipmastr-api-staging-invalid-'
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    overlength-revision)
      rewrite_evidence_field "$evidence_file" revision \
        'shipmastr-api-staging-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    impossible-utc)
      rewrite_evidence_field "$evidence_file" created_utc '2026-02-31T29:00:00Z'
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    commit-mismatch)
      rewrite_evidence_field "$evidence_file" commit_sha \
        '2222222222222222222222222222222222222222'
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    digest-mismatch)
      rewrite_evidence_field "$evidence_file" image_digest "$OTHER_DIGEST"
      expected_sha="$(shipmastr_governance_sha256_file "$evidence_file")"
      ;;
    hash-mismatch)
      expected_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      ;;
    *)
      rm -rf "$temp_dir"
      return 2
      ;;
  esac

  set +e
  shipmastr_governance_verify_staging_evidence \
    "$evidence_file" \
    "$expected_sha" \
    "$expected_commit" \
    "$expected_digest"
  verify_status=$?
  set -e

  rm -rf "$temp_dir"
  return "$verify_status"
}

evidence_v2_valid() {
  run_evidence_verification_scenario valid
}

evidence_duplicate_key_rejected() {
  run_evidence_verification_scenario duplicate-key
}

evidence_unknown_key_rejected() {
  run_evidence_verification_scenario unknown-key
}

evidence_missing_key_rejected() {
  run_evidence_verification_scenario missing-key
}

evidence_malformed_expected_commit_rejected() {
  run_evidence_verification_scenario malformed-expected-commit
}

evidence_malformed_expected_digest_rejected() {
  run_evidence_verification_scenario malformed-expected-digest
}

evidence_invalid_revision_prefix_rejected() {
  run_evidence_verification_scenario invalid-revision-prefix
}

evidence_trailing_hyphen_revision_rejected() {
  run_evidence_verification_scenario trailing-hyphen-revision
}

evidence_overlength_revision_rejected() {
  run_evidence_verification_scenario overlength-revision
}

evidence_impossible_utc_rejected() {
  run_evidence_verification_scenario impossible-utc
}

evidence_commit_mismatch_rejected() {
  run_evidence_verification_scenario commit-mismatch
}

evidence_digest_mismatch_rejected() {
  run_evidence_verification_scenario digest-mismatch
}

evidence_hash_mismatch_rejected() {
  run_evidence_verification_scenario hash-mismatch
}

evidence_writer_rejects_invalid_revision() {
  local temp_dir
  local evidence_file

  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence.env"

  if shipmastr_governance_write_staging_evidence \
    "$evidence_file" \
    "$TEST_SHA" \
    "$TEST_DIGEST" \
    'shipmastr-api-staging-invalid-'; then
    rm -rf "$temp_dir"
    return 0
  fi

  [[ ! -e "$evidence_file" ]]
  rm -rf "$temp_dir"
  return 1
}

production_evidence_hash_mismatch() {
  local temp_dir
  local evidence_file

  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  MOCK_REMOTE_MAIN_SHA="$TEST_SHA"

  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence.env"

  shipmastr_governance_write_staging_evidence \
    "$evidence_file" \
    "$TEST_SHA" \
    "$TEST_DIGEST" \
    "$TEST_REVISION" \
    >/dev/null

  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  export IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_EVIDENCE_FILE="$evidence_file"
  export SHIPMASTR_STAGING_EVIDENCE_SHA256='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  shipmastr_deployment_guard production
}

production_evidence_commit_mismatch() {
  local temp_dir
  local evidence_file
  local evidence_sha
  local other_sha

  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  MOCK_REMOTE_MAIN_SHA="$TEST_SHA"

  other_sha='2222222222222222222222222222222222222222'
  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence.env"

  evidence_sha="$(
    shipmastr_governance_write_staging_evidence \
      "$evidence_file" \
      "$other_sha" \
      "$TEST_DIGEST" \
      "$TEST_REVISION"
  )"

  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  export IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_EVIDENCE_FILE="$evidence_file"
  export SHIPMASTR_STAGING_EVIDENCE_SHA256="$evidence_sha"

  shipmastr_deployment_guard production
}

production_rejects_v1_evidence() {
  local temp_dir
  local evidence_file
  local evidence_sha

  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  MOCK_REMOTE_MAIN_SHA="$TEST_SHA"

  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence-v1.env"

  cat > "$evidence_file" <<EOF
evidence_type=SHIPMASTR_STAGING_DEPLOYMENT_EVIDENCE_V1
project_id=shipmastr-core-prod
region=asia-south1
service=shipmastr-api-staging
commit_sha=$TEST_SHA
image_digest=$TEST_DIGEST
migration_status=PASS
health_v1=PASS
health_api=PASS
public_access_mutation=disabled
created_utc=2026-08-01T00:00:00Z
EOF

  evidence_sha="$(shipmastr_governance_sha256_file "$evidence_file")"

  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  export IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_EVIDENCE_FILE="$evidence_file"
  export SHIPMASTR_STAGING_EVIDENCE_SHA256="$evidence_sha"

  shipmastr_deployment_guard production
}

production_remote_main_mismatch() {
  local temp_dir
  local evidence_file
  local evidence_sha

  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  MOCK_REMOTE_MAIN_SHA='3333333333333333333333333333333333333333'

  temp_dir="$(mktemp -d)"
  evidence_file="$temp_dir/staging-evidence.env"

  evidence_sha="$(
    shipmastr_governance_write_staging_evidence \
      "$evidence_file" \
      "$TEST_SHA" \
      "$TEST_DIGEST" \
      "$TEST_REVISION"
  )"

  export SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION'
  export CONFIRM_PROD_DEPLOY='shipmastr-prod'
  export IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_IMAGE_DIGEST="$TEST_DIGEST"
  export SHIPMASTR_STAGING_EVIDENCE_FILE="$evidence_file"
  export SHIPMASTR_STAGING_EVIDENCE_SHA256="$evidence_sha"

  shipmastr_deployment_guard production
}

migration_status_positive() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_MIGRATION_BUILD_APPROVAL='APPROVE SHIPMASTR MIGRATION STATUS IMAGE BUILD'
  shipmastr_migration_build_guard status
}

migration_wrong_identity() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  export SHIPMASTR_MIGRATION_BUILD_APPROVAL='APPROVE SHIPMASTR MIGRATION STATUS IMAGE BUILD'
  shipmastr_migration_build_guard status
}

migration_build_without_approval() {
  base_env
  MOCK_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  shipmastr_migration_build_guard build
}

prepare_staging_wrapper_fixture() {
  local temp_dir="$1"

  STAGING_FIXTURE_REPO="$temp_dir/repo"
  STAGING_FIXTURE_MOCK_BIN="$temp_dir/mock-bin"
  STAGING_FIXTURE_STATE_DIR="$temp_dir/state"
  STAGING_FIXTURE_LOG="$temp_dir/commands.log"
  STAGING_FIXTURE_EVIDENCE="$temp_dir/staging-evidence.env"
  STAGING_FIXTURE_OUTPUT="$temp_dir/wrapper.out"
  STAGING_FIXTURE_MODE="success"
  STAGING_FIXTURE_SECRET_MODE="valid"
  STAGING_FIXTURE_SERVICE_OVERRIDE=""
  STAGING_FIXTURE_SERVICE_OVERRIDE_SET=0
  STAGING_FIXTURE_DATE_MODE="valid"

  mkdir -p \
    "$STAGING_FIXTURE_REPO/scripts" \
    "$STAGING_FIXTURE_MOCK_BIN" \
    "$STAGING_FIXTURE_STATE_DIR"
  cp "$SCRIPT_DIR/deploy-staging.sh" "$STAGING_FIXTURE_REPO/scripts/"
  cp "$SCRIPT_DIR/deployment-governance.sh" "$STAGING_FIXTURE_REPO/scripts/"

  git -C "$STAGING_FIXTURE_REPO" init -q
  git -C "$STAGING_FIXTURE_REPO" config user.name 'Shipmastr Governance Test'
  git -C "$STAGING_FIXTURE_REPO" config user.email 'governance-test@shipmastr.invalid'
  git -C "$STAGING_FIXTURE_REPO" remote add origin \
    'https://github.com/veer-gt/shipmastr-backend.git'
  git -C "$STAGING_FIXTURE_REPO" add scripts
  git -C "$STAGING_FIXTURE_REPO" \
    -c commit.gpgsign=false \
    commit -qm 'test: staging wrapper fixture'

  STAGING_FIXTURE_HEAD="$(git -C "$STAGING_FIXTURE_REPO" rev-parse HEAD)"
  STAGING_FIXTURE_SERVICE_URL="https://staging.example.invalid"

  cat > "$STAGING_FIXTURE_MOCK_BIN/gcloud" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf 'gcloud %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"

argument_after() {
  local expected_flag="$1"
  shift
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "$expected_flag" ]]; then
      [[ "$#" -ge 2 ]] || exit 90
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

increment_counter() {
  local counter_path="$1"
  local count=0
  if [[ -f "$counter_path" ]]; then
    read -r count < "$counter_path"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$counter_path"
  printf '%s\n' "$count"
}

if [[ "${1:-}" == "auth" && "${2:-}" == "list" ]]; then
  printf '%s\n' 'shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  exit 0
fi

if [[ "${1:-}" == "config" && "${2:-}" == "get-value" ]]; then
  printf '%s\n' '(unset)'
  exit 0
fi

if [[ "${1:-}" == "secrets" && "${2:-}" == "describe" ]]; then
  [[ "${3:-}" == "PLATFORM_CREDENTIAL_ENCRYPTION_KEY" ]] || exit 91
  case "${SHIPMASTR_TEST_SECRET_MODE:-valid}" in
    valid|no-enabled)
      printf 'staging\tplatform-credential-encryption\n'
      ;;
    missing)
      exit 1
      ;;
    wrong-environment)
      printf 'production\tplatform-credential-encryption\n'
      ;;
    wrong-purpose)
      printf 'staging\tnot-platform-credential-encryption\n'
      ;;
    *)
      exit 92
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "secrets" && "${2:-}" == "versions" && \
  "${3:-}" == "list" ]]; then
  [[ "${4:-}" == "PLATFORM_CREDENTIAL_ENCRYPTION_KEY" ]] || exit 93
  if [[ "${SHIPMASTR_TEST_SECRET_MODE:-valid}" != "no-enabled" ]]; then
    printf '%s\n' '1'
  fi
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "jobs" && \
  ( "${3:-}" == "deploy" || "${3:-}" == "execute" ) ]]; then
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "deploy" ]]; then
  service="${3:-}"
  revision_suffix="$(argument_after --revision-suffix "$@")"
  candidate_tag="$(argument_after --tag "$@")"
  image_digest="$(argument_after --image "$@")"
  [[ "$service" == "shipmastr-api-staging" ]] || exit 94
  [[ "$candidate_tag" != "$revision_suffix" ]] || exit 95
  [[ "$revision_suffix" =~ ^sf-[0-9a-f]{7}-[0-9]{14}-[0-9]{5}$ ]] || exit 95
  [[ "$candidate_tag" =~ ^c-[0-9a-f]{7}-[0-9]{8}-[0-9]{5}$ ]] || exit 95
  [[ "${revision_suffix##*-}" == "${candidate_tag##*-}" ]] || exit 95
  [[ "$image_digest" == "${SHIPMASTR_TEST_DIGEST:?}" ]] || exit 96
  [[ " $* " == *" --format=json "* ]] || exit 97
  [[ " $* " == *" --no-traffic "* ]] || exit 98

  expected_revision="${service}-${revision_suffix}"
  candidate_url="https://${candidate_tag}---staging.example.invalid"
  printf '%s\n' "$expected_revision" > "${SHIPMASTR_TEST_STATE_DIR:?}/expected-revision"
  printf '%s\n' "$revision_suffix" > "${SHIPMASTR_TEST_STATE_DIR:?}/revision-suffix"
  printf '%s\n' "$candidate_tag" > "${SHIPMASTR_TEST_STATE_DIR:?}/candidate-tag"
  printf '%s\n' "$candidate_url" > "${SHIPMASTR_TEST_STATE_DIR:?}/candidate-url"

  reported_revision="$expected_revision"
  if [[ "${SHIPMASTR_TEST_MODE:-success}" == "deploy-result-mismatch" ]]; then
    reported_revision="shipmastr-api-staging-unexpected"
  fi

  printf '{"status":{"latestCreatedRevisionName":"%s"}}\n' "$reported_revision"
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "revisions" && \
  "${3:-}" == "describe" ]]; then
  [[ -f "${SHIPMASTR_TEST_STATE_DIR:?}/expected-revision" ]] || exit 99
  read -r expected_revision < "${SHIPMASTR_TEST_STATE_DIR:?}/expected-revision"
  [[ "${4:-}" == "$expected_revision" ]] || exit 100
  increment_counter "${SHIPMASTR_TEST_STATE_DIR:?}/revision-count" >/dev/null

  if [[ "${SHIPMASTR_TEST_MODE:-success}" == "revision-missing" ]]; then
    exit 1
  fi

  revision_digest="${SHIPMASTR_TEST_DIGEST:?}"
  ready_status="True"
  service_label="shipmastr-api-staging"
  case "${SHIPMASTR_TEST_MODE:-success}" in
    digest-mismatch)
      revision_digest="${SHIPMASTR_TEST_OTHER_DIGEST:?}"
      ;;
    active-digest-mismatch)
      if [[ -f "${SHIPMASTR_TEST_STATE_DIR:?}/traffic-moved" ]]; then
        revision_digest="${SHIPMASTR_TEST_OTHER_DIGEST:?}"
      fi
      ;;
    revision-not-ready)
      ready_status="False"
      ;;
    revision-wrong-service)
      service_label="shipmastr-api"
      ;;
  esac

  printf '{"metadata":{"name":"%s","labels":{"serving.knative.dev/service":"%s"}},"spec":{"containers":[{"image":"%s"}]},"status":{"conditions":[{"type":"Ready","status":"%s"}]}}\n' \
    "$expected_revision" \
    "$service_label" \
    "$revision_digest" \
    "$ready_status"
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "services" && \
  "${3:-}" == "describe" ]]; then
  [[ -f "${SHIPMASTR_TEST_STATE_DIR:?}/expected-revision" ]] || exit 101
  read -r expected_revision < "${SHIPMASTR_TEST_STATE_DIR:?}/expected-revision"
  read -r candidate_tag < "${SHIPMASTR_TEST_STATE_DIR:?}/candidate-tag"
  read -r candidate_url < "${SHIPMASTR_TEST_STATE_DIR:?}/candidate-url"
  service_count="$(increment_counter "${SHIPMASTR_TEST_STATE_DIR:?}/service-count")"

  latest_created="$expected_revision"
  if [[ "${SHIPMASTR_TEST_MODE:-success}" == "latest-created-changed" && \
    "$service_count" -ge 2 ]]; then
    latest_created="shipmastr-api-staging-concurrent"
  fi

  if [[ -f "${SHIPMASTR_TEST_STATE_DIR:?}/traffic-moved" ]]; then
    latest_ready="$expected_revision"
    positive_revision="$expected_revision"
    positive_percent=100
    case "${SHIPMASTR_TEST_MODE:-success}" in
      traffic-no-positive)
        positive_percent=0
        ;;
      traffic-less-than-100)
        positive_percent=50
        ;;
      traffic-other-revision)
        positive_revision="shipmastr-api-staging-other"
        ;;
      active-ready-mismatch)
        latest_ready="shipmastr-api-staging-other"
        ;;
    esac

    printf '{"status":{"url":"%s","latestCreatedRevisionName":"%s","latestReadyRevisionName":"%s","traffic":[{"revisionName":"%s","percent":%s},{"revisionName":"%s","tag":"%s","url":"%s","percent":0}]}}\n' \
      "${SHIPMASTR_TEST_SERVICE_URL:?}" \
      "$latest_created" \
      "$latest_ready" \
      "$positive_revision" \
      "$positive_percent" \
      "$expected_revision" \
      "$candidate_tag" \
      "$candidate_url"
    exit 0
  fi

  tag_entries="[{\"revisionName\":\"${expected_revision}\",\"tag\":\"${candidate_tag}\",\"url\":\"${candidate_url}\",\"percent\":0}]"
  case "${SHIPMASTR_TEST_MODE:-success}" in
    tag-missing)
      tag_entries='[]'
      ;;
    tag-duplicate)
      tag_entries="[{\"revisionName\":\"${expected_revision}\",\"tag\":\"${candidate_tag}\",\"url\":\"${candidate_url}\",\"percent\":0},{\"revisionName\":\"${expected_revision}\",\"tag\":\"${candidate_tag}\",\"url\":\"${candidate_url}\",\"percent\":0}]"
      ;;
    tag-other-revision|stale-tag)
      tag_entries="[{\"revisionName\":\"shipmastr-api-staging-stale\",\"tag\":\"${candidate_tag}\",\"url\":\"${candidate_url}\",\"percent\":0}]"
      ;;
    tag-nonzero)
      tag_entries="[{\"revisionName\":\"${expected_revision}\",\"tag\":\"${candidate_tag}\",\"url\":\"${candidate_url}\",\"percent\":1}]"
      ;;
  esac

  printf '{"status":{"url":"%s","latestCreatedRevisionName":"%s","latestReadyRevisionName":"shipmastr-api-staging-old","traffic":%s}}\n' \
    "${SHIPMASTR_TEST_SERVICE_URL:?}" \
    "$latest_created" \
    "$tag_entries"
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "services" && \
  "${3:-}" == "update-traffic" ]]; then
  read -r expected_revision < "${SHIPMASTR_TEST_STATE_DIR:?}/expected-revision"
  traffic_target="$(argument_after --to-revisions "$@")"
  [[ "$traffic_target" == "${expected_revision}=100" ]] || exit 102
  [[ " $* " == *" --quiet "* ]] || exit 103
  printf '%s\n' 'yes' > "${SHIPMASTR_TEST_STATE_DIR:?}/traffic-moved"
  exit 0
fi

echo "UNEXPECTED_GCLOUD_COMMAND=$*" >&2
exit 97
MOCK

  cat > "$STAGING_FIXTURE_MOCK_BIN/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf 'curl %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"

request_url=""
for argument in "$@"; do
  request_url="$argument"
done

case "$request_url" in
  https://c-*---staging.example.invalid/v1/health|\
  https://c-*---staging.example.invalid/api/health|\
  https://staging.example.invalid/v1/health|\
  https://staging.example.invalid/api/health)
    ;;
  *)
    exit 97
    ;;
esac

case "${SHIPMASTR_TEST_MODE:-success}" in
  candidate-v1-failure)
    [[ "$request_url" == *"---staging.example.invalid/v1/health" ]] && exit 22
    ;;
  candidate-api-failure)
    [[ "$request_url" == *"---staging.example.invalid/api/health" ]] && exit 22
    ;;
  active-v1-failure)
    [[ "$request_url" == "${SHIPMASTR_TEST_SERVICE_URL:?}/v1/health" ]] && exit 22
    ;;
  active-api-failure)
    [[ "$request_url" == "${SHIPMASTR_TEST_SERVICE_URL:?}/api/health" ]] && exit 22
    ;;
esac

exit 0
MOCK

  cat > "$STAGING_FIXTURE_MOCK_BIN/date" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf 'date %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"

case "$*" in
  '-u +%Y%m%d%H%M%S')
    case "${SHIPMASTR_TEST_DATE_MODE:-valid}" in
      valid)
        printf '%s\n' '20260801123456'
        ;;
      failure)
        exit 97
        ;;
      empty)
        ;;
      short)
        printf '%s\n' '2026080112345'
        ;;
      long)
        printf '%s\n' '202608011234567'
        ;;
      nonnumeric)
        printf '%s\n' '20260801x23456'
        ;;
      *)
        exit 97
        ;;
    esac
    ;;
  '-u +%Y-%m-%dT%H:%M:%SZ')
    [[ "${SHIPMASTR_TEST_DATE_MODE:-valid}" == "valid" ]] || exit 97
    printf '%s\n' '2026-08-01T12:34:56Z'
    ;;
  *)
    exit 97
    ;;
esac
MOCK

  chmod 700 \
    "$STAGING_FIXTURE_MOCK_BIN/gcloud" \
    "$STAGING_FIXTURE_MOCK_BIN/curl" \
    "$STAGING_FIXTURE_MOCK_BIN/date"
}

execute_staging_wrapper_fixture() {
  (
    unset GOOGLE_APPLICATION_CREDENTIALS
    unset PROJECT PROJECT_ID REGION
    unset SERVICE SERVICE_NAME CLOUD_RUN_SERVICE
    unset SERVICE_ACCOUNT CLOUD_SQL_INSTANCE
    unset SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL
    unset SHIPMASTR_STAGING_BUILD_APPROVAL
    unset SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL
    unset SHIPMASTR_GOVERNANCE_TEST_MODE
    unset SHIPMASTR_TEST_REPO_CLEAN
    unset SHIPMASTR_TEST_HEAD_SHA
    unset SHIPMASTR_TEST_ORIGIN_MAIN_SHA
    unset SHIPMASTR_TEST_EFFECTIVE_IDENTITY

    if [[ "$STAGING_FIXTURE_SERVICE_OVERRIDE_SET" == "1" ]]; then
      export SERVICE="$STAGING_FIXTURE_SERVICE_OVERRIDE"
    fi

    PATH="$STAGING_FIXTURE_MOCK_BIN:$PATH" \
    SHIPMASTR_TEST_COMMAND_LOG="$STAGING_FIXTURE_LOG" \
    SHIPMASTR_TEST_STATE_DIR="$STAGING_FIXTURE_STATE_DIR" \
    SHIPMASTR_TEST_SERVICE_URL="$STAGING_FIXTURE_SERVICE_URL" \
    SHIPMASTR_TEST_MODE="$STAGING_FIXTURE_MODE" \
    SHIPMASTR_TEST_SECRET_MODE="$STAGING_FIXTURE_SECRET_MODE" \
    SHIPMASTR_TEST_DATE_MODE="$STAGING_FIXTURE_DATE_MODE" \
    SHIPMASTR_TEST_DIGEST="$TEST_DIGEST" \
    SHIPMASTR_TEST_OTHER_DIGEST="$OTHER_DIGEST" \
    SHIPMASTR_APPROVED_COMMIT_SHA="$STAGING_FIXTURE_HEAD" \
    SHIPMASTR_PUBLIC_ACCESS_EXPECTATION=public \
    SHIPMASTR_PUBLIC_ACCESS_APPROVAL='APPROVE RETAIN CURRENT PUBLIC INVOCATION STATE' \
    SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY' \
    SHIPMASTR_STAGING_EVIDENCE_OUTPUT="$STAGING_FIXTURE_EVIDENCE" \
    MIGRATION_STATUS_JOB='shipmastr-prisma-migrate-status-prod' \
    IMAGE_DIGEST="$TEST_DIGEST" \
    /bin/bash "$STAGING_FIXTURE_REPO/scripts/deploy-staging.sh"
  ) >"$STAGING_FIXTURE_OUTPUT" 2>&1
}

load_staging_fixture_identity() {
  read -r STAGING_FIXTURE_REVISION < "$STAGING_FIXTURE_STATE_DIR/expected-revision"
  read -r STAGING_FIXTURE_REVISION_SUFFIX < "$STAGING_FIXTURE_STATE_DIR/revision-suffix"
  read -r STAGING_FIXTURE_TAG < "$STAGING_FIXTURE_STATE_DIR/candidate-tag"
  read -r STAGING_FIXTURE_CANDIDATE_URL < "$STAGING_FIXTURE_STATE_DIR/candidate-url"
}

staging_external_command_mocks_fail_closed() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"

  if SHIPMASTR_TEST_COMMAND_LOG="$STAGING_FIXTURE_LOG" \
    SHIPMASTR_TEST_STATE_DIR="$STAGING_FIXTURE_STATE_DIR" \
    "$STAGING_FIXTURE_MOCK_BIN/gcloud" unexpected command; then
    rm -rf "$temp_dir"
    return 1
  fi

  if SHIPMASTR_TEST_COMMAND_LOG="$STAGING_FIXTURE_LOG" \
    SHIPMASTR_TEST_MODE=success \
    SHIPMASTR_TEST_SERVICE_URL="$STAGING_FIXTURE_SERVICE_URL" \
    "$STAGING_FIXTURE_MOCK_BIN/curl" -fsS https://unexpected.example.invalid; then
    rm -rf "$temp_dir"
    return 1
  fi

  if SHIPMASTR_TEST_COMMAND_LOG="$STAGING_FIXTURE_LOG" \
    "$STAGING_FIXTURE_MOCK_BIN/date" +%s; then
    rm -rf "$temp_dir"
    return 1
  fi

  rm -rf "$temp_dir"
}

cloud_run_tag_rejected_without_external() {
  local service_name="$1"
  local traffic_tag="$2"
  local external_count=0

  gcloud() {
    external_count=$((external_count + 1))
    return 97
  }
  curl() {
    external_count=$((external_count + 1))
    return 97
  }
  date() {
    external_count=$((external_count + 1))
    return 97
  }

  if shipmastr_governance_validate_cloud_run_traffic_tag \
    "$service_name" \
    "$traffic_tag" >/dev/null 2>&1; then
    return 1
  fi

  [[ "$external_count" -eq 0 ]]
}

staging_generated_names_rejected_without_external() {
  local service_name="$1"
  local commit_prefix="$2"
  local invocation_utc="$3"
  local pid_fragment="$4"
  local revision_suffix="$5"
  local candidate_tag="$6"
  local external_count=0

  gcloud() {
    external_count=$((external_count + 1))
    return 97
  }
  curl() {
    external_count=$((external_count + 1))
    return 97
  }
  date() {
    external_count=$((external_count + 1))
    return 97
  }

  if shipmastr_governance_validate_staging_generated_names \
    "$service_name" \
    "$commit_prefix" \
    "$invocation_utc" \
    "$pid_fragment" \
    "$revision_suffix" \
    "$candidate_tag" >/dev/null 2>&1; then
    return 1
  fi

  [[ "$external_count" -eq 0 ]]
}

staging_generated_candidate_tag_differs_from_revision_suffix() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  execute_staging_wrapper_fixture
  load_staging_fixture_identity

  [[ "$STAGING_FIXTURE_TAG" != "$STAGING_FIXTURE_REVISION_SUFFIX" ]] || result=1

  rm -rf "$temp_dir"
  return "$result"
}

staging_generated_candidate_tag_is_bounded() {
  local temp_dir
  local result=0
  local service_name="shipmastr-api-staging"

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  execute_staging_wrapper_fixture
  load_staging_fixture_identity

  [[ "$STAGING_FIXTURE_TAG" =~ ^c-[0-9a-f]{7}-[0-9]{8}-[0-9]{5}$ ]] || result=1
  [[ "$STAGING_FIXTURE_REVISION_SUFFIX" =~ ^sf-[0-9a-f]{7}-[0-9]{14}-[0-9]{5}$ ]] || result=1
  [[ "${#service_name}" -eq 21 ]] || result=1
  [[ "${#STAGING_FIXTURE_TAG}" -eq 24 ]] || result=1
  [[ $(( ${#STAGING_FIXTURE_TAG} + ${#service_name} )) -eq 45 ]] || result=1
  [[ "${#STAGING_FIXTURE_REVISION_SUFFIX}" -eq 31 ]] || result=1
  [[ "${#STAGING_FIXTURE_REVISION}" -eq 53 ]] || result=1

  rm -rf "$temp_dir"
  return "$result"
}

cloud_run_tag_combined_length_46_passes() {
  shipmastr_governance_validate_cloud_run_traffic_tag \
    shipmastr-api-staging \
    c-366e154-01191621-456980
}

cloud_run_tag_combined_length_47_rejected() {
  cloud_run_tag_rejected_without_external \
    shipmastr-api-staging \
    c-366e154-01191621-4569800
}

cloud_run_tag_uppercase_rejected() {
  cloud_run_tag_rejected_without_external \
    shipmastr-api-staging \
    C-366e154-01191621-45698
}

cloud_run_tag_leading_hyphen_rejected() {
  cloud_run_tag_rejected_without_external \
    shipmastr-api-staging \
    -c-366e154-01191621-4569
}

cloud_run_tag_trailing_hyphen_rejected() {
  cloud_run_tag_rejected_without_external \
    shipmastr-api-staging \
    c-366e154-01191621-4569-
}

cloud_run_tag_punctuation_rejected() {
  cloud_run_tag_rejected_without_external \
    shipmastr-api-staging \
    'c-366e154_01191621-45698'
}

cloud_run_tag_empty_service_rejected() {
  cloud_run_tag_rejected_without_external \
    '' \
    c-366e154-01191621-45698
}

cloud_run_tag_empty_tag_rejected() {
  cloud_run_tag_rejected_without_external \
    shipmastr-api-staging \
    ''
}

staging_pid_fragment_short_pid_is_padded() {
  [[ "$(shipmastr_governance_format_pid_fragment 7)" == "00007" ]]
}

staging_pid_fragment_exact_five_digits_is_unchanged() {
  [[ "$(shipmastr_governance_format_pid_fragment 12345)" == "12345" ]]
}

staging_pid_fragment_long_pid_uses_last_five_digits() {
  [[ "$(shipmastr_governance_format_pid_fragment 123456)" == "23456" ]]
}

staging_pid_fragment_leading_zero_is_decimal_safe() {
  [[ "$(shipmastr_governance_format_pid_fragment 00008)" == "00008" ]]
}

staging_pid_fragment_nonnumeric_rejected() {
  local external_count=0

  gcloud() {
    external_count=$((external_count + 1))
    return 97
  }
  curl() {
    external_count=$((external_count + 1))
    return 97
  }
  date() {
    external_count=$((external_count + 1))
    return 97
  }

  if shipmastr_governance_format_pid_fragment '12x45' \
    >/dev/null 2>&1; then
    return 1
  fi

  [[ "$external_count" -eq 0 ]]
}

staging_generated_pid_fragment_malformed_rejected() {
  staging_generated_names_rejected_without_external \
    shipmastr-api-staging \
    "$TEST_COMMIT_PREFIX" \
    "$TEST_INVOCATION_UTC" \
    '12x45' \
    "$TEST_REVISION_SUFFIX" \
    "$TEST_CANDIDATE_TAG"
}

staging_generated_revision_suffix_mismatch_rejected() {
  staging_generated_names_rejected_without_external \
    shipmastr-api-staging \
    "$TEST_COMMIT_PREFIX" \
    "$TEST_INVOCATION_UTC" \
    "$TEST_PID_FRAGMENT" \
    "sf-${TEST_COMMIT_PREFIX}-${TEST_INVOCATION_UTC}-54321" \
    "$TEST_CANDIDATE_TAG"
}

staging_timestamp_validation_failure_is_local() {
  local mode="$1"
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_DATE_MODE="$mode"

  if execute_staging_wrapper_fixture; then
    result=1
  fi
  grep -Fq \
    'SHIPMASTR_DEPLOYMENT_BLOCKED=STAGING_INVOCATION_TIMESTAMP_INVALID' \
    "$STAGING_FIXTURE_OUTPUT" || result=1
  if grep -Eq '^(gcloud|curl) ' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]] || result=1

  rm -rf "$temp_dir"
  return "$result"
}

staging_timestamp_command_failure_rejected_locally() {
  staging_timestamp_validation_failure_is_local failure
}

staging_timestamp_empty_rejected_locally() {
  staging_timestamp_validation_failure_is_local empty
}

staging_timestamp_short_rejected_locally() {
  staging_timestamp_validation_failure_is_local short
}

staging_timestamp_long_rejected_locally() {
  staging_timestamp_validation_failure_is_local long
}

staging_timestamp_nonnumeric_rejected_locally() {
  staging_timestamp_validation_failure_is_local nonnumeric
}

staging_service_validation_failure_is_local() {
  local service_name="$1"
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_SERVICE_OVERRIDE="$service_name"
  STAGING_FIXTURE_SERVICE_OVERRIDE_SET=1

  if execute_staging_wrapper_fixture; then
    result=1
  fi
  grep -Fq \
    'SHIPMASTR_DEPLOYMENT_BLOCKED=STAGING_SERVICE_INVALID' \
    "$STAGING_FIXTURE_OUTPUT" || result=1
  if grep -Eq '^(gcloud|curl) ' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]] || result=1

  rm -rf "$temp_dir"
  return "$result"
}

staging_service_uppercase_rejected_locally() {
  staging_service_validation_failure_is_local Shipmastr-api-staging
}

staging_service_leading_hyphen_rejected_locally() {
  staging_service_validation_failure_is_local -shipmastr-api-staging
}

staging_service_trailing_hyphen_rejected_locally() {
  staging_service_validation_failure_is_local shipmastr-api-staging-
}

staging_service_punctuation_rejected_locally() {
  staging_service_validation_failure_is_local shipmastr_api_staging
}

staging_service_whitespace_rejected_locally() {
  staging_service_validation_failure_is_local 'shipmastr api staging'
}

staging_service_leading_digit_rejected_locally() {
  staging_service_validation_failure_is_local 1shipmastr-api-staging
}

staging_service_empty_rejected_locally() {
  staging_service_validation_failure_is_local ''
}

staging_service_wrong_target_rejected_locally() {
  staging_service_validation_failure_is_local shipmastr-api-stage
}

staging_service_overlength_rejected_locally() {
  local service_name="shipmastr-api-staging-long"
  local candidate_tag="$TEST_CANDIDATE_TAG"

  [[ "$service_name" =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]]
  [[ "${#service_name}" -eq 26 ]]
  [[ "${#candidate_tag}" -eq 24 ]]
  [[ $(( ${#service_name} + ${#candidate_tag} )) -eq 50 ]]
  cloud_run_tag_rejected_without_external "$service_name" "$candidate_tag"
  staging_service_validation_failure_is_local "$service_name"
}

staging_mutated_name_validation_failure_is_local() {
  local expected_source="$1"
  local replacement_source="$2"
  local expected_block="$3"
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  node - \
    "$STAGING_FIXTURE_REPO/scripts/deploy-staging.sh" \
    "$expected_source" \
    "$replacement_source" <<'NODE'
const fs = require("node:fs");
const [path, expected, replacement] = process.argv.slice(2);
const source = fs.readFileSync(path, "utf8");

if (!source.includes(expected)) {
  process.exit(2);
}

fs.writeFileSync(path, source.replace(expected, replacement));
NODE

  if execute_staging_wrapper_fixture; then
    result=1
  fi
  grep -Fq "SHIPMASTR_DEPLOYMENT_BLOCKED=${expected_block}" \
    "$STAGING_FIXTURE_OUTPUT" || result=1
  if grep -Eq '^(gcloud|curl) ' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]] || result=1

  rm -rf "$temp_dir"
  return "$result"
}

staging_invalid_pid_fragment_exits_before_external_commands() {
  staging_mutated_name_validation_failure_is_local \
    'readonly INVOCATION_PID_FRAGMENT' \
    $'INVOCATION_PID_FRAGMENT="12x45"\nreadonly INVOCATION_PID_FRAGMENT' \
    STAGING_PID_FRAGMENT_INVALID
}

staging_empty_pid_source_exits_before_external_commands() {
  staging_mutated_name_validation_failure_is_local \
    'shipmastr_governance_format_pid_fragment "$$"' \
    'shipmastr_governance_format_pid_fragment ""' \
    STAGING_PID_FRAGMENT_INVALID
}

staging_invalid_revision_suffix_exits_before_external_commands() {
  staging_mutated_name_validation_failure_is_local \
    'readonly REVISION_SUFFIX="sf-${APPROVED_COMMIT_PREFIX}-${INVOCATION_UTC}-${INVOCATION_PID_FRAGMENT}"' \
    'readonly REVISION_SUFFIX="sf-invalid"' \
    STAGING_REVISION_SUFFIX_INVALID
}

prepare_staging_invalid_tag_wrapper_fixture() {
  local temp_dir="$1"

  prepare_staging_wrapper_fixture "$temp_dir"
  node - "$STAGING_FIXTURE_REPO/scripts/deploy-staging.sh" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const source = fs.readFileSync(path, "utf8");
const expected = 'readonly CANDIDATE_TAG="c-${APPROVED_COMMIT_PREFIX}-${INVOCATION_UTC:6:8}-${INVOCATION_PID_FRAGMENT}"';
const replacement = 'readonly CANDIDATE_TAG="invalid-tag-"';

if (!source.includes(expected)) {
  process.exit(2);
}

fs.writeFileSync(path, source.replace(expected, replacement));
NODE

  if execute_staging_wrapper_fixture; then
    return 1
  fi

  grep -Fq \
    'SHIPMASTR_DEPLOYMENT_BLOCKED=STAGING_CANDIDATE_TAG_INVALID' \
    "$STAGING_FIXTURE_OUTPUT"
}

staging_invalid_tag_exits_before_gcloud() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_invalid_tag_wrapper_fixture "$temp_dir" || result=1
  if grep -Eq '^(gcloud|curl) ' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi

  rm -rf "$temp_dir"
  return "$result"
}

staging_invalid_tag_produces_no_build() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_invalid_tag_wrapper_fixture "$temp_dir" || result=1
  if grep -Fq 'gcloud builds submit' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi

  rm -rf "$temp_dir"
  return "$result"
}

staging_invalid_tag_produces_no_migration_status_job() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_invalid_tag_wrapper_fixture "$temp_dir" || result=1
  if grep -Fq 'gcloud run jobs' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi

  rm -rf "$temp_dir"
  return "$result"
}

staging_invalid_tag_produces_no_service_deployment() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_invalid_tag_wrapper_fixture "$temp_dir" || result=1
  if grep -Fq 'gcloud run deploy' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi

  rm -rf "$temp_dir"
  return "$result"
}

staging_invalid_tag_produces_no_traffic_command() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_invalid_tag_wrapper_fixture "$temp_dir" || result=1
  if grep -Fq 'gcloud run services update-traffic' "$STAGING_FIXTURE_LOG"; then
    result=1
  fi

  rm -rf "$temp_dir"
  return "$result"
}

staging_invalid_tag_produces_no_evidence() {
  local temp_dir
  local result=0

  temp_dir="$(mktemp -d)"
  prepare_staging_invalid_tag_wrapper_fixture "$temp_dir" || result=1
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]] || result=1

  rm -rf "$temp_dir"
  return "$result"
}

staging_candidate_sequence_positive() {
  local temp_dir
  local evidence_sha
  local candidate_v1_line
  local candidate_api_line
  local traffic_line
  local active_v1_line

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  execute_staging_wrapper_fixture
  load_staging_fixture_identity

  if grep -Fq 'builds submit' "$STAGING_FIXTURE_LOG"; then
    rm -rf "$temp_dir"
    return 1
  fi

  if grep -Fq 'artifacts docker images describe' "$STAGING_FIXTURE_LOG"; then
    rm -rf "$temp_dir"
    return 1
  fi

  grep -Fq \
    "gcloud run deploy shipmastr-api-staging --project shipmastr-core-prod --region asia-south1 --image $TEST_DIGEST" \
    "$STAGING_FIXTURE_LOG"
  grep -Fq -- \
    "--revision-suffix $STAGING_FIXTURE_REVISION_SUFFIX --no-traffic --tag $STAGING_FIXTURE_TAG" \
    "$STAGING_FIXTURE_LOG"
  grep -Fq -- '--format=json' "$STAGING_FIXTURE_LOG"
  grep -Fq \
    'PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY:latest' \
    "$STAGING_FIXTURE_LOG"

  if grep -Fq 'shipmastr-prisma-migrate-status-prod' "$STAGING_FIXTURE_LOG"; then
    rm -rf "$temp_dir"
    return 1
  fi

  grep -Fq 'shipmastr-prisma-migrate-status-staging' "$STAGING_FIXTURE_LOG"

  if grep -F 'gcloud run jobs deploy' "$STAGING_FIXTURE_LOG" |
    grep -Fq 'PLATFORM_CREDENTIAL_ENCRYPTION_KEY'; then
    rm -rf "$temp_dir"
    return 1
  fi

  if grep -Fq 'PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD' "$STAGING_FIXTURE_LOG"; then
    rm -rf "$temp_dir"
    return 1
  fi

  candidate_v1_line="$(grep -nF \
    "curl -fsS $STAGING_FIXTURE_CANDIDATE_URL/v1/health" \
    "$STAGING_FIXTURE_LOG" | cut -d: -f1)"
  candidate_api_line="$(grep -nF \
    "curl -fsS $STAGING_FIXTURE_CANDIDATE_URL/api/health" \
    "$STAGING_FIXTURE_LOG" | cut -d: -f1)"
  traffic_line="$(grep -nF \
    "gcloud run services update-traffic shipmastr-api-staging --project shipmastr-core-prod --region asia-south1 --to-revisions $STAGING_FIXTURE_REVISION=100 --quiet" \
    "$STAGING_FIXTURE_LOG" | cut -d: -f1)"
  active_v1_line="$(grep -nF \
    "curl -fsS $STAGING_FIXTURE_SERVICE_URL/v1/health" \
    "$STAGING_FIXTURE_LOG" | cut -d: -f1)"

  [[ "$candidate_v1_line" -lt "$candidate_api_line" ]]
  [[ "$candidate_api_line" -lt "$traffic_line" ]]
  [[ "$traffic_line" -lt "$active_v1_line" ]]

  [[ -f "$STAGING_FIXTURE_EVIDENCE" && ! -L "$STAGING_FIXTURE_EVIDENCE" ]]
  grep -Fxq 'evidence_type=SHIPMASTR_STAGING_DEPLOYMENT_EVIDENCE_V2' \
    "$STAGING_FIXTURE_EVIDENCE"
  grep -Fxq "revision=$STAGING_FIXTURE_REVISION" "$STAGING_FIXTURE_EVIDENCE"
  grep -Fxq 'active_traffic_percent=100' "$STAGING_FIXTURE_EVIDENCE"

  evidence_sha="$(
    shipmastr_governance_sha256_file "$STAGING_FIXTURE_EVIDENCE"
  )"

  shipmastr_governance_verify_staging_evidence \
    "$STAGING_FIXTURE_EVIDENCE" \
    "$evidence_sha" \
    "$STAGING_FIXTURE_HEAD" \
    "$TEST_DIGEST"

  rm -rf "$temp_dir"
}

staging_candidate_health_failure_is_fail_closed() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_MODE="candidate-api-failure"

  if execute_staging_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi
  load_staging_fixture_identity

  grep -Fq \
    "curl -fsS $STAGING_FIXTURE_CANDIDATE_URL/v1/health" \
    "$STAGING_FIXTURE_LOG"
  grep -Fq \
    "curl -fsS $STAGING_FIXTURE_CANDIDATE_URL/api/health" \
    "$STAGING_FIXTURE_LOG"
  ! grep -Fq 'gcloud run services update-traffic' "$STAGING_FIXTURE_LOG"
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]]

  rm -rf "$temp_dir"
}

staging_candidate_digest_mismatch_is_fail_closed() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_MODE="digest-mismatch"

  if execute_staging_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi
  load_staging_fixture_identity

  ! grep -Fq "curl -fsS $STAGING_FIXTURE_CANDIDATE_URL" \
    "$STAGING_FIXTURE_LOG"
  ! grep -Fq 'gcloud run services update-traffic' "$STAGING_FIXTURE_LOG"
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]]

  rm -rf "$temp_dir"
}

staging_secret_preflight_precedes_service_deploy() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_SECRET_MODE="missing"

  if execute_staging_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  ! grep -Fq 'gcloud run jobs deploy' "$STAGING_FIXTURE_LOG"
  ! grep -Fq 'gcloud run deploy shipmastr-api-staging' "$STAGING_FIXTURE_LOG"
  ! grep -Fq 'gcloud run services update-traffic' "$STAGING_FIXTURE_LOG"
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]]

  rm -rf "$temp_dir"
}

staging_wrapper_pretraffic_failure() {
  local mode="$1"
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_MODE="$mode"

  if execute_staging_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  ! grep -Fq 'gcloud run services update-traffic' "$STAGING_FIXTURE_LOG"
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]]
  rm -rf "$temp_dir"
}

staging_deploy_result_revision_mismatch_rejected() {
  staging_wrapper_pretraffic_failure deploy-result-mismatch
}

staging_expected_revision_missing_rejected() {
  staging_wrapper_pretraffic_failure revision-missing
}

staging_candidate_not_ready_rejected() {
  staging_wrapper_pretraffic_failure revision-not-ready
}

staging_candidate_wrong_service_rejected() {
  staging_wrapper_pretraffic_failure revision-wrong-service
}

staging_candidate_tag_missing_rejected() {
  staging_wrapper_pretraffic_failure tag-missing
}

staging_candidate_tag_duplicate_rejected() {
  staging_wrapper_pretraffic_failure tag-duplicate
}

staging_candidate_tag_other_revision_rejected() {
  staging_wrapper_pretraffic_failure tag-other-revision
}

staging_candidate_tag_nonzero_rejected() {
  staging_wrapper_pretraffic_failure tag-nonzero
}

staging_latest_created_change_rejected() {
  staging_wrapper_pretraffic_failure latest-created-changed
}

staging_stale_tag_rejected() {
  staging_wrapper_pretraffic_failure stale-tag
}

staging_candidate_v1_health_failure_is_fail_closed() {
  staging_wrapper_pretraffic_failure candidate-v1-failure
}

staging_wrapper_posttraffic_failure() {
  local mode="$1"
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_staging_wrapper_fixture "$temp_dir"
  STAGING_FIXTURE_MODE="$mode"

  if execute_staging_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  grep -Fq 'gcloud run services update-traffic' "$STAGING_FIXTURE_LOG"
  [[ ! -e "$STAGING_FIXTURE_EVIDENCE" ]]
  rm -rf "$temp_dir"
}

staging_traffic_no_positive_rejected() {
  staging_wrapper_posttraffic_failure traffic-no-positive
}

staging_traffic_less_than_100_rejected() {
  staging_wrapper_posttraffic_failure traffic-less-than-100
}

staging_traffic_other_revision_rejected() {
  staging_wrapper_posttraffic_failure traffic-other-revision
}

staging_active_ready_mismatch_rejected() {
  staging_wrapper_posttraffic_failure active-ready-mismatch
}

staging_active_digest_mismatch_rejected() {
  staging_wrapper_posttraffic_failure active-digest-mismatch
}

staging_active_v1_failure_has_no_evidence() {
  staging_wrapper_posttraffic_failure active-v1-failure
}

staging_active_api_failure_has_no_evidence() {
  staging_wrapper_posttraffic_failure active-api-failure
}

prepare_production_wrapper_fixture() {
  local temp_dir="$1"

  PRODUCTION_FIXTURE_REPO="$temp_dir/repo"
  PRODUCTION_FIXTURE_MOCK_BIN="$temp_dir/mock-bin"
  PRODUCTION_FIXTURE_LOG="$temp_dir/commands.log"
  PRODUCTION_FIXTURE_OUTPUT="$temp_dir/wrapper.out"
  PRODUCTION_FIXTURE_EVIDENCE="$temp_dir/staging-evidence.env"
  PRODUCTION_FIXTURE_SECRET_MODE="valid"
  PRODUCTION_FIXTURE_DEPLOY_DRY_RUN="0"
  PRODUCTION_FIXTURE_MIGRATION_STATUS_ONLY="0"

  mkdir -p "$PRODUCTION_FIXTURE_REPO/scripts" "$PRODUCTION_FIXTURE_MOCK_BIN"
  cp "$SCRIPT_DIR/deploy-prod.sh" "$PRODUCTION_FIXTURE_REPO/scripts/"
  cp "$SCRIPT_DIR/deployment-governance.sh" "$PRODUCTION_FIXTURE_REPO/scripts/"

  git -C "$PRODUCTION_FIXTURE_REPO" init -q
  git -C "$PRODUCTION_FIXTURE_REPO" config user.name 'Shipmastr Governance Test'
  git -C "$PRODUCTION_FIXTURE_REPO" config user.email 'governance-test@shipmastr.invalid'
  git -C "$PRODUCTION_FIXTURE_REPO" remote add origin \
    'https://github.com/veer-gt/shipmastr-backend.git'
  git -C "$PRODUCTION_FIXTURE_REPO" add scripts
  git -C "$PRODUCTION_FIXTURE_REPO" \
    -c commit.gpgsign=false \
    commit -qm 'test: production wrapper fixture'

  PRODUCTION_FIXTURE_HEAD="$(git -C "$PRODUCTION_FIXTURE_REPO" rev-parse HEAD)"
  PRODUCTION_FIXTURE_EVIDENCE_SHA="$(
    shipmastr_governance_write_staging_evidence \
      "$PRODUCTION_FIXTURE_EVIDENCE" \
      "$PRODUCTION_FIXTURE_HEAD" \
      "$TEST_DIGEST" \
      "$TEST_REVISION"
  )"

  cat > "$PRODUCTION_FIXTURE_MOCK_BIN/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

if [[ " $* " == *" ls-remote --exit-code origin refs/heads/main "* ]]; then
  printf '%s\t%s\n' \
    "${SHIPMASTR_TEST_REMOTE_MAIN_SHA:?}" \
    'refs/heads/main'
  exit 0
fi

exec /usr/bin/git "$@"
MOCK

  cat > "$PRODUCTION_FIXTURE_MOCK_BIN/gcloud" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf 'gcloud %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"

if [[ "${1:-}" == "auth" && "${2:-}" == "list" ]]; then
  printf '%s\n' 'shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com'
  exit 0
fi

if [[ "${1:-}" == "config" && "${2:-}" == "get-value" ]]; then
  printf '%s\n' '(unset)'
  exit 0
fi

if [[ "${1:-}" == "secrets" && "${2:-}" == "describe" ]]; then
  [[ "${3:-}" == "PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD" ]] || exit 91
  case "${SHIPMASTR_TEST_SECRET_MODE:-valid}" in
    valid|no-enabled)
      printf 'production\tplatform-credential-encryption\n'
      ;;
    missing)
      exit 1
      ;;
    staging-label)
      printf 'staging\tplatform-credential-encryption\n'
      ;;
    wrong-purpose)
      printf 'production\tnot-platform-credential-encryption\n'
      ;;
    *)
      exit 92
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == "secrets" && "${2:-}" == "versions" && \
  "${3:-}" == "list" ]]; then
  [[ "${4:-}" == "PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD" ]] || exit 93
  if [[ "${SHIPMASTR_TEST_SECRET_MODE:-valid}" != "no-enabled" ]]; then
    printf '%s\n' '1'
  fi
  exit 0
fi

if [[ "${1:-}" == "secrets" && "${2:-}" == "versions" && \
  "${3:-}" == "access" ]]; then
  [[ " $* " == *" --secret DATABASE_URL "* ]] || exit 94
  printf '%s\n' 'postgresql://user:pass@localhost:5432/shipmastr_prod'
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "jobs" && \
  ( "${3:-}" == "deploy" || "${3:-}" == "execute" ) ]]; then
  exit 0
fi

echo "UNEXPECTED_GCLOUD_COMMAND=$*" >&2
exit 97
MOCK

  cat > "$PRODUCTION_FIXTURE_MOCK_BIN/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"
exit 97
MOCK

  chmod 700 \
    "$PRODUCTION_FIXTURE_MOCK_BIN/git" \
    "$PRODUCTION_FIXTURE_MOCK_BIN/gcloud" \
    "$PRODUCTION_FIXTURE_MOCK_BIN/curl"
}

execute_production_wrapper_fixture() {
  (
    unset GOOGLE_APPLICATION_CREDENTIALS
    unset PROJECT PROJECT_ID REGION
    unset SERVICE SERVICE_NAME CLOUD_RUN_SERVICE
    unset SERVICE_ACCOUNT CLOUD_SQL_INSTANCE
    unset SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL
    unset SHIPMASTR_GOVERNANCE_TEST_MODE
    unset SHIPMASTR_TEST_REPO_CLEAN
    unset SHIPMASTR_TEST_HEAD_SHA
    unset SHIPMASTR_TEST_ORIGIN_MAIN_SHA
    unset SHIPMASTR_TEST_EFFECTIVE_IDENTITY

    PATH="$PRODUCTION_FIXTURE_MOCK_BIN:$PATH" \
    SHIPMASTR_TEST_COMMAND_LOG="$PRODUCTION_FIXTURE_LOG" \
    SHIPMASTR_TEST_REMOTE_MAIN_SHA="$PRODUCTION_FIXTURE_HEAD" \
    SHIPMASTR_TEST_SECRET_MODE="$PRODUCTION_FIXTURE_SECRET_MODE" \
    SHIPMASTR_APPROVED_COMMIT_SHA="$PRODUCTION_FIXTURE_HEAD" \
    SHIPMASTR_PUBLIC_ACCESS_EXPECTATION=public \
    SHIPMASTR_PUBLIC_ACCESS_APPROVAL='APPROVE RETAIN CURRENT PUBLIC INVOCATION STATE' \
    SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL='APPROVE SHIPMASTR PRODUCTION PROMOTION' \
    SHIPMASTR_STAGING_IMAGE_DIGEST="$TEST_DIGEST" \
    SHIPMASTR_STAGING_EVIDENCE_FILE="$PRODUCTION_FIXTURE_EVIDENCE" \
    SHIPMASTR_STAGING_EVIDENCE_SHA256="$PRODUCTION_FIXTURE_EVIDENCE_SHA" \
    CONFIRM_PROD_DEPLOY=shipmastr-prod \
    IMAGE_DIGEST="$TEST_DIGEST" \
    STOREFRONT_ASSETS_GCS_BUCKET=shipmastr-core-prod-storefront-assets \
    DEPLOY_DRY_RUN="$PRODUCTION_FIXTURE_DEPLOY_DRY_RUN" \
    PROD_MIGRATION_STATUS_DRY_RUN_ONLY="$PRODUCTION_FIXTURE_MIGRATION_STATUS_ONLY" \
    APPROVE_PRODUCTION_MIGRATION_STATUS_DRY_RUN='APPROVE PRODUCTION MIGRATION STATUS DRY RUN' \
    /bin/bash "$PRODUCTION_FIXTURE_REPO/scripts/deploy-prod.sh"
  ) >"$PRODUCTION_FIXTURE_OUTPUT" 2>&1
}

production_missing_secret_blocks_migration_job() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_production_wrapper_fixture "$temp_dir"
  PRODUCTION_FIXTURE_SECRET_MODE="missing"
  PRODUCTION_FIXTURE_MIGRATION_STATUS_ONLY="1"

  if execute_production_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  grep -Fq 'gcloud secrets describe PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD' \
    "$PRODUCTION_FIXTURE_LOG"
  ! grep -Fq 'gcloud run jobs deploy' "$PRODUCTION_FIXTURE_LOG"
  ! grep -Fq 'gcloud run jobs execute' "$PRODUCTION_FIXTURE_LOG"
  rm -rf "$temp_dir"
}

production_wrong_labels_block_migration_job() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_production_wrapper_fixture "$temp_dir"
  PRODUCTION_FIXTURE_SECRET_MODE="staging-label"
  PRODUCTION_FIXTURE_MIGRATION_STATUS_ONLY="1"

  if execute_production_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  ! grep -Fq 'gcloud run jobs deploy' "$PRODUCTION_FIXTURE_LOG"
  ! grep -Fq 'gcloud run jobs execute' "$PRODUCTION_FIXTURE_LOG"
  rm -rf "$temp_dir"
}

production_valid_preflight_precedes_job_mutation() {
  local temp_dir
  local versions_line
  local database_access_line

  temp_dir="$(mktemp -d)"
  prepare_production_wrapper_fixture "$temp_dir"
  PRODUCTION_FIXTURE_MIGRATION_STATUS_ONLY="1"
  if execute_production_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  versions_line="$(grep -nF \
    'gcloud secrets versions list PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD' \
    "$PRODUCTION_FIXTURE_LOG" | cut -d: -f1)"
  database_access_line="$(grep -nF \
    'gcloud secrets versions access latest --secret DATABASE_URL' \
    "$PRODUCTION_FIXTURE_LOG" | cut -d: -f1)"
  [[ "$versions_line" -lt "$database_access_line" ]]
  ! grep -Fq 'gcloud run jobs deploy' "$PRODUCTION_FIXTURE_LOG"

  node - "$SCRIPT_DIR/deploy-prod.sh" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const preflight = source.indexOf("shipmastr_governance_verify_secret_metadata \\");
const migrationBranch = source.indexOf(
  'if [[ "${PROD_MIGRATION_STATUS_DRY_RUN_ONLY:-}" == "1" ]]',
);
const migrationCall = source.indexOf(
  "run_production_migration_status_gate",
  migrationBranch,
);
if (
  preflight < 0 ||
  migrationBranch < 0 ||
  migrationCall < 0 ||
  !(preflight < migrationBranch && migrationBranch < migrationCall)
) {
  process.exit(2);
}
NODE
  rm -rf "$temp_dir"
}

production_dry_run_renders_without_secret_preflight() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_production_wrapper_fixture "$temp_dir"
  PRODUCTION_FIXTURE_SECRET_MODE="missing"
  PRODUCTION_FIXTURE_DEPLOY_DRY_RUN="1"
  PRODUCTION_FIXTURE_MIGRATION_STATUS_ONLY="1"
  execute_production_wrapper_fixture

  grep -Fq 'DEPLOY_DRY_RUN=1' "$PRODUCTION_FIXTURE_OUTPUT"
  grep -Fq \
    'PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD:latest' \
    "$PRODUCTION_FIXTURE_OUTPUT"
  ! grep -Fq 'gcloud secrets describe' "$PRODUCTION_FIXTURE_LOG"
  ! grep -Fq 'gcloud run jobs' "$PRODUCTION_FIXTURE_LOG"
  ! grep -Fq 'gcloud run deploy' "$PRODUCTION_FIXTURE_LOG"
  rm -rf "$temp_dir"
}

production_normal_path_blocked_without_secret() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  prepare_production_wrapper_fixture "$temp_dir"
  PRODUCTION_FIXTURE_SECRET_MODE="missing"

  if execute_production_wrapper_fixture; then
    rm -rf "$temp_dir"
    return 1
  fi

  ! grep -Fq 'gcloud run jobs' "$PRODUCTION_FIXTURE_LOG"
  ! grep -Fq 'gcloud run deploy' "$PRODUCTION_FIXTURE_LOG"
  rm -rf "$temp_dir"
}

caller_test_variables_cannot_bypass() {
  local script_path="$1"
  local temp_dir
  local fixture_repo
  local fixture_script
  local mock_bin
  local command_log
  local output_file
  local expected_block

  temp_dir="$(mktemp -d)"
  fixture_repo="$temp_dir/repo"
  fixture_script="$fixture_repo/scripts/$(basename "$script_path")"
  mock_bin="$temp_dir/mock-bin"
  command_log="$temp_dir/commands.log"
  output_file="$temp_dir/output.log"
  expected_block='SHIPMASTR_DEPLOYMENT_BLOCKED=APPROVED_COMMIT_SHA_REQUIRED'
  if [[ "$(basename "$script_path")" == "deploy-staging.sh" ]]; then
    expected_block='SHIPMASTR_DEPLOYMENT_BLOCKED=STAGING_COMMIT_PREFIX_INVALID'
  fi

  mkdir -p "$fixture_repo/scripts" "$mock_bin"
  cp "$script_path" "$fixture_script"
  cp "$SCRIPT_DIR/deployment-governance.sh" "$fixture_repo/scripts/"
  git -C "$fixture_repo" init -q
  git -C "$fixture_repo" config user.name 'Shipmastr Governance Test'
  git -C "$fixture_repo" config user.email 'governance-test@shipmastr.invalid'
  git -C "$fixture_repo" add scripts
  git -C "$fixture_repo" \
    -c commit.gpgsign=false \
    commit -qm 'test: bypass fixture'

  cat > "$mock_bin/gcloud" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'gcloud %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"
exit 97
MOCK

  cat > "$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "${SHIPMASTR_TEST_COMMAND_LOG:?}"
exit 97
MOCK

  chmod 700 "$mock_bin/gcloud" "$mock_bin/curl"

  if (
    unset SHIPMASTR_APPROVED_COMMIT_SHA
    unset GOOGLE_APPLICATION_CREDENTIALS
    unset PROJECT PROJECT_ID REGION
    unset SERVICE SERVICE_NAME CLOUD_RUN_SERVICE
    unset SERVICE_ACCOUNT CLOUD_SQL_INSTANCE

    PATH="$mock_bin:$PATH" \
    SHIPMASTR_TEST_COMMAND_LOG="$command_log" \
    SHIPMASTR_GOVERNANCE_TEST_MODE=1 \
    SHIPMASTR_TEST_REPO_CLEAN=1 \
    SHIPMASTR_TEST_HEAD_SHA="$TEST_SHA" \
    SHIPMASTR_TEST_ORIGIN_MAIN_SHA="$TEST_SHA" \
    SHIPMASTR_TEST_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com' \
    /bin/bash "$fixture_script"
  ) >"$output_file" 2>&1; then
    rm -rf "$temp_dir"
    return 1
  fi

  if [[ -s "$command_log" ]]; then
    rm -rf "$temp_dir"
    return 1
  fi

  if ! grep -Fq \
    "$expected_block" \
    "$output_file"; then
    rm -rf "$temp_dir"
    return 1
  fi

  rm -rf "$temp_dir"
}

implementation_files_removed() {
  [[ ! -e "$SCRIPT_DIR/deploy-prod.implementation.sh" ]]
  [[ ! -e "$SCRIPT_DIR/deploy-staging.implementation.sh" ]]
}

production_governance_has_no_test_hooks() {
  ! grep -R --line-number -E \
    'SHIPMASTR_GOVERNANCE_TEST_MODE|SHIPMASTR_TEST_' \
    "$SCRIPT_DIR/deployment-governance.sh" \
    "$SCRIPT_DIR/deploy-prod.sh" \
    "$SCRIPT_DIR/deploy-staging.sh"
}

implicit_public_access_flag_absent() {
  ! grep -R --line-number --fixed-strings \
    -- '--allow-unauthenticated' \
    "$SCRIPT_DIR/deploy-prod.sh" \
    "$SCRIPT_DIR/deploy-staging.sh"
}

application_secret_bindings_are_environment_specific() {
  grep -Fq \
    'readonly PLATFORM_CREDENTIAL_ENCRYPTION_SECRET="PLATFORM_CREDENTIAL_ENCRYPTION_KEY"' \
    "$SCRIPT_DIR/deploy-staging.sh"
  grep -Fq \
    'PLATFORM_CREDENTIAL_ENCRYPTION_KEY=${PLATFORM_CREDENTIAL_ENCRYPTION_SECRET}:latest' \
    "$SCRIPT_DIR/deploy-staging.sh"

  grep -Fq \
    'readonly PROD_PLATFORM_CREDENTIAL_ENCRYPTION_SECRET="PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD"' \
    "$SCRIPT_DIR/deploy-prod.sh"
  grep -Fq \
    'PLATFORM_CREDENTIAL_ENCRYPTION_KEY=${PROD_PLATFORM_CREDENTIAL_ENCRYPTION_SECRET}:latest' \
    "$SCRIPT_DIR/deploy-prod.sh"
}

migration_jobs_exclude_platform_credential_keys() {
  node - \
    "$SCRIPT_DIR/deploy-staging.sh" \
    "$SCRIPT_DIR/deploy-prod.sh" <<'NODE'
const fs = require("node:fs");

for (const path of process.argv.slice(2)) {
  const source = fs.readFileSync(path, "utf8");
  const jobBlocks = source.match(/gcloud run jobs deploy[\s\S]*?--quiet/g) || [];

  if (jobBlocks.length !== 1) {
    process.exit(2);
  }

  if (jobBlocks[0].includes("PLATFORM_CREDENTIAL_ENCRYPTION_KEY")) {
    process.exit(3);
  }
}
NODE
}

platform_secret_resources_do_not_cross_environments() {
  ! grep -Fq \
    'PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD' \
    "$SCRIPT_DIR/deploy-staging.sh"

  ! grep -Fq \
    'readonly PLATFORM_CREDENTIAL_ENCRYPTION_SECRET="PLATFORM_CREDENTIAL_ENCRYPTION_KEY"' \
    "$SCRIPT_DIR/deploy-prod.sh"

  ! grep -Fq \
    'PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY:latest' \
    "$SCRIPT_DIR/deploy-prod.sh"
}


sensitive_deploy_targets_are_frozen() {
  grep -Fq \
    'readonly STAGING_SERVICE="shipmastr-api-staging"' \
    "$SCRIPT_DIR/deploy-prod.sh"

  grep -Fq \
    'readonly MIGRATION_STATUS_JOB="shipmastr-prisma-migrate-status-prod"' \
    "$SCRIPT_DIR/deploy-prod.sh"

  grep -Fq \
    'readonly MIGRATION_STATUS_JOB="shipmastr-prisma-migrate-status-staging"' \
    "$SCRIPT_DIR/deploy-staging.sh"

  grep -Fq \
    'readonly PROD_DATABASE_NAME_ALLOWLIST="shipmastr,shipmastr_prod,shipmastr_production"' \
    "$SCRIPT_DIR/deploy-prod.sh"

  grep -Fq \
    'readonly PROD_STOREFRONT_ASSETS_BUCKET_ALLOWLIST="shipmastr-core-prod-storefront-assets"' \
    "$SCRIPT_DIR/deploy-prod.sh"

  grep -Fq \
    'git -C "$repo_root" ls-remote' \
    "$SCRIPT_DIR/deployment-governance.sh"

  ! grep -Fq \
    'refs/remotes/origin/main' \
    "$SCRIPT_DIR/deployment-governance.sh"
}


canonical_origin_positive() {
  shipmastr_governance_validate_canonical_origin "$REPO_ROOT"
}

canonical_origin_rejects_noncanonical_url() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  git -C "$temp_dir" init -q
  git -C "$temp_dir" remote add \
    origin \
    'https://github.com/veer-gt/not-shipmastr-backend.git'

  shipmastr_governance_validate_canonical_origin "$temp_dir"
}

canonical_origin_rejects_url_rewrite() {
  local temp_dir

  temp_dir="$(mktemp -d)"
  git -C "$temp_dir" init -q
  git -C "$temp_dir" remote add \
    origin \
    'https://github.com/veer-gt/shipmastr-backend.git'
  git -C "$temp_dir" config \
    'url.https://example.invalid/'.insteadOf \
    'https://github.com/'

  shipmastr_governance_validate_canonical_origin "$temp_dir"
}

production_database_allowlist_is_strict() {
  node - "$SCRIPT_DIR/deploy-prod.sh" <<'JSTEST'
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const sourcePath = process.argv[2];
const source = fs.readFileSync(sourcePath, "utf8");
const startMarker = "node <<'NODE'\n";
const endMarker = "\nNODE\n";

const start = source.indexOf(startMarker);
if (start < 0) {
  process.exit(10);
}

const bodyStart = start + startMarker.length;
const end = source.indexOf(endMarker, bodyStart);
if (end < 0) {
  process.exit(11);
}

const validator = source.slice(bodyStart, end);
const allowlist = "shipmastr,shipmastr_prod,shipmastr_production";

function run(databaseName) {
  return spawnSync(
    process.execPath,
    ["-e", validator],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL_TO_VERIFY:
          `postgresql://user:pass@localhost:5432/${databaseName}`,
        PROD_DATABASE_NAME_ALLOWLIST: allowlist,
      },
    },
  );
}

const exactAllowed = run("shipmastr_prod");
if (exactAllowed.status !== 0) {
  process.exit(12);
}

const deceptive = run("temporary_prod_copy");
if (deceptive.status === 0) {
  process.exit(13);
}

if (!deceptive.stderr.includes("DATABASE_NAME_NOT_ALLOWLISTED")) {
  process.exit(14);
}
JSTEST
}

expect_pass staging_positive staging_positive
expect_pass staging_prebuilt_positive staging_prebuilt_positive
expect_fail staging_evidence_output_required staging_evidence_output_required
expect_fail staging_wrong_identity staging_wrong_identity
expect_fail staging_dirty staging_dirty
expect_fail staging_legacy_target staging_legacy_target
expect_pass staging_secret_metadata_positive staging_secret_metadata_positive
expect_fail staging_secret_wrong_environment_rejected \
  staging_secret_wrong_environment_rejected
expect_fail staging_secret_wrong_purpose_rejected \
  staging_secret_wrong_purpose_rejected
expect_pass production_secret_metadata_positive production_secret_metadata_positive
expect_fail production_secret_missing_rejected production_secret_missing_rejected
expect_fail production_secret_staging_label_rejected production_secret_staging_label_rejected
expect_fail secret_enabled_version_required secret_enabled_version_required
expect_fail production_secret_enabled_version_required \
  production_secret_enabled_version_required
expect_pass production_positive production_positive
expect_fail production_missing_digest production_missing_digest
expect_fail production_digest_mismatch production_digest_mismatch
expect_fail production_evidence_hash_mismatch production_evidence_hash_mismatch
expect_fail production_evidence_commit_mismatch production_evidence_commit_mismatch
expect_fail production_rejects_v1_evidence production_rejects_v1_evidence
expect_fail production_remote_main_mismatch production_remote_main_mismatch
expect_fail owner_without_break_glass owner_without_break_glass
expect_pass owner_with_break_glass owner_with_break_glass
expect_fail key_file_rejected key_file_rejected
expect_fail public_approval_required public_approval_required
expect_pass migration_status_positive migration_status_positive
expect_fail migration_wrong_identity migration_wrong_identity
expect_fail migration_build_without_approval migration_build_without_approval
expect_pass staging_generated_candidate_tag_differs_from_revision_suffix \
  staging_generated_candidate_tag_differs_from_revision_suffix
expect_pass staging_generated_candidate_tag_is_bounded \
  staging_generated_candidate_tag_is_bounded
expect_pass cloud_run_tag_combined_length_46_passes \
  cloud_run_tag_combined_length_46_passes
expect_pass cloud_run_tag_combined_length_47_rejected \
  cloud_run_tag_combined_length_47_rejected
expect_pass cloud_run_tag_uppercase_rejected \
  cloud_run_tag_uppercase_rejected
expect_pass cloud_run_tag_leading_hyphen_rejected \
  cloud_run_tag_leading_hyphen_rejected
expect_pass cloud_run_tag_trailing_hyphen_rejected \
  cloud_run_tag_trailing_hyphen_rejected
expect_pass cloud_run_tag_punctuation_rejected \
  cloud_run_tag_punctuation_rejected
expect_pass cloud_run_tag_empty_service_rejected \
  cloud_run_tag_empty_service_rejected
expect_pass cloud_run_tag_empty_tag_rejected \
  cloud_run_tag_empty_tag_rejected
expect_pass staging_pid_fragment_short_pid_is_padded \
  staging_pid_fragment_short_pid_is_padded
expect_pass staging_pid_fragment_exact_five_digits_is_unchanged \
  staging_pid_fragment_exact_five_digits_is_unchanged
expect_pass staging_pid_fragment_long_pid_uses_last_five_digits \
  staging_pid_fragment_long_pid_uses_last_five_digits
expect_pass staging_pid_fragment_leading_zero_is_decimal_safe \
  staging_pid_fragment_leading_zero_is_decimal_safe
expect_pass staging_pid_fragment_nonnumeric_rejected \
  staging_pid_fragment_nonnumeric_rejected
expect_pass staging_generated_pid_fragment_malformed_rejected \
  staging_generated_pid_fragment_malformed_rejected
expect_pass staging_generated_revision_suffix_mismatch_rejected \
  staging_generated_revision_suffix_mismatch_rejected
expect_pass staging_invalid_pid_fragment_exits_before_external_commands \
  staging_invalid_pid_fragment_exits_before_external_commands
expect_pass staging_empty_pid_source_exits_before_external_commands \
  staging_empty_pid_source_exits_before_external_commands
expect_pass staging_invalid_revision_suffix_exits_before_external_commands \
  staging_invalid_revision_suffix_exits_before_external_commands
expect_pass staging_timestamp_command_failure_rejected_locally \
  staging_timestamp_command_failure_rejected_locally
expect_pass staging_timestamp_empty_rejected_locally \
  staging_timestamp_empty_rejected_locally
expect_pass staging_timestamp_short_rejected_locally \
  staging_timestamp_short_rejected_locally
expect_pass staging_timestamp_long_rejected_locally \
  staging_timestamp_long_rejected_locally
expect_pass staging_timestamp_nonnumeric_rejected_locally \
  staging_timestamp_nonnumeric_rejected_locally
expect_pass staging_service_uppercase_rejected_locally \
  staging_service_uppercase_rejected_locally
expect_pass staging_service_leading_hyphen_rejected_locally \
  staging_service_leading_hyphen_rejected_locally
expect_pass staging_service_trailing_hyphen_rejected_locally \
  staging_service_trailing_hyphen_rejected_locally
expect_pass staging_service_punctuation_rejected_locally \
  staging_service_punctuation_rejected_locally
expect_pass staging_service_whitespace_rejected_locally \
  staging_service_whitespace_rejected_locally
expect_pass staging_service_leading_digit_rejected_locally \
  staging_service_leading_digit_rejected_locally
expect_pass staging_service_empty_rejected_locally \
  staging_service_empty_rejected_locally
expect_pass staging_service_wrong_target_rejected_locally \
  staging_service_wrong_target_rejected_locally
expect_pass staging_service_overlength_rejected_locally \
  staging_service_overlength_rejected_locally
expect_pass staging_invalid_tag_exits_before_gcloud \
  staging_invalid_tag_exits_before_gcloud
expect_pass staging_invalid_tag_produces_no_build \
  staging_invalid_tag_produces_no_build
expect_pass staging_invalid_tag_produces_no_migration_status_job \
  staging_invalid_tag_produces_no_migration_status_job
expect_pass staging_invalid_tag_produces_no_service_deployment \
  staging_invalid_tag_produces_no_service_deployment
expect_pass staging_invalid_tag_produces_no_traffic_command \
  staging_invalid_tag_produces_no_traffic_command
expect_pass staging_invalid_tag_produces_no_evidence \
  staging_invalid_tag_produces_no_evidence
expect_pass staging_candidate_sequence_positive staging_candidate_sequence_positive
expect_pass staging_external_command_mocks_fail_closed \
  staging_external_command_mocks_fail_closed
expect_pass staging_candidate_health_failure_is_fail_closed \
  staging_candidate_health_failure_is_fail_closed
expect_pass staging_candidate_digest_mismatch_is_fail_closed \
  staging_candidate_digest_mismatch_is_fail_closed
expect_pass staging_secret_preflight_precedes_service_deploy \
  staging_secret_preflight_precedes_service_deploy
expect_pass staging_deploy_result_revision_mismatch_rejected \
  staging_deploy_result_revision_mismatch_rejected
expect_pass staging_expected_revision_missing_rejected \
  staging_expected_revision_missing_rejected
expect_pass staging_candidate_not_ready_rejected \
  staging_candidate_not_ready_rejected
expect_pass staging_candidate_wrong_service_rejected \
  staging_candidate_wrong_service_rejected
expect_pass staging_candidate_tag_missing_rejected \
  staging_candidate_tag_missing_rejected
expect_pass staging_candidate_tag_duplicate_rejected \
  staging_candidate_tag_duplicate_rejected
expect_pass staging_candidate_tag_other_revision_rejected \
  staging_candidate_tag_other_revision_rejected
expect_pass staging_candidate_tag_nonzero_rejected \
  staging_candidate_tag_nonzero_rejected
expect_pass staging_latest_created_change_rejected \
  staging_latest_created_change_rejected
expect_pass staging_stale_tag_rejected staging_stale_tag_rejected
expect_pass staging_candidate_v1_health_failure_is_fail_closed \
  staging_candidate_v1_health_failure_is_fail_closed
expect_pass staging_traffic_no_positive_rejected \
  staging_traffic_no_positive_rejected
expect_pass staging_traffic_less_than_100_rejected \
  staging_traffic_less_than_100_rejected
expect_pass staging_traffic_other_revision_rejected \
  staging_traffic_other_revision_rejected
expect_pass staging_active_ready_mismatch_rejected \
  staging_active_ready_mismatch_rejected
expect_pass staging_active_digest_mismatch_rejected \
  staging_active_digest_mismatch_rejected
expect_pass staging_active_v1_failure_has_no_evidence \
  staging_active_v1_failure_has_no_evidence
expect_pass staging_active_api_failure_has_no_evidence \
  staging_active_api_failure_has_no_evidence
expect_pass production_missing_secret_blocks_migration_job \
  production_missing_secret_blocks_migration_job
expect_pass production_wrong_labels_block_migration_job \
  production_wrong_labels_block_migration_job
expect_pass production_valid_preflight_precedes_job_mutation \
  production_valid_preflight_precedes_job_mutation
expect_pass production_dry_run_renders_without_secret_preflight \
  production_dry_run_renders_without_secret_preflight
expect_pass production_normal_path_blocked_without_secret \
  production_normal_path_blocked_without_secret
expect_pass evidence_v2_valid evidence_v2_valid
expect_fail evidence_duplicate_key_rejected evidence_duplicate_key_rejected
expect_fail evidence_unknown_key_rejected evidence_unknown_key_rejected
expect_fail evidence_missing_key_rejected evidence_missing_key_rejected
expect_fail evidence_malformed_expected_commit_rejected \
  evidence_malformed_expected_commit_rejected
expect_fail evidence_malformed_expected_digest_rejected \
  evidence_malformed_expected_digest_rejected
expect_fail evidence_invalid_revision_prefix_rejected \
  evidence_invalid_revision_prefix_rejected
expect_fail evidence_trailing_hyphen_revision_rejected \
  evidence_trailing_hyphen_revision_rejected
expect_fail evidence_overlength_revision_rejected \
  evidence_overlength_revision_rejected
expect_fail evidence_impossible_utc_rejected evidence_impossible_utc_rejected
expect_fail evidence_commit_mismatch_rejected evidence_commit_mismatch_rejected
expect_fail evidence_digest_mismatch_rejected evidence_digest_mismatch_rejected
expect_fail evidence_hash_mismatch_rejected evidence_hash_mismatch_rejected
expect_fail evidence_writer_rejects_invalid_revision \
  evidence_writer_rejects_invalid_revision
expect_pass caller_test_vars_cannot_bypass_staging \
  caller_test_variables_cannot_bypass "$SCRIPT_DIR/deploy-staging.sh"
expect_pass caller_test_vars_cannot_bypass_production \
  caller_test_variables_cannot_bypass "$SCRIPT_DIR/deploy-prod.sh"
expect_pass implementation_files_removed implementation_files_removed
expect_pass production_governance_has_no_test_hooks production_governance_has_no_test_hooks
expect_pass implicit_public_access_flag_absent implicit_public_access_flag_absent
expect_pass application_secret_bindings_are_environment_specific \
  application_secret_bindings_are_environment_specific
expect_pass migration_jobs_exclude_platform_credential_keys \
  migration_jobs_exclude_platform_credential_keys
expect_pass platform_secret_resources_do_not_cross_environments \
  platform_secret_resources_do_not_cross_environments
expect_pass sensitive_deploy_targets_are_frozen sensitive_deploy_targets_are_frozen
expect_pass canonical_origin_positive canonical_origin_positive
expect_fail canonical_origin_rejects_noncanonical_url   canonical_origin_rejects_noncanonical_url
expect_fail canonical_origin_rejects_url_rewrite   canonical_origin_rejects_url_rewrite
expect_pass production_database_allowlist_is_strict   production_database_allowlist_is_strict

echo "I5B1_GOVERNANCE_TEST_COUNT=$pass_count"
echo "I5B1_GOVERNANCE_TESTS=PASS"
