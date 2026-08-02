# Governed production database migration runbook

## Status and authority boundary

This runbook describes a later, separately authorized production database
migration. It does not authorize a backup, secret access, database connection,
migration, Cloud Run job mutation, service deployment, or traffic change by
itself. The governed entry point is `scripts/migrate-prod.sh`; it accepts no
arguments and fails closed when any release, identity, backup, migration, or
evidence check differs from this contract.

The release reviewed for this procedure is:

- source commit and required remote `main`:
  `07eb6b0e215ec0704ea598df3d3dbf65fc3f83df`;
- immutable staging-verified image:
  `asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api@sha256:0f6c73f127e40c854cf03e788263ee85d4e131444bd3fbf17a962b7425999d0e`;
- staging revision:
  `shipmastr-api-staging-sf-07eb6b0-20260802075730-71571`;
- staging evidence:
  `/Users/mac/shipmastr-deployment-evidence/storefront-07eb6b0-20260802T075730Z-66867-staging-evidence-v2.env`;
- staging evidence SHA-256:
  `5e4d8d2f34c385dacc80e5b91b5a6084633fdafc1301c4f3a5b19abaa84fd70d`;
- production service revision before migration:
  `shipmastr-api-00210-xov`, with its existing 100% traffic allocation.

These are inputs to revalidate at execution time, not historical permission to
run. In particular, the approved commit must still be the clean local `HEAD`
and the single commit returned for canonical remote `main`.

The `07eb6b0` image and evidence cannot authorize execution after this
governance procedure is merged: the merge necessarily produces a different
remote-`main` commit, while the guard requires the local commit, remote commit,
staging-evidence commit, and immutable image provenance to agree. Before any
eventual migration run, build a fresh image from the merged governance commit,
validate that exact digest in staging, and create fresh V2 staging evidence.
The values above remain the reviewed starting state only.

## Exact migration and SQL assessment

The only accepted pending set, in order, is:

1. `20260712180000_h2a_platform_webhook_credentials`
2. `20260714100000_h2a_synthetic_tenant_lifecycle`

The first SQL file creates `PlatformCredentialPurpose`, the new
`platform_webhook_credentials` table, its primary key, one unique and three
non-unique indexes, and one foreign key to `platform_connections`. The second
creates `SecurityFixtureKind`, `SecurityFixtureStatus`, the new
`security_fixture_tenants` table, its primary key, three unique and two
non-unique indexes, and three foreign keys to existing `Merchant` and `User`
tables.

Direct review of both SQL files gives this compatibility matrix:

| Operation | Present? | Assessment |
| --- | --- | --- |
| `DROP` | No | No existing schema object is removed. |
| `DELETE` | No | No application row is deleted. |
| `UPDATE` | No | `ON UPDATE CASCADE` is referential behavior, not an SQL data update in the migration. |
| Table or column rename | No | Existing identifiers are unchanged. |
| Existing-column type change | No | No existing column is altered. |
| New `NOT NULL` on an existing table | No | Required columns occur only on the two newly created, initially empty tables. |
| Data backfill | No | The files contain no data-copy or data-mutation statement. |
| Existing-table rewrite | No | No existing table is rewritten. |
| Lock-heavy operation | No sustained rewrite/backfill lock | Enum/table/index creation is additive. Foreign-key creation can take brief catalog and referenced-table locks, so the operation still needs a quiet, monitored window. The new referencing tables are empty, avoiding a large existing-row validation scan. |

## Compatibility with the live production application

The existing production revision remains live throughout the migration. The
two migrations do not remove or alter any column, constraint, enum, index, or
table used by that revision. The webhook-credential table is a new H2A storage
surface; the pre-H2A production behavior does not depend on it. The synthetic
tenant lifecycle is additionally gated in source to `APP_ENV=staging` and its
explicit feature flag, so the production router does not register that
lifecycle surface.

The result is forward-compatible with `shipmastr-api-00210-xov`: existing
queries retain their prior schema, while the new objects remain unused by the
old revision. The residual runtime risk is the brief DDL locking described
above, not an application/schema contract break. This assessment does not
permit a service deployment; service revision and traffic are snapshotted
before and after the migration and must be byte-for-byte equivalent in the
governed comparison.

## Fixed production target and approvals

The script permits only:

- project `shipmastr-core-prod`;
- region `asia-south1`;
- service `shipmastr-api` for read-only before/after snapshots;
- runtime service account
  `shipmastr-runner@shipmastr-core-prod.iam.gserviceaccount.com`;
- Cloud SQL attachment
  `shipmastr-core-prod:asia-south1:shipmastr-postgres`;
- database names `shipmastr`, `shipmastr_prod`, or
  `shipmastr_production`, as returned by `current_database()` inside the job.

It rejects key-file credentials through `GOOGLE_APPLICATION_CREDENTIALS` and
rejects staging, development, local, scratch, test, CI, and deceptive database
names. A normal invocation requires this exact local approval:

```text
SHIPMASTR_PRODUCTION_MIGRATION_APPROVAL=APPROVE SHIPMASTR PRODUCTION DATABASE MIGRATION
```

The approved production deployer identity is
`shipmastr-deployer-prod@shipmastr-core-prod.iam.gserviceaccount.com`. If the
effective identity is the repository owner instead, this separate exact
break-glass acknowledgement is also mandatory:

```text
SHIPMASTR_OWNER_BREAK_GLASS_APPROVAL=APPROVE SHIPMASTR OWNER BREAK GLASS DEPLOYMENT
```

The break-glass phrase does not replace the migration approval, source,
staging, image, database, or backup gates.

## Backup gate

The selected mechanism is a standard Cloud SQL on-demand backup of the fixed
`shipmastr-postgres` instance. It needs no invented export bucket or destination.
The script creates a unique invocation description, resolves exactly one backup
with that description, and then requires all of the following from the exact
backup resource before deploying any migration job:

- numeric, non-empty backup ID;
- instance `shipmastr-postgres`;
- type `ON_DEMAND`;
- status `SUCCESSFUL`;
- exact invocation description;
- start time no earlier than this script invocation;
- end time no earlier than start and no later than local verification.

Backup evidence is written atomically to a new absolute path outside the
repository, set to mode `600`, parsed against an exact fixed key set, and
hashed. The SHA-256 is printed separately. If backup creation, resolution,
verification, evidence creation, mode verification, or hash verification
fails, no migration job is deployed.

## Governed execution sequence

After a separate execution authorization, the operator supplies only explicit
environment inputs; both evidence output paths must be new, absolute, and
outside the repository. The following block shows the reviewed pre-merge
inputs only and must not be executed after this procedure changes `main`; use
the fresh merged commit, image, staging evidence, and evidence hash instead:

```bash
export SHIPMASTR_APPROVED_COMMIT_SHA=07eb6b0e215ec0704ea598df3d3dbf65fc3f83df
export IMAGE_DIGEST=asia-south1-docker.pkg.dev/shipmastr-core-prod/shipmastr/shipmastr-api@sha256:0f6c73f127e40c854cf03e788263ee85d4e131444bd3fbf17a962b7425999d0e
export SHIPMASTR_STAGING_IMAGE_DIGEST="$IMAGE_DIGEST"
export SHIPMASTR_STAGING_EVIDENCE_FILE=/Users/mac/shipmastr-deployment-evidence/storefront-07eb6b0-20260802T075730Z-66867-staging-evidence-v2.env
export SHIPMASTR_STAGING_EVIDENCE_SHA256=5e4d8d2f34c385dacc80e5b91b5a6084633fdafc1301c4f3a5b19abaa84fd70d
export SHIPMASTR_PRODUCTION_BACKUP_EVIDENCE_OUTPUT=/absolute/outside-repository/new-backup-evidence.env
export SHIPMASTR_PRODUCTION_MIGRATION_EVIDENCE_OUTPUT=/absolute/outside-repository/new-migration-evidence.env
export SHIPMASTR_PRODUCTION_MIGRATION_APPROVAL='APPROVE SHIPMASTR PRODUCTION DATABASE MIGRATION'
./scripts/migrate-prod.sh
```

Do not copy the placeholder evidence paths without replacing them with a
reviewed writable directory. Do not set the owner break-glass variable unless
the owner is deliberately acting under the separately approved exception.

The script performs this fixed sequence:

1. Validate local approvals, immutable image, V2 staging evidence and hash,
   clean canonical source, exact remote `main`, and effective identity.
2. Read and normalize the current production revision and full traffic state.
3. Create, resolve, verify, record, reparse, and hash the on-demand backup.
4. Configure the dedicated `shipmastr-prisma-migrate-prod` Cloud Run job for a
   precheck and verify its resulting job metadata.
5. Run both `prisma migrate status` and structured `_prisma_migrations`
   metadata checks. Proceed only when both independently identify exactly the
   two expected pending migrations, with no failed, rolled-back, unknown
   applied, missing, zero-pending, or extra-pending state.
6. Reconfigure the same dedicated job to run exactly
   `npx prisma migrate deploy --schema prisma/schema.prisma` and wait for its
   successful execution.
7. Reconfigure it for postcheck and require Prisma success, zero pending
   migrations, completed/non-rolled-back records for both exact names, no
   failed migration, and the exact expected enums, tables, primary/secondary
   indexes, and foreign keys.
8. Read production service state again and require the same positive revision,
   latest revision fields, tags, and complete traffic allocation.
9. Write, strictly reparse, mode-check, and hash final migration evidence.

Every job phase uses the exact immutable digest, production runtime service
account, production Cloud SQL attachment, one task, parallelism one, zero
retries, and a 600-second timeout. Job metadata must expose exactly two
environment bindings: literal `APP_ENV=production` and the `DATABASE_URL`
Secret Manager reference. No secret payload is read by the local script or
written to arguments, logs, or evidence. No JWT, webhook, SMTP, Cloudflare,
platform-encryption, payment, or unrelated application secret is attached.

The verification queries inspect only `current_database()`, Prisma migration
metadata, and PostgreSQL schema catalogs. They do not inspect business,
customer, tenant, credential, order, or payment rows.

## Success evidence and stopping point

Final evidence is created only after migration execution, post-verification,
and the unchanged-service comparison succeed. It records the exact commit,
image, allowlisted database name, Cloud SQL instance, backup ID/status, pending
set before execution, both verified migration records, pre/post production
revision, `production_traffic_mutation=none`, and creation time. It is atomically
written to a new outside-repository path with mode `600`; its SHA-256 is printed
separately.

Successful migration evidence is the stopping point. The script contains no
Cloud Run service deployment and no traffic-update command. The required later
release sequence remains:

```text
production migration
→ migration verification
→ zero-traffic production candidate
→ candidate smoke tests
→ separately approved production traffic promotion
```

Each arrow is a new authorization boundary. Migration approval does not
authorize a candidate, smoke-test side effects, or traffic promotion.

## Failure handling and rollback limitations

Any mismatch stops the script. Preserve the last valid backup evidence, job
execution identity, sanitized command output, and failure reason for review;
do not manufacture success evidence or proceed manually around a gate.

Schema rollback is not automatic. Prisma migrations are forward migrations,
and neither application rollback nor traffic rollback removes the new schema
objects. Because the live old application remains compatible with the additive
objects, the default response to a post-migration application issue is to keep
the old production revision active and prepare a separately reviewed forward
fix. Restoring the verified Cloud SQL backup or applying a compensating schema
migration is a distinct, destructive recovery operation requiring its own
impact review, authorization, and runbook. Never improvise a reverse `DROP` in
this procedure.
