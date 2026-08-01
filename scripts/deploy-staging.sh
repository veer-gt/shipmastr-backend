#!/usr/bin/env bash
set -euo pipefail
set -f

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deployment-governance.sh"

[[ "$#" -eq 0 ]] || {
  echo "SHIPMASTR_DEPLOYMENT_BLOCKED=ARGUMENTS_NOT_SUPPORTED" >&2
  exit 64
}

shipmastr_deployment_guard staging

# Deployment logic intentionally remains in this governed entry point.
# No caller-controlled environment variable can bypass the guard above.

PROJECT_ID="${PROJECT_ID:-shipmastr-core-prod}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-shipmastr-api-staging}"
PROD_SERVICE="${PROD_SERVICE:-shipmastr-api}"
readonly MIGRATION_STATUS_JOB="shipmastr-prisma-migrate-status-staging"
readonly PLATFORM_CREDENTIAL_ENCRYPTION_SECRET="PLATFORM_CREDENTIAL_ENCRYPTION_KEY"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-shipmastr}"
IMAGE_NAME="${IMAGE_NAME:-shipmastr-api}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-shipmastr-core-prod:asia-south1:shipmastr-postgres}"
EMAIL_QUEUE_NAME="${EMAIL_QUEUE_NAME:-shipmastr-email-queue}"
TASK_HANDLER_URL="${TASK_HANDLER_URL:-https://shipmastr-api-staging-525178961393.asia-south1.run.app/v1/tasks/email/lead-notification}"
EMAIL_FROM="${EMAIL_FROM:-noreply@shipmastr.com}"
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-Shipmastr}"
SMTP_REPLY_TO="${SMTP_REPLY_TO:-no-reply@shipmastr.com}"
ADMIN_EMAIL="${ADMIN_EMAIL:-indraveer.chauhan@gmail.com}"
QUOTE_PRICE_SOURCE="${QUOTE_PRICE_SOURCE:-catalog_strict}"
STOREFRONT_ASSETS_GCS_BUCKET="${STOREFRONT_ASSETS_GCS_BUCKET:-shipmastr-ci-assets}"
STOREFRONT_ASSETS_GCS_PROJECT_ID="${STOREFRONT_ASSETS_GCS_PROJECT_ID:-${PROJECT_ID}}"
STOREFRONT_ASSETS_CDN_HOST="${STOREFRONT_ASSETS_CDN_HOST:-assets.shipmastr.com}"
STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT="${STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT:-${SERVICE_ACCOUNT}}"
TAG="${TAG:-staging-$(date -u +%Y%m%d%H%M%S)}"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}"
STAGING_SECRET_BINDINGS="DATABASE_URL=DATABASE_URL_STAGING:latest,JWT_SECRET=JWT_SECRET:latest,APP_SECRET_PEPPER=APP_SECRET_PEPPER:latest,WEBHOOK_SECRET=WEBHOOK_SECRET:latest,ADDRESS_PHONE_PEPPER=ADDRESS_PHONE_PEPPER:latest,CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET=CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_PORT=SMTP_PORT:latest,SMTP_SECURE=SMTP_SECURE:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest,CLOUDFLARE_API_TOKEN=CLOUDFLARE_API_TOKEN:latest,CLOUDFLARE_ZONE_ID=CLOUDFLARE_ZONE_ID:latest,PLATFORM_CREDENTIAL_ENCRYPTION_KEY=${PLATFORM_CREDENTIAL_ENCRYPTION_SECRET}:latest"
readonly INVOCATION_UTC="$(date -u +%Y%m%d%H%M%S)"
readonly REVISION_SUFFIX="sf-${SHIPMASTR_APPROVED_COMMIT_SHA:0:7}-${INVOCATION_UTC}-$$"
readonly EXPECTED_REVISION="${SERVICE}-${REVISION_SUFFIX}"
readonly CANDIDATE_TAG="${REVISION_SUFFIX}"

if [[ "${#EXPECTED_REVISION}" -gt 63 || \
  ! "$REVISION_SUFFIX" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ || \
  ! "$CANDIDATE_TAG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "Generated staging invocation identifier is not Cloud Run name-safe" >&2
  exit 1
fi

verify_staging_deploy_result() {
  local deploy_result_path="$1"

  DEPLOY_RESULT_PATH="$deploy_result_path" \
  EXPECTED_REVISION_TO_VERIFY="$EXPECTED_REVISION" \
  node <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.env.DEPLOY_RESULT_PATH, "utf8"));
const expectedRevision = process.env.EXPECTED_REVISION_TO_VERIFY || "";

if (result?.status?.latestCreatedRevisionName !== expectedRevision) {
  process.exit(2);
}
NODE
}

verify_staging_revision_metadata() {
  local revision_metadata="$1"

  REVISION_METADATA_TO_VERIFY="$revision_metadata" \
  EXPECTED_REVISION_TO_VERIFY="$EXPECTED_REVISION" \
  EXPECTED_SERVICE_TO_VERIFY="$SERVICE" \
  EXPECTED_DIGEST_TO_VERIFY="$IMAGE_DIGEST" \
  node <<'NODE'
const revision = JSON.parse(process.env.REVISION_METADATA_TO_VERIFY || "{}");
const expectedRevision = process.env.EXPECTED_REVISION_TO_VERIFY || "";
const expectedService = process.env.EXPECTED_SERVICE_TO_VERIFY || "";
const expectedDigest = process.env.EXPECTED_DIGEST_TO_VERIFY || "";
const conditions = revision?.status?.conditions || [];
const ready = conditions.some(
  (condition) => condition.type === "Ready" && condition.status === "True",
);

if (revision?.metadata?.name !== expectedRevision) {
  process.exit(2);
}

if (revision?.metadata?.labels?.["serving.knative.dev/service"] !== expectedService) {
  process.exit(3);
}

if (revision?.spec?.containers?.[0]?.image !== expectedDigest) {
  process.exit(4);
}

if (!ready) {
  process.exit(5);
}
NODE
}

verify_staging_candidate_binding() {
  local service_metadata="$1"
  local expected_url="${2:-}"
  local candidate_url

  if ! candidate_url="$(
    SERVICE_METADATA_TO_VERIFY="$service_metadata" \
    EXPECTED_CANDIDATE_TAG="$CANDIDATE_TAG" \
    EXPECTED_REVISION_TO_VERIFY="$EXPECTED_REVISION" \
    EXPECTED_CANDIDATE_URL="$expected_url" \
    node <<'NODE'
const metadata = JSON.parse(process.env.SERVICE_METADATA_TO_VERIFY || "{}");
const expectedTag = process.env.EXPECTED_CANDIDATE_TAG || "";
const expectedRevision = process.env.EXPECTED_REVISION_TO_VERIFY || "";
const expectedUrl = process.env.EXPECTED_CANDIDATE_URL || "";
const traffic = metadata?.status?.traffic || [];
const tagged = traffic.filter((entry) => entry.tag === expectedTag);

if (metadata?.status?.latestCreatedRevisionName !== expectedRevision) {
  process.exit(2);
}

if (tagged.length !== 1) {
  process.exit(3);
}

if (tagged[0].revisionName !== expectedRevision) {
  process.exit(4);
}

if (Number(tagged[0].percent || 0) !== 0) {
  process.exit(5);
}

const url = tagged[0].url || "";
if (!/^https:\/\/[^\s]+$/.test(url)) {
  process.exit(6);
}

if (expectedUrl && url !== expectedUrl) {
  process.exit(7);
}

process.stdout.write(`${url}\n`);
NODE
  )"; then
    echo "Staging candidate tag/revision binding is missing or ambiguous - deploy blocked" >&2
    return 1
  fi

  CANDIDATE_URL="$candidate_url"
}

verify_staging_active_traffic() {
  local service_metadata="$1"
  local revision="$2"
  local service_url

  if ! service_url="$(
    SERVICE_METADATA_TO_VERIFY="$service_metadata" \
    EXPECTED_ACTIVE_REVISION="$revision" \
    node <<'NODE'
const metadata = JSON.parse(process.env.SERVICE_METADATA_TO_VERIFY || "{}");
const expectedRevision = process.env.EXPECTED_ACTIVE_REVISION || "";
const traffic = metadata?.status?.traffic || [];
const positive = traffic.filter((entry) => Number(entry.percent || 0) > 0);

if (
  positive.length !== 1 ||
  positive[0].revisionName !== expectedRevision ||
  Number(positive[0].percent) !== 100
) {
  process.exit(2);
}

if (metadata?.status?.latestReadyRevisionName !== expectedRevision) {
  process.exit(3);
}

const url = metadata?.status?.url || "";
if (!/^https:\/\/[^\s]+$/.test(url)) {
  process.exit(4);
}

process.stdout.write(`${url}\n`);
NODE
  )"; then
    echo "Staging traffic is not exactly 100% on the verified candidate - deploy blocked" >&2
    return 1
  fi

  STAGING_SERVICE_URL="$service_url"
}

shipmastr_governance_verify_secret_metadata \
  "$PROJECT_ID" \
  "$PLATFORM_CREDENTIAL_ENCRYPTION_SECRET" \
  staging

if [[ -n "${IMAGE_DIGEST:-}" ]]; then
  echo "Using approved prebuilt staging image digest: ${IMAGE_DIGEST}"
else
  IMAGE_URI="${IMAGE_BASE}:${TAG}"

  echo "Building backend image for staging: ${IMAGE_URI}"
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

echo "Preparing ${SERVICE} candidate by immutable digest: ${IMAGE_DIGEST}"

echo "Running staging Prisma migration status gate with ${IMAGE_DIGEST}"
gcloud run jobs deploy "${MIGRATION_STATUS_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE_DIGEST}" \
  --service-account "${SERVICE_ACCOUNT}" \
  --set-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
  --set-env-vars "APP_ENV=staging" \
  --set-secrets "DATABASE_URL=DATABASE_URL_STAGING:latest" \
  --command "npx" \
  --args "prisma,migrate,status,--schema,prisma/schema.prisma" \
  --max-retries 0 \
  --task-timeout 600s \
  --quiet

gcloud run jobs execute "${MIGRATION_STATUS_JOB}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --wait

echo "Staging Prisma migration status gate passed"

DEPLOY_RESULT_PATH="$(mktemp "/tmp/shipmastr-staging-deploy.XXXXXX")"
cleanup_deploy_result() {
  rm -f "$DEPLOY_RESULT_PATH"
}
trap cleanup_deploy_result EXIT

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE_DIGEST}" \
  --platform managed \
  --service-account "${SERVICE_ACCOUNT}" \
  --add-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
  --min-instances 0 \
  --max-instances 2 \
  --revision-suffix "${REVISION_SUFFIX}" \
  --no-traffic \
  --tag "${CANDIDATE_TAG}" \
  --set-env-vars "APP_ENV=staging,GCP_PROJECT_ID=${PROJECT_ID},CLOUD_TASKS_LOCATION=${REGION},EMAIL_QUEUE_NAME=${EMAIL_QUEUE_NAME},TASK_HANDLER_URL=${TASK_HANDLER_URL},EMAIL_FROM=${EMAIL_FROM},EMAIL_FROM_NAME=${EMAIL_FROM_NAME},SMTP_REPLY_TO=${SMTP_REPLY_TO},ADMIN_EMAIL=${ADMIN_EMAIL},QUOTE_PRICE_SOURCE=${QUOTE_PRICE_SOURCE},STOREFRONT_ASSETS_GCS_BUCKET=${STOREFRONT_ASSETS_GCS_BUCKET},STOREFRONT_ASSETS_GCS_PROJECT_ID=${STOREFRONT_ASSETS_GCS_PROJECT_ID},STOREFRONT_ASSETS_CDN_HOST=${STOREFRONT_ASSETS_CDN_HOST},STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT=${STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT},ALLOW_CLOUDFLARE_ADMIN_MUTATIONS=true,ALLOW_APEX_DOMAIN_AUTOMATION=true,CLOUDFLARE_AUTH_MODE=api_token" \
  --set-secrets "${STAGING_SECRET_BINDINGS}" \
  --format=json \
  >"${DEPLOY_RESULT_PATH}"

verify_staging_deploy_result "$DEPLOY_RESULT_PATH"

CANDIDATE_REVISION_METADATA="$(gcloud run revisions describe "${EXPECTED_REVISION}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format=json)"
verify_staging_revision_metadata "$CANDIDATE_REVISION_METADATA"

CANDIDATE_SERVICE_METADATA="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format=json)"
verify_staging_candidate_binding "$CANDIDATE_SERVICE_METADATA"

echo "Staging candidate revision: ${EXPECTED_REVISION}"
echo "Running direct no-email candidate smoke tests: ${CANDIDATE_URL}"

curl -fsS "${CANDIDATE_URL}/v1/health" >/dev/null
curl -fsS "${CANDIDATE_URL}/api/health" >/dev/null

# Do not POST /v1/leads from automated deploy smoke. That route can enqueue
# or send transactional email in staging; lead-route smoke must remain a
# separate manual operator-approved test.

echo "Direct staging candidate digest and health checks passed"

PRE_TRAFFIC_SERVICE_METADATA="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format=json)"
verify_staging_candidate_binding \
  "$PRE_TRAFFIC_SERVICE_METADATA" \
  "$CANDIDATE_URL"

PRE_TRAFFIC_REVISION_METADATA="$(gcloud run revisions describe "${EXPECTED_REVISION}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format=json)"
verify_staging_revision_metadata "$PRE_TRAFFIC_REVISION_METADATA"

gcloud run services update-traffic "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --to-revisions "${EXPECTED_REVISION}=100" \
  --quiet

ACTIVE_SERVICE_METADATA="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format=json)"

verify_staging_active_traffic \
  "$ACTIVE_SERVICE_METADATA" \
  "$EXPECTED_REVISION"

curl -fsS "${STAGING_SERVICE_URL}/v1/health" >/dev/null
curl -fsS "${STAGING_SERVICE_URL}/api/health" >/dev/null

ACTIVE_REVISION_METADATA="$(gcloud run revisions describe "${EXPECTED_REVISION}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format=json)"
verify_staging_revision_metadata "$ACTIVE_REVISION_METADATA"

echo "Active staging traffic, health, and immutable digest checks passed"

STAGING_EVIDENCE_SHA256="$(
  shipmastr_governance_write_staging_evidence \
    "${SHIPMASTR_STAGING_EVIDENCE_OUTPUT}" \
    "${SHIPMASTR_APPROVED_COMMIT_SHA}" \
    "${IMAGE_DIGEST}" \
    "${EXPECTED_REVISION}"
)"

echo "Image digest ready for promotion: ${IMAGE_DIGEST}"
echo "Staging evidence path: ${SHIPMASTR_STAGING_EVIDENCE_OUTPUT}"
echo "Staging evidence SHA-256: ${STAGING_EVIDENCE_SHA256}"
