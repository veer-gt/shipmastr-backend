#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-shipmastr-core-prod}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-shipmastr-api-staging}"
PROD_SERVICE="${PROD_SERVICE:-shipmastr-api}"
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
  --set-env-vars "APP_ENV=staging,GCP_PROJECT_ID=${PROJECT_ID},CLOUD_TASKS_LOCATION=${REGION},EMAIL_QUEUE_NAME=${EMAIL_QUEUE_NAME},TASK_HANDLER_URL=${TASK_HANDLER_URL},EMAIL_FROM=${EMAIL_FROM},EMAIL_FROM_NAME=${EMAIL_FROM_NAME},SMTP_REPLY_TO=${SMTP_REPLY_TO},ADMIN_EMAIL=${ADMIN_EMAIL}" \
  --set-secrets "DATABASE_URL=DATABASE_URL:latest,JWT_SECRET=JWT_SECRET:latest,APP_SECRET_PEPPER=APP_SECRET_PEPPER:latest,WEBHOOK_SECRET=WEBHOOK_SECRET:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_PORT=SMTP_PORT:latest,SMTP_SECURE=SMTP_SECURE:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest"

SERVICE_URL="$(gcloud run services describe "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)')"

echo "Staging URL: ${SERVICE_URL}"
echo "Running staging smoke tests"

curl -fsS "${SERVICE_URL}/v1/health" >/dev/null

SMOKE_EMAIL="staging-smoke+$(date -u +%Y%m%d%H%M%S)@shipmastr.com"
curl -fsS -X POST "${SERVICE_URL}/v1/leads" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Staging Smoke\",\"businessName\":\"Shipmastr Staging Smoke\",\"phone\":\"9999999999\",\"email\":\"${SMOKE_EMAIL}\",\"monthlyShipments\":\"test\",\"currentProvider\":\"staging\",\"biggestIssue\":\"smoke test\",\"notes\":\"Automated staging smoke test. Do not contact.\"}" >/dev/null

echo "Staging smoke passed: /v1/health and POST /v1/leads returned success"
echo "Image digest ready for promotion: ${IMAGE_DIGEST}"
