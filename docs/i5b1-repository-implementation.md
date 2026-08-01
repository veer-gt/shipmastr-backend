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
database connection, migration, secret payload read, secret creation or
rotation, public-access change, GitHub push, pull request or load-balancer work
is performed by this repository change.

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

- staging generates a unique `sf-<commit7>-<UTC>-<pid>` revision suffix and
  tag for each invocation and deploys it with `--no-traffic --format=json`;
- the deploy result must report the exact expected revision, and repeated
  service/revision descriptions must bind that revision to the fixed service,
  Ready state, zero-percent tag and complete immutable digest;
- the uniquely tagged candidate's direct
  `/v1/health` and `/api/health` results are verified before an explicit
  `--to-revisions REVISION=100` traffic operation;
- staging produces a V2 hashable evidence receipt only after the candidate
  gates, exact 100% traffic proof, generic service health and active-revision
  digest proof all pass;
- production binds commit, digest, exact staging revision, verified traffic
  and smoke results to that receipt and rejects V1 evidence;
- production compares the approved commit to current remote GitHub `main`;
- caller overrides cannot change sensitive service, job or allowlist targets.
- immediately before traffic, tag, revision, latest-created state, readiness
  and digest are revalidated to reject concurrent or stale-tag state.

## Environment-separated platform credential keys

- staging verifies metadata for the fixed
  `PLATFORM_CREDENTIAL_ENCRYPTION_KEY` resource and binds it only to the
  application as
  `PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY:latest`;
- production verifies metadata for the separate fixed
  `PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD` resource and binds it only to the
  application as
  `PLATFORM_CREDENTIAL_ENCRYPTION_KEY=PLATFORM_CREDENTIAL_ENCRYPTION_KEY_PROD:latest`;
- both preflights require the environment label, the
  `purpose=platform-credential-encryption` label and an enabled version using
  metadata-only commands;
- neither Prisma migration-status job receives either key;
- production remains blocked until the production-labeled resource exists;
  this change does not create or rotate keys.
- every mutating production path performs the production-key preflight before
  migration-job or application-revision mutation;
- `DEPLOY_DRY_RUN=1` deliberately renders without that metadata read and stays
  non-mutating, while normal identity and remote-source governance still run.

## Post-traffic and evidence behavior

- this correction does not add automatic staging rollback;
- traffic may remain on the new revision when a later generic-health,
  active-digest or evidence-publication gate fails;
- without a valid V2 evidence file and separately reported SHA-256, production
  promotion remains blocked and any rollback requires separate review;
- the evidence writer hashes and validates the temporary file before atomic
  rename, reducing the chance of an unverified final evidence file;
- wrapper tests use fail-closed external-command mocks and reject every unknown
  `gcloud` or `curl` invocation.

## Canonical origin and strict database enforcement

- current remote `main` is accepted only from the canonical backend origin;
- configured and effective Git URLs are both checked to detect rewrites;
- production database selection is exact allowlist membership only;
- semantic tests reject a deceptive `temporary_prod_copy` database name.
