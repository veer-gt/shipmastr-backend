# PITR read-only verifier

The first isolated PITR drill reached the temporary clone and completed Prisma's migration status check, but its metadata/count wrapper stopped at `sh: 14: Syntax error: "(" unexpected`. The failure came from JavaScript embedded in a shell `node -e` string whose nested single quotes were parsed by `sh` before Node received the program.

The verifier now lives in `scripts/pitr/pitr-readonly-verify.mjs`. Keeping JavaScript in a real module removes shell-quoting risk and makes the query adapter independently testable. `scripts/pitr/run-pitr-readonly-verifier.sh` is intentionally a small decoder/launcher only; it contains no inline JavaScript, `node -e`, or `eval`.

## Safeguards

- The target must match `shipmastr-pitr-drill-*`; production, staging, unrelated, and empty targets fail closed.
- Normal mode requires `PGOPTIONS=-c default_transaction_read_only=on`, then confirms `transaction_read_only=on` inside a single Prisma read-only transaction (`SET TRANSACTION READ ONLY`; mocked adapters use `BEGIN TRANSACTION READ ONLY`).
- Queries are limited to server/database/read-only settings, `information_schema` metadata, `to_regclass` presence checks, and allowlisted `COUNT(*)` aggregates.
- Critical tables are hardcoded: `Merchant`, `User`, `Storefront`, `StorefrontAsset`, `StorefrontProduct`, `Order`, `checkout_quotes`, and `checkout_orders`.
- The output contains only sanitized metadata, aggregate counts, a deterministic schema SHA-256, and `writeQueriesAttempted: false`. It never prints URLs, credentials, row contents, or PII.
- Prisma migration status is supplied by a separate controlled command/helper as `PITR_MIGRATION_STATUS=current` and `PITR_MIGRATION_COUNT=<count>`; this verifier never applies migrations.

## Local dry-run

No database connection is opened by dry-run mode:

```bash
DRY_RUN=1 \
PITR_TARGET_INSTANCE=shipmastr-pitr-drill-local-fixture \
PITR_READ_ONLY=1 \
bash scripts/pitr/run-pitr-readonly-verifier.sh
```

Negative guards can be exercised locally by changing the target to `shipmastr-postgres` or omitting `PITR_READ_ONLY=1`; both fail closed without contacting a database.

## Future isolated-job pattern

For a future temporary Cloud Run Job, inject only the temporary clone's connection and run the wrapper with `PGOPTIONS=-c default_transaction_read_only=on`, the target clone name, and the separately obtained migration status/count. Do not point it at production, apply migrations, or include a production secret in output. Cleanup of the temporary job, clone, and clone-created backup remains mandatory even when verification fails.

This phase performed local tests and dry-runs only. No GCP retry was performed, and no previous-drill evidence was changed.

## Cloud Run bootstrap diagnosis

The failed execution `shipmastr-pitr-drill-verify-20260710t181549z-xs4g5` used image digest `sha256:e1df211864479339e3bc11a811d08553b432903d15f6c7a87ecca7baa9f22132`, one task, zero retries, and a clone-only Cloud SQL attachment. Its execution record reported exit code 1, while the deleted job's historical logs were unavailable. The preserved evidence manifest is `261ad60b2fcca8481dcd50dc47b255167011a2e8be5b44a26c1c14529e8dc806`.

The local reproduction decoded the merged verifier under `/tmp` and showed `ERR_MODULE_NOT_FOUND` for `@prisma/client`; changing `process.cwd()` did not change that result because ESM package resolution starts from the verifier module location. Decoding the wrapper and verifier together reproduced the same sanitized `VERIFICATION_FAILED` exit-1 bootstrap result. This confirms the module-resolution failure mode locally; the original remote execution's unavailable logs prevent stronger attribution of its first remote process layer.

The minimal fix is to resolve Prisma through a validated application root (`PITR_APP_ROOT`, defaulting to `process.cwd()`) using `createRequire()` rooted at that application's `package.json`. Missing roots or clients now fail with sanitized `PRISMA_CLIENT_RESOLUTION_FAILED`; connection bootstrap errors use sanitized `DATABASE_CONNECTION_FAILED`. During the local database replay, the original `to_regclass()` result also exposed PostgreSQL's `regclass` type to Prisma and failed deserialization; presence checks now cast it to `text`. The wrapper now uses `pipefail`, verifies the merged verifier exists and decodes non-empty content, and emits sanitized `WRAPPER_BOOTSTRAP_FAILED` output for missing/corrupt payloads.

Regression coverage includes `/tmp` execution, application-root resolution, path-with-spaces handling, GNU/macOS base64 branches, missing verifier files, fake database failures, read-only guards, repeated fingerprint stability, and temporary-file cleanup. An exact Artifact Registry image/container replay and a PostgreSQL 16 container replay were not run in environments without an installed Docker/Podman-compatible runtime; no runtime was installed and no GCP retry was performed.
