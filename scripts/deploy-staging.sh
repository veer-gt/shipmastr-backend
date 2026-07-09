#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-shipmastr-core-prod}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-shipmastr-api-staging}"
PROD_SERVICE="${PROD_SERVICE:-shipmastr-api}"
MIGRATION_STATUS_JOB="${MIGRATION_STATUS_JOB:-shipmastr-prisma-migrate-status-staging}"
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

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}:${TAG}"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}"

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
echo "Deploying ${SERVICE} by immutable digest: ${IMAGE_DIGEST}"

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

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE_DIGEST}" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "${SERVICE_ACCOUNT}" \
  --add-cloudsql-instances "${CLOUD_SQL_INSTANCE}" \
  --min-instances 0 \
  --max-instances 2 \
  --set-env-vars "APP_ENV=staging,GCP_PROJECT_ID=${PROJECT_ID},CLOUD_TASKS_LOCATION=${REGION},EMAIL_QUEUE_NAME=${EMAIL_QUEUE_NAME},TASK_HANDLER_URL=${TASK_HANDLER_URL},EMAIL_FROM=${EMAIL_FROM},EMAIL_FROM_NAME=${EMAIL_FROM_NAME},SMTP_REPLY_TO=${SMTP_REPLY_TO},ADMIN_EMAIL=${ADMIN_EMAIL},QUOTE_PRICE_SOURCE=${QUOTE_PRICE_SOURCE},STOREFRONT_ASSETS_GCS_BUCKET=${STOREFRONT_ASSETS_GCS_BUCKET},STOREFRONT_ASSETS_GCS_PROJECT_ID=${STOREFRONT_ASSETS_GCS_PROJECT_ID},STOREFRONT_ASSETS_CDN_HOST=${STOREFRONT_ASSETS_CDN_HOST},STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT=${STOREFRONT_ASSETS_GCS_SIGNING_SERVICE_ACCOUNT},ALLOW_CLOUDFLARE_ADMIN_MUTATIONS=true,ALLOW_APEX_DOMAIN_AUTOMATION=true,CLOUDFLARE_AUTH_MODE=api_token" \
  --set-secrets "DATABASE_URL=DATABASE_URL_STAGING:latest,JWT_SECRET=JWT_SECRET:latest,APP_SECRET_PEPPER=APP_SECRET_PEPPER:latest,WEBHOOK_SECRET=WEBHOOK_SECRET:latest,ADDRESS_PHONE_PEPPER=ADDRESS_PHONE_PEPPER:latest,CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET=CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_PORT=SMTP_PORT:latest,SMTP_SECURE=SMTP_SECURE:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest,CLOUDFLARE_API_TOKEN=CLOUDFLARE_API_TOKEN:latest,CLOUDFLARE_ZONE_ID=CLOUDFLARE_ZONE_ID:latest"

SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

echo "Staging URL: ${SERVICE_URL}"
echo "Running no-email staging smoke tests"

curl -fsS "${SERVICE_URL}/v1/health" >/dev/null
curl -fsS "${SERVICE_URL}/api/health" >/dev/null

# Do not POST /v1/leads from automated deploy smoke. That route can enqueue
# or send transactional email in staging; lead-route smoke must remain a
# separate manual operator-approved test.

echo "No-email staging smoke passed: /v1/health and /api/health returned success"
echo "Image digest ready for promotion: ${IMAGE_DIGEST}"
