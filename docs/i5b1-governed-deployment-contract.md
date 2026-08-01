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
- Staging and production application services use separate platform credential
  encryption secret resources. Deploys verify only secret metadata and enabled
  version state; the deployment preflight never accesses or prints key payloads.
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
- a `PLATFORM_CREDENTIAL_ENCRYPTION_KEY` secret labeled
  `environment=staging` and `purpose=platform-credential-encryption`, with at
  least one enabled version

The application binds
`PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY:latest`.
The migration-status job receives only its database secret and never receives
the platform credential key.

Each staging run generates one unique, name-safe invocation identifier in the
form `sf-<commit7>-<UTC timestamp>-<shell pid>`. The identifier is used as both
the Cloud Run revision suffix and candidate tag, keeping the complete revision
name at most 63 characters. The `--no-traffic` deployment result is captured as
JSON and must report that exact expected revision. The revision must belong to
the fixed staging service, be Ready and carry the complete approved digest.
The service tag must uniquely target that revision at zero percent traffic.

The tagged URL is smoked directly. Immediately before the explicit
`--to-revisions REVISION=100 --quiet` operation, the tag/revision binding,
latest-created revision, readiness and digest are checked again. A concurrent
latest-created change, stale or ambiguous tag, nonzero candidate traffic,
startup failure, digest mismatch or candidate health failure exits without
moving traffic or writing evidence. After movement, governance requires one
positive target at exactly 100%, the expected latest-ready revision, both
generic service health paths and another exact active-revision digest check.

## Production requirements

- `SHIPMASTR_APPROVED_COMMIT_SHA`
- `SHIPMASTR_PRODUCTION_DEPLOY_APPROVAL=APPROVE SHIPMASTR PRODUCTION PROMOTION`
- `CONFIRM_PROD_DEPLOY=shipmastr-prod`
- immutable `IMAGE_DIGEST`
- identical `SHIPMASTR_STAGING_IMAGE_DIGEST`
- `SHIPMASTR_STAGING_EVIDENCE_SHA256`
- explicit current-public-state expectation and approval
- a `PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD` secret labeled
  `environment=production` and `purpose=platform-credential-encryption`, with
  at least one enabled version

The production application binding is
`PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD:latest`.
The production migration-status job receives neither environment's platform
credential key. Production remains fail-closed until the separately labeled
production secret exists; the staging secret is never reused.

`DEPLOY_DRY_RUN=1` is the one explicit exception to the secret-metadata
preflight: after normal identity and source governance, it renders the command
without reading production-key metadata and performs no job, service or
traffic mutation. It is not fully offline because normal identity and remote
source checks still run. Every mutating path, including production
migration-status-only mode and no-traffic candidate mode, verifies the
production-key metadata before deploying or executing a job or creating a
service revision.

## Owner break glass

`SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL=APPROVE SHIPMASTR OWNER BREAK GLASS DEPLOYMENT`

This is an emergency path, not routine deployment authority.

## Structural limit

Repository gates reduce accidental and undocumented deployment paths.
Complete environment isolation still depends on dedicated deployer/runtime
identities, environment-specific secrets and databases, followed by negative
authorization tests.

## Test isolation

- production governance version 5 contains no caller-controlled test mode;
- `SHIPMASTR_GOVERNANCE_TEST_MODE` and every `SHIPMASTR_TEST_*` variable are
  ignored because production code does not reference them;
- direct governance tests replace shell functions only inside the test process;
- every wrapper test prepends fail-closed `gcloud` and `curl` mocks; remote-main
  resolution is mocked where needed, and unknown external commands fail.

## Staging evidence and fixed targets

- staging writes V2 immutable evidence only after migration status, tagged
  candidate digest and health checks, exact traffic verification, active
  health checks and active-revision digest verification all pass;
- production verifies the evidence file hash and exact semantic contents;
- V2 binds the exact verified staging revision and
  `active_traffic_percent=100`; V1 evidence is rejected;
- evidence content is hashed and validated in a temporary file before its
  final atomic rename; a file without a separately reported and verified
  SHA-256 is not promotable;
- production resolves current remote `main` using `git ls-remote`;
- staging service, migration jobs, database-name allowlist and production
  storefront bucket allowlist are fixed repository constants.

## Canonical source and strict database allowlist

- production remote-main verification requires the configured and effective
  Git origin to resolve to the canonical Shipmastr backend repository;
- Git `insteadOf` rewriting to a different repository is rejected;
- the production database name must be an exact member of the fixed
  allowlist; names merely containing `prod` or `production` are rejected.

## Credential key lifecycle boundary

This repository correction adds environment-separated bindings and
metadata-only preflights. It does not create, read, rotate, disable, or destroy
any secret or secret version. Key rotation remains a separate governed task.

## Post-traffic staging failure boundary

Traffic movement and evidence publication are intentionally separate gates;
this correction adds no automatic rollback. After a successful traffic move,
a generic service-health failure, active-digest failure or evidence-publication
failure can leave staging serving the new revision. Without a valid V2 file
and its separately reported SHA-256, production promotion remains blocked. An
operator must use a separately reviewed staging rollback or correction when
the new staging revision should no longer serve traffic.
