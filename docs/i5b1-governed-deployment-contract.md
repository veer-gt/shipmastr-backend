# Shipmastr I5B-1 Governed Deployment Contract

Status: repository implementation active; no cloud authority is created by
this change.

## Enforced now

- `scripts/deploy-prod.sh` and `scripts/deploy-staging.sh` are the only
  supported application deployment entry points.
- Deployment logic remains inside those governed entry points after the
  fail-closed guard.
- No standalone implementation script or caller-controlled environment flag
  can bypass the governance checks.
- Production requires an immutable Artifact Registry image digest and proof
  that it matches the staging-tested digest.
- Source must be clean and match an explicitly approved commit.
- Production source must equal `origin/main`.
- Project, region, active service target, current runtime service account and
  current Cloud SQL attachment are hard allowlisted.
- The quarantined canary and preview services cannot be deployment targets.
- Service-account JSON key credentials are prohibited.
- Staging and production deployment identities cannot cross environments.
- The human owner may deploy only with an exact break-glass approval.
- The deployment implementations no longer contain
  `--allow-unauthenticated`; application deployment therefore does not
  mutate public IAM. Retaining the current public state still requires an
  explicit expectation and approval.
- Migration image builds use `scripts/submit-migration-build.sh` and require a
  separate approval. Building an image never authorizes migration execution.
- No load-balancer work is authorized.

## Temporary shared resources

Until I1 and I3 are implemented, the guard deliberately records the current
shared resources:

- `shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com`
- `shipmastr-core-prod:asia-south1:shipmastr-postgres`

This does not claim isolation. Later phases must update these allowlists and
prove denied cross-environment access at the IAM layer.

## Staging requirements

- `SHIPMASTR_APPROVED_COMMIT_SHA`
- `SHIPMASTR_STAGING_DEPLOY_APPROVAL=APPROVE SHIPMASTR STAGING DEPLOY`
- `SHIPMASTR_PUBLIC_ACCESS_EXPECTATION=public`
- `SHIPMASTR_PUBLIC_ACCESS_APPROVAL=APPROVE RETAIN CURRENT PUBLIC INVOCATION STATE`
- either immutable `IMAGE_DIGEST` (which skips rebuilding), or
  `SHIPMASTR_STAGING_BUILD_APPROVAL=APPROVE BUILD IMMUTABLE STAGING ARTIFACT`

## Production requirements

- `SHIPMASTR_APPROVED_COMMIT_SHA`
- `SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL=APPROVE SHIPMASTR PRODUCTION PROMOTION`
- `CONFIRM_PROD_DEPLOY=shipmastr-prod`
- immutable `IMAGE_DIGEST`
- identical `SHIPMASTR_STAGING_IMAGE_DIGEST`
- `SHIPMASTR_STAGING_EVIDENCE_SHA256`
- explicit current-public-state expectation and approval

## Owner break glass

`SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL=APPROVE SHIPMASTR OWNER BREAK GLASS DEPLOYMENT`

This is an emergency path, not routine deployment authority.

## Structural limit

Repository gates reduce accidental and undocumented deployment paths.
Complete environment isolation still depends on dedicated deployer/runtime
identities, environment-specific secrets and databases, followed by negative
authorization tests.

## Test isolation

- production governance version 2 contains no caller-controlled test mode;
- `SHIPMASTR_GOVERNANCE_TEST_MODE` and every `SHIPMASTR_TEST_*` variable are
  ignored because production code does not reference them;
- offline tests replace shell functions only inside the test process.
