# Local Apple Container PostgreSQL and H1 scratch lane

Date: 2026-07-12

This is a local-only recovery and verification record. It does not authorize
Cloud SQL, Cloud Run, GCS, IAM, DNS, credential, deployment, or production-data
changes.

## Recovered service

The initial `nc` and `pg_isready` checks against `127.0.0.1:5433` failed because
the Apple Container service was unavailable. After inspecting the installed
`container` CLI and the relevant subcommand help, the service was started and
the existing `shipmastr-postgres` container was started in place. This used
recovery rung A; no container or volume was recreated.

| Property | Observed value |
| --- | --- |
| Container | `shipmastr-postgres` |
| Image | `docker.io/library/postgres:16` (PostgreSQL 16; runtime reported 16.14) |
| Binding | `127.0.0.1:5433 -> 5432/tcp` |
| Persistent volume | `backend_shipmastr_pg` mounted at `/var/lib/postgresql/data` |
| Readiness | `127.0.0.1:5433 - accepting connections` |
| Recovery log | Existing data directory; interrupted-startup WAL recovery; ready for connections |

The container inventory was compared before and after startup: the same image,
binding, mount destination and volume remained attached. The inspected
container configuration currently names its default database `shipmastr`; the
historical `shipmastr_dev` label was not assumed, inspected for rows, or
mutated. The separate native PostgreSQL process on port 5432 was not touched.

Reproduction commands (Apple Container only):

```bash
container --help
container list --help
container inspect --help
container logs --help
container start --help
container exec --help
npm run db:status
npm run db:up
```

`db:up` starts only the existing PostgreSQL container when stopped, validates
the pinned image/volume/port, waits for bounded readiness, and never recreates
or deletes a container. `db:status` is read-only and reports state, image,
volume, binding and external `pg_isready` status. Neither command prints
credentials.

## Scratch lifecycle

The backend package provides:

```bash
npm run db:scratch:create
npm run db:scratch:drop -- shipmastr_scratch_example
npm run db:scratch:test
```

The create and test scripts require the local `127.0.0.1:5433` target and reject
remote hosts, Cloud SQL socket parameters, protected names and SQL-injection
shapes. The drop script accepts only
`^shipmastr_scratch_[a-zA-Z0-9_]+$`, explicitly refuses `postgres`,
`shipmastr_dev`, `shipmastr`, `shipmastr_prod`, `production` and `staging`,
checks the live local server, terminates connections only for that validated
scratch name, and treats a repeated drop as an explicit already-absent result.

Every DB-backed test asserts `SELECT current_database()` and aborts unless the
live name matches the scratch pattern. The wrapper creates one generated name,
runs validation, the Prisma migration deployment and status check, verifies
the H1 table/indexes, builds the backend, runs the guarded PostgreSQL tests,
and drops the scratch database in a `finally` path. If teardown fails it emits
`SCRATCH_DB_REMAINS=<name>` and exits non-zero.

The completed runs were:

* `shipmastr_scratch_f9943b4_20260712T073254Z`: migration succeeded; the first
  DB race test correctly exposed the old implementation's lost-increment race;
  the wrapper still removed the scratch database.
* `shipmastr_scratch_f9943b4_20260712T073839Z`: all 100 migrations applied,
  Prisma reported the schema up to date, `auth_abuse_states` columns and four
  required indexes were verified, two DB-backed H1 tests passed, and teardown
  succeeded.
* `shipmastr_scratch_lifecycle_20260712`: create, drop and repeated-drop
  checks passed; it was removed.

No non-scratch database was migrated, reset, dropped, or queried for application
rows.

## AuthAbuseState concurrency correction

The first scratch run found that concurrent first writes could all take the
`upsert` update branch that reset `attempts` to one. The service now uses a
parameterized PostgreSQL `INSERT ... ON CONFLICT` update that increments the
active window atomically and resets only an expired window. Lock acquisition is
also conditional on an unheld/expired `lock_until`, so one concurrent request
owns the notification transition. The regression lane uses 16 parallel
`recordAuthFailure` calls and verifies 16 account/network attempts, one lockout
notification transition, bounded delay, reset, expiry reuse and transaction
rollback.

## Synthetic webhook fixtures

`scripts/security-fixtures/platform-webhooks.mjs` produces deterministic,
PII-free Shopify, WooCommerce and Magento payloads with provider-specific
headers. HMAC-SHA256 signatures are computed at test time from
`SHOPIFY_WEBHOOK_SECRET`, `WOOCOMMERCE_WEBHOOK_SECRET` and
`MAGENTO_WEBHOOK_SECRET`, or from an in-memory random test value when no test
environment value is supplied. Values are never written to source or logs.
The validation tests cover valid signatures, invalid/malformed/missing
signatures, raw-body mutation, unsupported events, oversized payloads and
missing secret mapping (`NOT_CONFIGURED`). `fixture-guard.mjs` scans only the
fixture-output directory and reports file/line/rule identifiers without
printing matched values.

The current platform connection model does not provide a tenant-specific
webhook-signing-secret lookup. Production provider mapping therefore remains a
fail-closed deployment blocker; no global fallback or unsigned acceptance was
added.

## Validation record

* `npm test`: 1,939 tests across 223 suites; 1,938 passed, 0 failed, and one
  expected opt-in GCS test skipped (`Tier A storefront GCS signed upload
  proof`).
* `npm run build`, `npx tsc --noEmit` and `npx prisma validate`: passed.
* `npm run security:fixture-tests`: 2 passed; `npm run security:fixture-guard`:
  clean; `node --test scripts/db-scratch-guards.test.mjs`: 3 passed.
* Seller-panel lint passed. Seller-panel production build passed with its
  output directed to `/tmp/shipmastr-seller-panel-build`; the preserved root
  frontend artifacts were not regenerated.
* Storefront renderer tests: 16 passed.
* The asset-origin test command was not runnable because its existing workspace
  lacks the installed `@google-cloud/storage` module. Real GCS integration
  tests remain **NOT RUN — dedicated non-production GCS security test bucket
  not configured**; no dependency was installed solely to force that lane.

## Deferred lane

Real GCS integration tests: **NOT RUN — dedicated non-production GCS security
test bucket not configured**. No dependency was installed solely to force that
lane. No cloud or production mutation was performed.
