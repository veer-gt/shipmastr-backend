# I5B-1 Repository Implementation

This change is repository-only.

## Files

- governed wrappers:
  - `scripts/deploy-prod.sh`
  - `scripts/deploy-staging.sh`
- preserved deployment logic:
  - `scripts/deploy-prod.implementation.sh`
  - `scripts/deploy-staging.implementation.sh`
- shared gate:
  - `scripts/deployment-governance.sh`
- offline tests:
  - `scripts/deployment-governance.test.sh`
- migration image-build wrapper:
  - `scripts/submit-migration-build.sh`
- contract:
  - `docs/i5b1-governed-deployment-contract.md`

The Cloud Build YAML files receive governance comments only. Their build
semantics are unchanged.

## Not performed

No Cloud Run deployment, IAM change, service-account creation, image build,
database connection, migration, secret read, public-access change, GitHub
push, pull request or load-balancer work is performed by this repository
commit.

## PR #100 correction

- migration identity failures are explicitly returned;
- an approved prebuilt staging digest skips `gcloud builds submit`;
- negative identity and prebuilt-artifact tests cover both paths.
