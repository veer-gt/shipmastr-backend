# I5B-1 Repository Implementation

This change is repository-only.

## Files

- governed deployment entry points containing both the guard and the
  deployment logic:
  - `scripts/deploy-prod.sh`
  - `scripts/deploy-staging.sh`
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

## Direct-bypass removal

- the standalone production and staging implementation scripts were removed;
- deployment logic now executes only after the guard in each governed wrapper;
- spoofing the former `SHIPMASTR_GOVERNED_WRAPPER` variable is denied;
- the prebuilt staging digest path is tested through the full wrapper.

## Caller-controlled test-mode removal

- all production test-mode branches were removed from the governance file;
- production Git and GCP identity evidence is always read from real tools;
- offline mocks now exist only inside `deployment-governance.test.sh`;
- both real wrappers reject fabricated former test variables.

## Final target and evidence binding

- staging produces a versioned, hashable evidence receipt after successful
  migration-status and health gates;
- production binds commit, digest, service and smoke results to that receipt;
- production compares the approved commit to current remote GitHub `main`;
- caller overrides cannot change sensitive service, job or allowlist targets.
