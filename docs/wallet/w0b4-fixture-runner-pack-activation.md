# W0B-4 Fixture Runner And Format-Pack Activation

W0B-4 completes the operational loop for courier MIS format packs. The parser engine stays code, while courier-specific format behavior stays data in `format_pack_versions.definition`.

This phase does not post staging rows into the wallet ledger, create recovery reports, expose public seller APIs, deploy Cloud Run, touch n8n, move custody/payment money, or call providers.

## What W0B-4 Implements

- `FormatPackFixtureService`
  - attach fixture metadata to a draft or rejected format-pack version
  - validate the fixture `expectedSummary` contract
  - list fixtures deterministically
  - reject fixture deletion once a version is active or otherwise locked
- `FixtureContentProvider`
  - narrow interface for reading fixture content by storage path
  - in-memory provider for tests
  - no real GCS/network calls in W0B-4 tests
- `FormatPackFixtureRunner`
  - reads each fixture CSV
  - runs it through the W0B-3 dry-run parser
  - compares actual parser summaries to expected summaries
  - records `format_pack_test_runs` as `passed` or `failed`
  - never persists staging rows and never creates import files
- `FormatPackActivationService`
  - validates draft versions after a latest successful fixture run
  - promotes validated versions to canary
  - activates canary versions through maker-checker approval
  - retires the previous active version and activates the target in one transaction
  - rolls back by pointer switch without mutating definitions
  - detects multiple active versions as a consistency error
- DB hardening
  - raw SQL partial unique index on `format_pack_versions(pack_id)` where `status = 'active'`

## Why Fixtures Are The Quality Gate

Courier CSV drift must be handled as data:

1. Ops forks or creates a new `format_pack_version`.
2. Ops adds the failing courier file as a fixture.
3. Ops updates header aliases, date formats, or charge-code mappings in the definition.
4. The fixture runner parses all fixtures through the existing parser engine.
5. A passing run allows draft -> validated.
6. Validated can be marked canary.
7. A different approver activates canary through maker-checker.
8. The old active version retires automatically.

No Cloud Run deploy is needed for ordinary header, date, or charge-code drift.

## Expected Summary Contract

Each fixture stores an `expectedSummary` JSON object:

```json
{
  "row_count": 1,
  "parsed_count": 1,
  "exception_count": 0,
  "stated_total_minor": "11800",
  "parsed_total_minor": "11800",
  "event_class_counts": {
    "freight_charged": 1,
    "rto_freight_charged": 0
  }
}
```

Missing event classes compare as `0`. Extra fields are not part of the W0B-4 comparison contract.

## Test Run Result Contract

Each `format_pack_test_runs.result` includes:

- pack version id
- runner version
- pass/fail status
- per-fixture status
- expected summary
- actual summary
- summary diffs
- row errors
- unknown headers
- unknown charge codes
- stated and parsed totals
- fixture timing

## Status Transition Table

Allowed:

- `draft -> validated`
- `validated -> canary`
- `canary -> active`
- `active -> retired`
- `retired -> active` through rollback only
- `draft -> rejected` optional future path
- `validated -> rejected` optional future path
- `canary -> rejected` optional future path

Forbidden:

- `draft -> active`
- `validated -> active`
- failed latest fixture run -> `validated`
- same maker/checker activation
- active definition mutation
- active fixture deletion
- multiple active versions for one pack

## Maker-Checker Rule

The user approving activation or rollback must differ from `format_pack_versions.created_by`. The service rejects same-actor activation with `FORMAT_PACK_MAKER_CHECKER_REQUIRED`.

## Single-Active Invariant

The activation transaction retires all active versions for the pack and activates the target version in the same transaction. After the switch, the service verifies exactly one active version exists.

The migration `20260704140000_w0b4_format_pack_activation` adds:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "format_pack_versions_one_active_per_pack_idx"
  ON "format_pack_versions"("pack_id")
  WHERE "status" = 'active';
```

## Rollback Flow

Rollback is a pointer switch:

1. Choose a prior `retired`, `validated`, or `canary` version.
2. Apply maker-checker approval.
3. Retire the current active version.
4. Activate the target version.
5. Keep definition JSON and definition hash unchanged.
6. Keep all prior fixture runs.

## No-Ledger Boundary

W0B-4 never creates import files, staging rows, wallet entries, postings, holds, account balances, outbox rows, or recovery reports. The fixture runner calls the W0B-3 parser with staging persistence disabled.

## What Remains For W0C

- staging rows -> shadow ledger entries
- reversal/correction posting
- recovery report generation
- n8n transport integration

## Validation Commands

Run from `backend`:

```sh
npx prisma validate
npx prisma generate
npm run build
npm test
```

Run from repo root:

```sh
git diff --check
grep -R "eval(\\|new Function\\|vm\\.\\|child_process\\|require(\\|import(" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
grep -R "parseFloat\\|Math.round\\|Number(" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
grep -R "journal_entries\\|journal_postings\\|LedgerService\\|postEntry\\|wallet_events_outbox\\|account_balances\\|wallet_holds" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
```

## Rollback Notes

Before deployment, rollback is source-only: remove the W0B-4 service files, tests, migration, and this document. After a DB migration is applied in a future approved rollout, the partial unique index can be dropped if the phase is rolled back.

No custody, payment, provider, n8n, Cloud Run, GCP secret, or live database action is part of this implementation pass.
