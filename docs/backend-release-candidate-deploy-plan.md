# Backend Release Candidate Deploy Plan

Status: BACKEND_RELEASE_CANDIDATE_AFTER_BUCKET_SPLIT

## Release Summary

Backend release candidate tag:
- BACKEND_RELEASE_CANDIDATE_AFTER_BUCKET_SPLIT

Confirm the exact commit before any live operation:
- git rev-parse --short HEAD
- git tag --points-at HEAD

This release includes bucket-split backend work for domains/storefronts, VAS, audit/auth/local-admin, autopilot, NDR, returns, settings, and logger/newsletter tests.

## Migration Gate

Do not deploy the API image until production migration status is verified.

The release scope from v0.1-prod-backend to HEAD includes many Prisma migrations. Some may already be applied in production, but production migration status must be checked first.

Decision tree:
1. If production schema is current: staging deploy may proceed.
2. If migrations are pending: require explicit approval before prisma migrate deploy.
3. If migration history is failed/diverged: stop and investigate.

## Safety

- No DNS mutation.
- No Cloudflare mutation.
- No Worker route mutation.
- No Hostinger/static deploy.
- No email sends during production smoke.
- No production DB write except approved Prisma migration.
- No Cloud Run change until explicit deploy approval.

## Safe Local Preflight

Commands:
- cd /Users/mac/shipmastr-fullstack/backend
- git status --short -uall
- git rev-parse --short HEAD
- git tag --points-at HEAD
- npx prisma validate
- npm run build
- npm test

## Release Scope Inspection

Commands:
- git log --oneline v0.1-prod-backend..HEAD
- git diff --name-status v0.1-prod-backend..HEAD -- prisma/schema.prisma prisma/migrations src package.json Dockerfile Dockerfile.migrate cloudbuild.migrate.yaml scripts

## Production Migration Status

Do not run until approved.

Status-only image build command:
- gcloud builds submit . --project shipmastr-core-prod --config cloudbuild.migrate-status.yaml

The status-only image uses Dockerfile.migrate-status and defaults to:
- npx prisma migrate status --schema prisma/schema.prisma

Use the approved Cloud Run job/container path with production DATABASE_URL from Secret Manager to check migration status first. Do not print DATABASE_URL.

Do not use cloudbuild.migrate.yaml for status checks. Dockerfile.migrate defaults to:
- npx prisma migrate deploy

Only run prisma migrate deploy after explicit approval.

Status decision tree:
1. Up to date: proceed to staging deploy approval.
2. Pending migrations: stop, list pending migrations, and request explicit migrate deploy approval.
3. Failed migration: stop and inspect _prisma_migrations through the approved DB/admin path.
4. Divergent history: stop and prepare a reviewed reconciliation plan. Do not use db push, migrate reset, or manual production edits.

## Backend Deploy

Staging first, do not run until approved:
- cd /Users/mac/shipmastr-fullstack/backend
- TAG=rc-after-bucket-split-YYYYMMDDHHMMSS scripts/deploy-staging.sh

Production only after staging smoke and migration approval:
- CONFIRM_PROD_DEPLOY=shipmastr-prod IMAGE_DIGEST="<staging-tested-image-digest>" scripts/deploy-prod.sh

## Rollback

Find current revisions before deploy:
- gcloud run revisions list --service shipmastr-api --region asia-south1 --project shipmastr-core-prod

Rollback traffic:
- gcloud run services update-traffic shipmastr-api --region asia-south1 --project shipmastr-core-prod --to-revisions <PREVIOUS_REVISION>=100

If migration was applied, rollback is not only traffic rollback. Prefer forward-fix unless a reviewed repair migration exists.

## Smoke Checklist

- GET /v1/health
- auth/login seller and admin
- invalid/expired token returns 401
- GET /v1/audit
- GET /v1/audit/summary
- domain public lookup
- domain read-only poll remains non-mutating
- storefront lookup/render still works
- VAS routes require JWT and seller scope
- automation/internal/admin routes enforce correct auth
- NDR action center
- returns action center and summary
- settings profile read/update only in staging or test merchant
- order creation sanity
- webhook signature rejection sanity

## Approval Gate

Before deploy, approve:
1. Production migration status check method.
2. Whether pending migrations may be applied.
3. Staging deploy.
4. Production deploy by immutable digest after staging smoke.
