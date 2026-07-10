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
