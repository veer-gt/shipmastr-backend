# PGO-1 Shadow Verification

PGO-1 remains a local, Mock-only shadow orchestration slice. Passing these checks does not authorize provider activation, deployment, production migration, production credentials, production traffic, refund execution, wallet movement, settlement, payout, custody movement, or COD mutation.

## Prerequisites

- Use only the disposable PostgreSQL scratch database from `/Users/mac/.config/shipmastr/pgo1-a965f431-test.env`.
- Before any PostgreSQL command, verify the env file is mode `600`, source it without printing values, and reject any URL that is not `localhost` or `127.0.0.1`, port `5433`, and database `shipmastr_scratch_pgo1_a965f431`.
- The scratch database name must also match `^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$`.
- Do not use live credentials, live provider accounts, production database URLs, or provider network calls.

Guard command:

```bash
test "$(stat -f %Lp /Users/mac/.config/shipmastr/pgo1-a965f431-test.env)" = "600" &&
set -a &&
. /Users/mac/.config/shipmastr/pgo1-a965f431-test.env &&
set +a &&
PGO1_TEST_DATABASE_URL="$PGO1_TEST_DATABASE_URL" PGO1_SCRATCH_DB_NAME="$PGO1_SCRATCH_DB_NAME" node -e 'const u=new URL(process.env.PGO1_TEST_DATABASE_URL??""); const d=decodeURIComponent(u.pathname.slice(1)); if(!["127.0.0.1","localhost"].includes(u.hostname.toLowerCase())||u.port!=="5433"||d!==process.env.PGO1_SCRATCH_DB_NAME||d!=="shipmastr_scratch_pgo1_a965f431"||!/^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$/.test(d)) process.exit(1)'
```

## Commands

Run the four focused PGO-1 suites:

```bash
npm run test:pgo1:pure
npm run test:pgo1:contracts
DATABASE_URL="$PGO1_TEST_DATABASE_URL" npm run test:pgo1:postgres
npm run test:pgo1
```

Run schema checks and the specific acceptance flow:

```bash
DATABASE_URL="$PGO1_TEST_DATABASE_URL" npx prisma validate
npm run build
DATABASE_URL="$PGO1_TEST_DATABASE_URL" RUN_PGO1_POSTGRES_TESTS=1 node --test --test-concurrency=1 dist/modules/paymentOrchestration/__tests__/pgo1.acceptance.postgres.test.js
```

Confirm the migration applies only to a newly created, independently guarded disposable database distinct from the acceptance test database. The migration scratch name must not equal the acceptance test database:

```bash
test "$(stat -f %Lp /Users/mac/.config/shipmastr/pgo1-a965f431-test.env)" = "600" &&
set -a &&
. /Users/mac/.config/shipmastr/pgo1-a965f431-test.env &&
set +a &&
PGO1_TEST_DATABASE_URL="$PGO1_TEST_DATABASE_URL" PGO1_SCRATCH_DB_NAME="$PGO1_SCRATCH_DB_NAME" node -e 'const u=new URL(process.env.PGO1_TEST_DATABASE_URL??""); const d=decodeURIComponent(u.pathname.slice(1)); if(!["127.0.0.1","localhost"].includes(u.hostname.toLowerCase())||u.port!=="5433"||d!==process.env.PGO1_SCRATCH_DB_NAME||d!=="shipmastr_scratch_pgo1_a965f431"||!/^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$/.test(d)) process.exit(1)' &&
PGO1_MIGRATION_SCRATCH_DB_NAME=shipmastr_scratch_pgo1_a965f431_migration &&
PGO1_TEST_DATABASE_URL="$PGO1_TEST_DATABASE_URL" PGO1_SCRATCH_DB_NAME="$PGO1_SCRATCH_DB_NAME" PGO1_MIGRATION_SCRATCH_DB_NAME="$PGO1_MIGRATION_SCRATCH_DB_NAME" node -e 'const u=new URL(process.env.PGO1_TEST_DATABASE_URL??""); const testDb=decodeURIComponent(u.pathname.slice(1)); const migrationDb=process.env.PGO1_MIGRATION_SCRATCH_DB_NAME??""; if(migrationDb===testDb||migrationDb!=="shipmastr_scratch_pgo1_a965f431_migration"||!/^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$/.test(migrationDb)) process.exit(1)' &&
DATABASE_URL="$PGO1_TEST_DATABASE_URL" SCRATCH_DB_NAME="$PGO1_MIGRATION_SCRATCH_DB_NAME" npm run db:scratch:create &&
PGO1_MIGRATION_DATABASE_URL="$(PGO1_TEST_DATABASE_URL="$PGO1_TEST_DATABASE_URL" PGO1_MIGRATION_SCRATCH_DB_NAME="$PGO1_MIGRATION_SCRATCH_DB_NAME" node -e 'const u=new URL(process.env.PGO1_TEST_DATABASE_URL??""); u.pathname=`/${process.env.PGO1_MIGRATION_SCRATCH_DB_NAME}`; process.stdout.write(u.toString())')" &&
DATABASE_URL="$PGO1_MIGRATION_DATABASE_URL" PGO1_MIGRATION_SCRATCH_DB_NAME="$PGO1_MIGRATION_SCRATCH_DB_NAME" node -e 'const u=new URL(process.env.DATABASE_URL??""); const d=decodeURIComponent(u.pathname.slice(1)); if(!["127.0.0.1","localhost"].includes(u.hostname.toLowerCase())||u.port!=="5433"||d!==process.env.PGO1_MIGRATION_SCRATCH_DB_NAME||d==="shipmastr_scratch_pgo1_a965f431") process.exit(1)' &&
DATABASE_URL="$PGO1_MIGRATION_DATABASE_URL" npx prisma migrate deploy &&
npm run db:scratch:drop -- "$PGO1_MIGRATION_SCRATCH_DB_NAME"
```

If migration application fails before the final drop command, dispose only that exact migration scratch database after re-running the same name guard:

```bash
test "$(stat -f %Lp /Users/mac/.config/shipmastr/pgo1-a965f431-test.env)" = "600" &&
set -a &&
. /Users/mac/.config/shipmastr/pgo1-a965f431-test.env &&
set +a &&
PGO1_MIGRATION_SCRATCH_DB_NAME=shipmastr_scratch_pgo1_a965f431_migration &&
PGO1_TEST_DATABASE_URL="$PGO1_TEST_DATABASE_URL" PGO1_SCRATCH_DB_NAME="$PGO1_SCRATCH_DB_NAME" PGO1_MIGRATION_SCRATCH_DB_NAME="$PGO1_MIGRATION_SCRATCH_DB_NAME" node -e 'const u=new URL(process.env.PGO1_TEST_DATABASE_URL??""); const testDb=decodeURIComponent(u.pathname.slice(1)); const migrationDb=process.env.PGO1_MIGRATION_SCRATCH_DB_NAME??""; if(migrationDb===testDb||migrationDb!=="shipmastr_scratch_pgo1_a965f431_migration"||!/^shipmastr_scratch_pgo1_[a-zA-Z0-9_]+$/.test(migrationDb)) process.exit(1)' &&
npm run db:scratch:drop -- "$PGO1_MIGRATION_SCRATCH_DB_NAME"
```

Rollback is not tested against a shared database. Rollback means guarded disposal of the separately created migration scratch database only; never run migration rollback or destructive migration commands against a production, default, shared, or acceptance-test URL.

## Mock-Only Evidence

- `mockAdapter` is the only exported executor. The public module exports exactly `MANUAL_EVIDENCE_EXCEPTION_GATE`, `createAttempt`, `createCheckoutObligations`, `ingestRawObservation`, `mockAdapter`, `reconcileAttempt`, `reviewService`, `toBuyerPaymentStatus`, `toOperatorPaymentReadModel`, `toRefundDueOperatorReadModel`, and `validateShadowFact`.
- Cashfree and Paytm parsers remain internal contract-fixture modules. They are not exported from `src/modules/paymentOrchestration/index.ts`.
- `ingestRawObservation` accepts executable ingestion only when the parser is `MOCK`, mode is `MOCK_EXECUTABLE`, and retention is `MOCK_SYNTHETIC`.
- Cashfree and Paytm tests use synthetic fixture files under `src/modules/paymentOrchestration/__fixtures__/` and must not perform network traffic.

No real-provider or network execution path scan:

```bash
if grep -RInE 'fetch\(|axios|https?\.request|cashfree.*(create|charge|capture|refund|cancel)|paytm.*(create|charge|capture|refund|cancel)' src/modules/paymentOrchestration; then
  exit 1
fi
```

Deprecated alias scan:

```bash
if grep -RInF "$(printf '\103\061\070')" src/modules/paymentOrchestration prisma/migrations/20260827120000_pgo_1_payment_orchestration docs/pgo-1-shadow-verification.md; then
  exit 1
fi
```

PII persistence/logging scan:

```bash
find src/modules/paymentOrchestration -type f ! -path '*/__fixtures__/*' ! -name '*.test.ts' -print0 |
  xargs -0 grep -nE 'rawBody|buyerPhone|buyerEmail|cardNumber|bankAccount'
```

The only acceptable output is deliberate raw-byte ingestion parameters or rejection/allowlist checks. There must be no payload or buyer PII persistence/logging.

## Zero-Mutation Boundary

The acceptance flow injects a recording `ShadowMutationBoundary` into the production reduction persistence path. The reducer path calls the boundary's no-mutation-authority check, and the recorder asserts journal, wallet, settlement, payout, refund, and custody call counts remain zero. The flow also snapshots the COD delivery-balance obligation and all related COD shadow tables before the online Mock flow, then asserts the COD delivery-balance obligation is byte-for-byte unchanged after timeout, escalation, success, contradictory failure, surplus success, refund-due detection, shadow validation, and queue-stub consumption.

The Payments Operations boundary is a deterministic local queue stub. It consumes `PaymentNormalizedFactOutbox` rows in `createdAt, id` order and records no live queue delivery. Passing this stub does not authorize live queue wiring.

## Non-Authority Statement

These commands prove only that the local PGO-1 shadow slice builds, validates, and passes Mock-only and fixture-only tests against a guarded disposable PostgreSQL database. They do not authorize activation, deploy, merge, push, production migration, live provider credentials, provider traffic, money movement, refund execution, COD mutation, or production queue delivery.
