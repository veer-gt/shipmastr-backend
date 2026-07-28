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

pass_count=0

expect_pass() {
  local name="$1"
  local output
  shift

  if output="$( ( "$@" ) 2>&1 )"; then
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
  shift

  if ( "$@" ) >/dev/null 2>&1; then
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
      "$TEST_DIGEST"
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
      "$TEST_DIGEST"
  )"

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
      "$TEST_DIGEST"
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

staging_prebuilt_wrapper_skips_build() {
  local temp_dir
  local gcloud_log
  local evidence_file
  local evidence_sha
  local actual_head

  temp_dir="$(mktemp -d)"
  gcloud_log="$temp_dir/gcloud.log"
  evidence_file="$temp_dir/staging-evidence.env"
  actual_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  cat > "$temp_dir/gcloud" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${SHIPMASTR_TEST_GCLOUD_LOG:?}"

if [[ "${1:-}" == "auth" && "${2:-}" == "list" ]]; then
  printf '%s\n' 'shipmastr-deployer-staging@shipmastr-core-prod.iam.gserviceaccount.com'
  exit 0
fi

if [[ "${1:-}" == "config" && "${2:-}" == "get-value" ]]; then
  printf '%s\n' '(unset)'
  exit 0
fi

if [[ "${1:-}" == "run" && "${2:-}" == "services" && "${3:-}" == "describe" ]]; then
  printf '%s\n' 'https://staging.example.invalid'
  exit 0
fi

exit 0
MOCK

  cat > "$temp_dir/curl" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK

  chmod 700 "$temp_dir/gcloud" "$temp_dir/curl"

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

    PATH="$temp_dir:$PATH" \
    SHIPMASTR_TEST_GCLOUD_LOG="$gcloud_log" \
    SHIPMASTR_APPROVED_COMMIT_SHA="$actual_head" \
    SHIPMASTR_PUBLIC_ACCESS_EXPECTATION=public \
    SHIPMASTR_PUBLIC_ACCESS_APPROVAL='APPROVE RETAIN CURRENT PUBLIC INVOCATION STATE' \
    SHIPMASTR_STAGING_DEPLOY_APPROVAL='APPROVE SHIPMASTR STAGING DEPLOY' \
    SHIPMASTR_STAGING_EVIDENCE_OUTPUT="$evidence_file" \
    MIGRATION_STATUS_JOB='shipmastr-prisma-migrate-status-prod' \
    IMAGE_DIGEST="$TEST_DIGEST" \
    /bin/bash "$SCRIPT_DIR/deploy-staging.sh" \
      >/dev/null 2>&1
  )

  if grep -Fq 'builds submit' "$gcloud_log"; then
    rm -rf "$temp_dir"
    return 1
  fi

  if grep -Fq 'artifacts docker images describe' "$gcloud_log"; then
    rm -rf "$temp_dir"
    return 1
  fi

  grep -Fq 'run deploy shipmastr-api-staging' "$gcloud_log"

  if grep -Fq 'shipmastr-prisma-migrate-status-prod' "$gcloud_log"; then
    rm -rf "$temp_dir"
    return 1
  fi

  grep -Fq 'shipmastr-prisma-migrate-status-staging' "$gcloud_log"

  [[ -f "$evidence_file" && ! -L "$evidence_file" ]]

  evidence_sha="$(
    shipmastr_governance_sha256_file "$evidence_file"
  )"

  shipmastr_governance_verify_staging_evidence \
    "$evidence_file" \
    "$evidence_sha" \
    "$actual_head" \
    "$TEST_DIGEST"

  rm -rf "$temp_dir"
}

caller_test_variables_cannot_bypass() {
  local script_path="$1"
  local output_file

  output_file="$(mktemp)"

  if (
    unset SHIPMASTR_APPROVED_COMMIT_SHA
    unset GOOGLE_APPLICATION_CREDENTIALS
    unset PROJECT PROJECT_ID REGION
    unset SERVICE SERVICE_NAME CLOUD_RUN_SERVICE
    unset SERVICE_ACCOUNT CLOUD_SQL_INSTANCE

    SHIPMASTR_GOVERNANCE_TEST_MODE=1 \
    SHIPMASTR_TEST_REPO_CLEAN=1 \
    SHIPMASTR_TEST_HEAD_SHA="$TEST_SHA" \
    SHIPMASTR_TEST_ORIGIN_MAIN_SHA="$TEST_SHA" \
    SHIPMASTR_TEST_EFFECTIVE_IDENTITY='shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com' \
    /bin/bash "$script_path"
  ) >"$output_file" 2>&1; then
    rm -f "$output_file"
    return 1
  fi

  grep -Fq \
    'SHIPMASTR_DEPLOYMENT_BLOCKED=APPROVED_COMMIT_SHA_REQUIRED' \
    "$output_file"

  rm -f "$output_file"
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
expect_pass production_positive production_positive
expect_fail production_missing_digest production_missing_digest
expect_fail production_digest_mismatch production_digest_mismatch
expect_fail production_evidence_hash_mismatch production_evidence_hash_mismatch
expect_fail production_evidence_commit_mismatch production_evidence_commit_mismatch
expect_fail production_remote_main_mismatch production_remote_main_mismatch
expect_fail owner_without_break_glass owner_without_break_glass
expect_pass owner_with_break_glass owner_with_break_glass
expect_fail key_file_rejected key_file_rejected
expect_fail public_approval_required public_approval_required
expect_pass migration_status_positive migration_status_positive
expect_fail migration_wrong_identity migration_wrong_identity
expect_fail migration_build_without_approval migration_build_without_approval
expect_pass staging_prebuilt_wrapper_skips_build staging_prebuilt_wrapper_skips_build
expect_pass caller_test_vars_cannot_bypass_staging \
  caller_test_variables_cannot_bypass "$SCRIPT_DIR/deploy-staging.sh"
expect_pass caller_test_vars_cannot_bypass_production \
  caller_test_variables_cannot_bypass "$SCRIPT_DIR/deploy-prod.sh"
expect_pass implementation_files_removed implementation_files_removed
expect_pass production_governance_has_no_test_hooks production_governance_has_no_test_hooks
expect_pass implicit_public_access_flag_absent implicit_public_access_flag_absent
expect_pass sensitive_deploy_targets_are_frozen sensitive_deploy_targets_are_frozen
expect_pass canonical_origin_positive canonical_origin_positive
expect_fail canonical_origin_rejects_noncanonical_url   canonical_origin_rejects_noncanonical_url
expect_fail canonical_origin_rejects_url_rewrite   canonical_origin_rejects_url_rewrite
expect_pass production_database_allowlist_is_strict   production_database_allowlist_is_strict

echo "I5B1_GOVERNANCE_TEST_COUNT=$pass_count"
echo "I5B1_GOVERNANCE_TESTS=PASS"
