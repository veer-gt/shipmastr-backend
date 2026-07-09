#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-shipmastr-core-prod}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-shipmastr-api}"
STAGING_SERVICE="${STAGING_SERVICE:-shipmastr-api-staging}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-shipmastr}"
IMAGE_NAME="${IMAGE_NAME:-shipmastr-api}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-shipmastr-core-prod:asia-south1:shipmastr-postgres}"
MIGRATION_STATUS_JOB="${MIGRATION_STATUS_JOB:-shipmastr-prisma-migrate-status-prod}"
PROD_DATABASE_URL_SECRET="${PROD_DATABASE_URL_SECRET:-DATABASE_URL}"
PROD_DATABASE_NAME_ALLOWLIST="${PROD_DATABASE_NAME_ALLOWLIST:-shipmastr,shipmastr_prod,shipmastr_production}"
EMAIL_QUEUE_NAME="${EMAIL_QUEUE_NAME:-shipmastr-email-queue}"
TASK_HANDLER_URL="${TASK_HANDLER_URL:-https://shipmastr-api-525178961393.asia-south1.run.app/v1/tasks/email/lead-notification}"
EMAIL_FROM="${EMAIL_FROM:-noreply@shipmastr.com}"
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-Shipmastr}"
SMTP_REPLY_TO="${SMTP_REPLY_TO:-no-reply@shipmastr.com}"
ADMIN_EMAIL="${ADMIN_EMAIL:-indraveer.chauhan@gmail.com}"
QUOTE_PRICE_SOURCE="${QUOTE_PRICE_SOURCE:-catalog_strict}"
STOREFRONT_ASSETS_GCS_BUCKET="${STOREFRONT_ASSETS_GCS_BUCKET:-}"
STOREFRONT_ASSETS_GCS_PROJECT_ID="${STOREFRONT_ASSETS_GCS_PROJECT_ID:-${PROJECT_ID}}"
STOREFRONT_ASSETS_CDN_HOST="${STOREFRONT_ASSETS_CDN_HOST:-assets.shipmastr.com}"
STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT="${STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT:-${SERVICE_ACCOUNT}}"
PROD_STOREFRONT_ASSETS_BUCKET_ALLOWLIST="${PROD_STOREFRONT_ASSETS_BUCKET_ALLOWLIST:-shipmastr-core-prod-storefront-assets}"
DEPLOY_DRY_RUN="${DEPLOY_DRY_RUN:-0}"
DEPLOY_NO_TRAFFIC="${DEPLOY_NO_TRAFFIC:-0}"
DEPLOY_TAG="${DEPLOY_TAG:-storefront-prod-candidate}"

# Production app deploy remains a separate approval. Use DEPLOY_DRY_RUN=1 to
# render the command, or DEPLOY_NO_TRAFFIC=1 to create a tagged candidate for
# smoke testing before any separately approved traffic shift.
PROD_ENV_VARS="APP_ENV=production,GCP_PROJECT_ID=${PROJECT_ID},CLOUD_TASKS_LOCATION=${REGION},EMAIL_QUEUE_NAME=${EMAIL_QUEUE_NAME},TASK_HANDLER_URL=${TASK_HANDLER_URL},EMAIL_FROM=${EMAIL_FROM},EMAIL_FROM_NAME=${EMAIL_FROM_NAME},SMTP_REPLY_TO=${SMTP_REPLY_TO},ADMIN_EMAIL=${ADMIN_EMAIL},QUOTE_PRICE_SOURCE=${QUOTE_PRICE_SOURCE},STOREFRONT_ASSETS_GCS_BUCKET=${STOREFRONT_ASSETS_GCS_BUCKET},STOREFRONT_ASSETS_GCS_PROJECT_ID=${STOREFRONT_ASSETS_GCS_PROJECT_ID},STOREFRONT_ASSETS_CDN_HOST=${STOREFRONT_ASSETS_CDN_HOST},STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT=${STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT},ALLOW_CLOUDFLARE_ADMIN_MUTATIONS=true,ALLOW_APEX_DOMAIN_AUTOMATION=true,CLOUDFLARE_AUTH_MODE=api_token"
PROD_SECRET_BINDINGS="DATABASE_URL=DATABASE_URL:latest,JWT_SECRET=JWT_SECRET:latest,APP_SECRET_PEPPER=APP_SECRET_PEPPER:latest,WEBHOOK_SECRET=WEBHOOK_SECRET:latest,ADDRESS_PHONE_PEPPER=ADDRESS_PHONE_PEPPER:latest,CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET=CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_PORT=SMTP_PORT:latest,SMTP_SECURE=SMTP_SECURE:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest,CLOUDFLARE_API_TOKEN=CLOUDFLARE_API_TOKEN:latest,CLOUDFLARE_ZONE_ID=CLOUDFLARE_ZONE_ID:latest"

quote_command() {
  local quoted=""
  local arg
  for arg in "$@"; do
    printf -v arg "%q" "${arg}"
    quoted+="${arg} "
  done
  printf '%s\n' "${quoted% }"
}

validate_binary_flag() {
  local name="$1"
  local value="$2"
  if [[ "${value}" != "0" && "${value}" != "1" ]]; then
    echo "${name} must be 0 or 1" >&2
    exit 1
  fi
}

validate_deploy_mode_flags() {
  validate_binary_flag "DEPLOY_DRY_RUN" "${DEPLOY_DRY_RUN}"
  validate_binary_flag "DEPLOY_NO_TRAFFIC" "${DEPLOY_NO_TRAFFIC}"

  if [[ "${DEPLOY_NO_TRAFFIC}" == "1" ]]; then
    if [[ -z "${DEPLOY_TAG}" ]]; then
      echo "DEPLOY_TAG is required when DEPLOY_NO_TRAFFIC=1" >&2
      exit 1
    fi

    if [[ ! "${DEPLOY_TAG}" =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
      echo "DEPLOY_TAG must be a lowercase Cloud Run tag up to 63 chars" >&2
      exit 1
    fi
  fi
}

verify_checkout_dev_otp_not_set() {
  if [[ -n "${CHECKOUT_DEV_OTP_CODE:-}" ]]; then
    echo "CHECKOUT_DEV_OTP_CODE must not be set for production deploys - deploy blocked" >&2
    exit 1
  fi
}

verify_production_database_target() {
  if [[ "${PROD_DATABASE_URL_SECRET}" != "DATABASE_URL" ]]; then
    echo "Production DATABASE_URL secret resolution ambiguous - deploy blocked" >&2
    exit 1
  fi

  local database_url
  local secret_status

  set +e
  database_url="$(gcloud secrets versions access latest \
    --secret "${PROD_DATABASE_URL_SECRET}" \
    --project "${PROJECT_ID}" 2>/dev/null)"
  secret_status=$?
  set -e

  if [[ "${secret_status}" -ne 0 || -z "${database_url}" ]]; then
    echo "Production DATABASE_URL secret could not be resolved - deploy blocked" >&2
    exit 1
  fi

  local database_identifier
  local verify_status

  set +e
  database_identifier="$(
    DATABASE_URL_TO_VERIFY="${database_url}" \
    PROD_DATABASE_NAME_ALLOWLIST="${PROD_DATABASE_NAME_ALLOWLIST}" \
    node <<'NODE'
const rawUrl = process.env.DATABASE_URL_TO_VERIFY || "";
const allowlist = (process.env.PROD_DATABASE_NAME_ALLOWLIST || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  console.error("INVALID_DATABASE_URL");
  process.exit(2);
}

const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, "").split("?")[0] || "");
if (!databaseName) {
  console.error("MISSING_DATABASE_NAME");
  process.exit(3);
}

if (/(staging|stage|dev|development|local|scratch|test|ci)/i.test(databaseName)) {
  console.error("NON_PRODUCTION_DATABASE_NAME");
  process.exit(4);
}

if (!allowlist.includes(databaseName) && !/(prod|production)/i.test(databaseName)) {
  console.error("DATABASE_NAME_NOT_ALLOWLISTED");
  process.exit(5);
}

console.log(`database=${databaseName}`);
NODE
  )"
  verify_status=$?
  set -e

  unset database_url

  if [[ "${verify_status}" -ne 0 ]]; then
    echo "Production DB target could not be proven safe - deploy blocked" >&2
    exit 1
  fi

  echo "Production DB target verified: ${database_identifier}"
}

run_production_migration_status_gate() {
  echo "Production migration status gate running"
  verify_production_database_target

  echo "Running production Prisma migration status gate with ${IMAGE_DIGEST}"
  local deploy_status
  set +e
  gcloud run jobs deploy "${MIGRATION_STATUS_JOB}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --image "${IMAGE_DIGEST}" \
    --service-account "${SERVICE_ACCOUNT}" \
    --set-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
    --set-env-vars "APP_ENV=production" \
    --set-secrets "DATABASE_URL=${PROD_DATABASE_URL_SECRET}:latest" \
    --command "npx" \
    --args "prisma,migrate,status,--schema,prisma/schema.prisma" \
    --max-retries 0 \
    --task-timeout 600s \
    --quiet
  deploy_status=$?
  set -e

  if [[ "${deploy_status}" -ne 0 ]]; then
    echo "Production migration status gate could not be prepared - deploy blocked" >&2
    exit 1
  fi

  local status_code
  set +e
  gcloud run jobs execute "${MIGRATION_STATUS_JOB}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --wait
  status_code=$?
  set -e

  if [[ "${status_code}" -ne 0 ]]; then
    echo "Production migrations pending — deploy blocked" >&2
    echo "Run approved production migration procedure before deploy" >&2
    exit 1
  fi

  echo "Production Prisma migration status gate passed"
}

verify_production_storefront_asset_target_local() {
  if [[ -z "${STOREFRONT_ASSETS_GCS_BUCKET}" ]]; then
    echo "Production storefront asset bucket is not configured - deploy blocked" >&2
    exit 1
  fi

  if [[ -z "${STOREFRONT_ASSETS_GCS_PROJECT_ID}" || "${STOREFRONT_ASSETS_GCS_PROJECT_ID}" != "${PROJECT_ID}" ]]; then
    echo "Production storefront asset bucket project is ambiguous - deploy blocked" >&2
    exit 1
  fi

  local bucket_lower
  bucket_lower="$(printf '%s' "${STOREFRONT_ASSETS_GCS_BUCKET}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${bucket_lower}" == "shipmastr-ci-assets" || "${bucket_lower}" =~ (staging|stage|dev|development|local|scratch|test|ci) ]]; then
    echo "Production storefront asset bucket looks non-production - deploy blocked" >&2
    exit 1
  fi

  local bucket_allowed="false"
  local bucket_candidate
  IFS=',' read -ra allowed_buckets <<< "${PROD_STOREFRONT_ASSETS_BUCKET_ALLOWLIST}"
  for bucket_candidate in "${allowed_buckets[@]}"; do
    bucket_candidate="$(printf '%s' "${bucket_candidate}" | xargs)"
    if [[ "${STOREFRONT_ASSETS_GCS_BUCKET}" == "${bucket_candidate}" ]]; then
      bucket_allowed="true"
      break
    fi
  done

  if [[ "${bucket_allowed}" != "true" ]]; then
    echo "Production storefront asset bucket is not allowlisted - deploy blocked" >&2
    exit 1
  fi

  if [[ -z "${STOREFRONT_ASSETS_CDN_HOST}" ]]; then
    echo "Production storefront assets CDN host is not configured - deploy blocked" >&2
    exit 1
  fi

  local cdn_lower
  cdn_lower="$(printf '%s' "${STOREFRONT_ASSETS_CDN_HOST}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${cdn_lower}" =~ (staging|stage|dev|development|local|scratch|test|ci) ]]; then
    echo "Production storefront assets CDN host looks non-production - deploy blocked" >&2
    exit 1
  fi

  if [[ -z "${STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT}" ]]; then
    echo "Production storefront assets signing service account is not configured - deploy blocked" >&2
    exit 1
  fi
}

verify_production_storefront_asset_target() {
  verify_production_storefront_asset_target_local

  local bucket_metadata
  local bucket_status
  set +e
  bucket_metadata="$(gcloud storage buckets describe "gs://${STOREFRONT_ASSETS_GCS_BUCKET}" \
    --project "${STOREFRONT_ASSETS_GCS_PROJECT_ID}" \
    --format='value(name,location)' 2>/dev/null)"
  bucket_status=$?
  set -e

  if [[ "${bucket_status}" -ne 0 || -z "${bucket_metadata}" ]]; then
    echo "Production storefront asset bucket could not be verified - deploy blocked" >&2
    exit 1
  fi

  echo "Production storefront asset bucket verified: ${bucket_metadata}"
}

build_deploy_command() {
  DEPLOY_COMMAND=(
    gcloud run deploy "${SERVICE}"
    --project "${PROJECT_ID}"
    --region "${REGION}"
    --image "${IMAGE_DIGEST}"
    --platform managed
    --allow-unauthenticated
    --service-account "${SERVICE_ACCOUNT}"
    --add-cloudsql-instances "${CLOUD_SQL_INSTANCE}"
    --min-instances 1
    --max-instances 5
    --set-env-vars "${PROD_ENV_VARS}"
    --set-secrets "${PROD_SECRET_BINDINGS}"
  )

  if [[ "${DEPLOY_NO_TRAFFIC}" == "1" ]]; then
    DEPLOY_COMMAND+=(--no-traffic --tag "${DEPLOY_TAG}")
  fi
}

render_deploy_plan() {
  if [[ -z "${IMAGE_DIGEST:-}" ]]; then
    echo "Set IMAGE_DIGEST to a staging-tested immutable digest before DEPLOY_DRY_RUN=1." >&2
    echo "Dry-run mode will not build or push a production image." >&2
    exit 1
  fi

  verify_production_storefront_asset_target_local
  build_deploy_command

  echo "DEPLOY_DRY_RUN=1: no gcloud deploy, image build, traffic shift, DB mutation, or production write will run."
  echo "Production gates preserved for real deploys: asset target guard, staging health check, migration status gate, immutable digest deploy."
  if [[ "${DEPLOY_NO_TRAFFIC}" == "1" ]]; then
    echo "No-traffic candidate mode: ENABLED"
    echo "Traffic shift prevention: deploy command includes --no-traffic and --tag ${DEPLOY_TAG}."
    echo "Future safe sequence: deploy no-traffic tagged revision, smoke tagged URL, then shift traffic only under separate explicit approval."
  else
    echo "No-traffic candidate mode: disabled; normal deploy mode would shift traffic if explicitly approved and executed."
  fi

  echo "Safe deploy command preview:"
  quote_command "${DEPLOY_COMMAND[@]}"

  if [[ "${DEPLOY_NO_TRAFFIC}" == "1" ]]; then
    echo "After a future successful no-traffic deploy, retrieve the tagged URL with:"
    quote_command gcloud run services describe "${SERVICE}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --format "value(status.traffic[?tag=\"${DEPLOY_TAG}\"].url)"
  fi
}

print_service_traffic() {
  local label="$1"
  echo "${label}"
  gcloud run services describe "${SERVICE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format='table(status.traffic[].revisionName,status.traffic[].percent,status.traffic[].tag)'
}

validate_deploy_mode_flags
verify_checkout_dev_otp_not_set

if [[ "${PROD_MIGRATION_STATUS_DRY_RUN_ONLY:-}" == "1" ]]; then
  if [[ "${APPROVE_PRODUCTION_MIGRATION_STATUS_DRY_RUN:-}" != "APPROVE PRODUCTION MIGRATION STATUS DRY RUN" ]]; then
    echo "Refusing production migration status dry run without exact approval phrase." >&2
    exit 1
  fi
  if [[ -z "${IMAGE_DIGEST:-}" ]]; then
    echo "Set IMAGE_DIGEST to the staging-tested backend image digest before the dry run." >&2
    exit 1
  fi
  run_production_migration_status_gate
  echo "Production migration status dry run passed; no deploy attempted."
  exit 0
fi

if [[ "${DEPLOY_DRY_RUN}" == "1" ]]; then
  render_deploy_plan
  exit 0
fi

if [[ "${CONFIRM_PROD_DEPLOY:-}" != "shipmastr-prod" ]]; then
  echo "Refusing prod deploy. Set CONFIRM_PROD_DEPLOY=shipmastr-prod after staging smoke passes." >&2
  exit 1
fi

verify_production_storefront_asset_target

STAGING_URL="$(gcloud run services describe "${STAGING_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

echo "Verifying staging health before prod promotion: ${STAGING_URL}"
curl -fsS "${STAGING_URL}/v1/health" >/dev/null

if [[ -z "${IMAGE_DIGEST:-}" ]]; then
  TAG="${TAG:-prod-$(date -u +%Y%m%d%H%M%S)}"
  IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}:${TAG}"
  IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}"

  echo "No IMAGE_DIGEST supplied. Building backend image for prod: ${IMAGE_URI}"
  gcloud builds submit . \
    --project "${PROJECT_ID}" \
    --tag "${IMAGE_URI}"

  DIGEST="$(gcloud artifacts docker images describe "${IMAGE_URI}" \
    --project "${PROJECT_ID}" \
    --format='value(image_summary.digest)')"

  if [[ -z "${DIGEST}" ]]; then
    echo "Could not resolve image digest for ${IMAGE_URI}" >&2
    exit 1
  fi

  IMAGE_DIGEST="${IMAGE_BASE}@${DIGEST}"
fi

run_production_migration_status_gate

echo "Deploying ${SERVICE} by immutable digest: ${IMAGE_DIGEST}"
if [[ "${DEPLOY_NO_TRAFFIC}" == "1" ]]; then
  echo "No-traffic candidate deploy enabled with tag: ${DEPLOY_TAG}"
  echo "This deploy will not shift production traffic."
  echo "Shift traffic only under separate explicit approval after tagged URL smoke is GREEN."
fi

print_service_traffic "Current ${SERVICE} traffic before deploy:"
build_deploy_command
"${DEPLOY_COMMAND[@]}"

if [[ "${DEPLOY_NO_TRAFFIC}" == "1" ]]; then
  print_service_traffic "Current ${SERVICE} traffic after no-traffic candidate deploy:"
  echo "No-traffic candidate deploy completed. Retrieve tagged URL with:"
  quote_command gcloud run services describe "${SERVICE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format "value(status.traffic[?tag=\"${DEPLOY_TAG}\"].url)"
  echo "Do not shift traffic until a separate production traffic-shift approval is granted."
  exit 0
fi

PROD_URL="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

curl -fsS "${PROD_URL}/v1/health" >/dev/null
echo "Prod deploy passed health check: ${PROD_URL}"
