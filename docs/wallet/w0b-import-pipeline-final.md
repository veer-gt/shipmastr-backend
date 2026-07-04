# W0B Import Pipeline Final Consolidation

W0B establishes the import and format-pack pipeline that prepares courier MIS data for later wallet-ledger posting. It stops at validated staging and format-pack activation. It does not post to the wallet ledger, create recovery reports, expose public wallet APIs, move money, call providers, or touch n8n.

## Completed Components

W0B-1 schema:

- `import_files`
- `staging_rows`
- `format_packs`
- `format_pack_versions`
- `format_pack_fixtures`
- `format_pack_test_runs`

W0B-2 definition validation:

- `FormatPackService`
- `FormatPackDefinitionValidator`
- parser primitive registry
- canonical definition hashing
- draft version creation

W0B-3 parser and staging:

- `ImportFileService`
- `FormatPackParserService`
- `StagingRowService`
- `ShipmentReferenceResolver`
- BigInt-safe paise parsing
- CSV parsing
- row and file exceptions
- staging persistence
- no-ledger boundary

W0B-4 fixture runner and activation:

- `FormatPackFixtureService`
- `FormatPackFixtureRunner`
- `FormatPackActivationService`
- `FixtureContentProvider`
- fixture test runs
- draft -> validated
- validated -> canary
- canary -> active
- active -> retired
- rollback by pointer switch
- maker-checker activation
- partial unique active index

## Status Vocabulary

`import_files` statuses:

- `landed`
- `parsed`
- `validated`
- `staged`
- `exception`

`staging_rows` statuses:

- `staged`
- `parsed`
- `resolved`
- `validated`
- `exception`
- `ready_for_posting`

`format_pack_versions` statuses:

- `draft`
- `validated`
- `canary`
- `active`
- `retired`
- `rejected`

`format_pack_test_runs` statuses:

- `passed`
- `failed`

## Lifecycle

The supported format-pack lifecycle is:

```text
draft -> fixture run passed -> validated -> canary -> active -> retired
```

Rollback is pointer-based:

```text
retired -> active
```

The normal activation path is:

1. Create or fork a draft `format_pack_version`.
2. Attach one or more fixtures.
3. Run fixtures through the dry-run parser.
4. Latest fixture run must be `passed`.
5. Promote draft to `validated`.
6. Promote validated to `canary`.
7. Activate canary with maker-checker approval.
8. Retire any previous active version for the same pack in the same transaction.
9. Verify exactly one active version remains.

Forbidden transitions:

- `draft -> active`
- `validated -> active`
- failed latest fixture run -> `validated`
- missing fixtures -> `validated`
- same maker and checker activation
- active fixture deletion
- active definition mutation
- multiple active versions for one pack

## Courier Format Drift Without Deploy

Courier CSV changes are handled as data:

1. Add the changed courier sample as a fixture.
2. Fork a new draft format-pack version.
3. Adjust aliases, date formats, charge-code mappings, or row filters in the definition.
4. Run the full fixture suite.
5. Promote and activate only after fixtures pass and a separate approver signs off.

Ordinary header, alias, date-format, and charge-code drift should not require a Cloud Run deploy. The parser engine remains code; courier-specific shape remains data in `format_pack_versions.definition`.

## Parser Engine Code Vs Format-Pack Data

Parser engine code owns:

- CSV tokenization
- primitive execution
- BigInt-safe money parsing
- date parsing
- duplicate-key checks
- total tie checks
- staging row persistence
- exception emission

Format-pack data owns:

- expected header fingerprint
- header aliases
- column-to-field mappings
- transform primitive names and primitive configs
- charge-code mapping
- duplicate-key fields
- total-rule field
- row-filter declarations
- metadata

Definitions are JSON data only. They cannot carry executable code, SQL fragments, arbitrary regex config, dynamic imports, or runtime scripts.

## Raw Staging Quarantine Model

`ImportFileService` creates landed file metadata with immutable source identifiers and hashes.

`FormatPackParserService` can run in two modes:

- dry run: parse and summarize without import-file or staging-row persistence
- staging run: parse and persist rows under an existing `import_file`

`StagingRowService` stores raw row data, parsed JSON, exception state, event class, and resolution fields. Rows remain quarantined until a later W0C posting step converts validated rows into shadow ledger entries.

## I17 No-Ledger Boundary

W0B does not create or update:

- wallet journal entries
- wallet postings
- wallet holds
- account balances
- wallet outbox events
- custody/payment/provider state
- recovery reports

Fixture runs always call the parser with `persistStagingRows: false`. Activation only updates format-pack version pointers and test-run metadata.

## Exception Code Table

Parser and staging exceptions:

| Code | Meaning |
| --- | --- |
| `HEADER_FINGERPRINT_MISMATCH` | Required header or alias was not found. |
| `AMBIGUOUS_HEADER` | Multiple input headers mapped to the same canonical field. |
| `UNKNOWN_HEADER` | A configured source column could not be resolved. |
| `UNKNOWN_CHARGE_CODE` | Charge code is not in the format-pack mapping. |
| `BAD_MONEY` | Money value is malformed, non-finite, or has unsupported decimals. |
| `BAD_DATE` | Date did not match configured formats or was invalid. |
| `BAD_WEIGHT` | Weight value was malformed. |
| `REQUIRED_FIELD_MISSING` | Required field was empty. |
| `INVALID_ENUM` | Enum transform saw a value outside the allowed set. |
| `UNSUPPORTED_PRIMITIVE` | Definition referenced an unknown primitive. |
| `AMBIGUOUS_DUPLICATE` | Duplicate-key rule found an existing row. |
| `TOTAL_MISMATCH` | Parsed signed total did not match stated total. |
| `UNRESOLVED_SHIPMENT` | Shipment reference could not be resolved. |
| `ZERO_AMOUNT` | Financial row parsed to zero amount and was not skipped. |
| `IMPORT_FILE_ID_REQUIRED` | Staging persistence was requested without an import file id. |

Fixture and activation exceptions:

| Code | Meaning |
| --- | --- |
| `FORMAT_PACK_VERSION_NOT_FOUND` | Requested format-pack version does not exist. |
| `FORMAT_PACK_FIXTURES_REQUIRED` | Validation or runner needs at least one fixture. |
| `FORMAT_PACK_FIXTURE_RUN_NOT_PASSED` | Latest fixture run is missing or failed. |
| `FORMAT_PACK_VALIDATE_STATUS_INVALID` | Only draft versions can be validated. |
| `FORMAT_PACK_CANARY_STATUS_INVALID` | Only validated versions can become canary. |
| `FORMAT_PACK_ACTIVATE_STATUS_INVALID` | Only canary versions can activate. |
| `FORMAT_PACK_MAKER_CHECKER_REQUIRED` | Approver must differ from creator. |
| `FORMAT_PACK_ACTIVE_CONSISTENCY_ERROR` | More than one active version was found. |
| `FORMAT_PACK_FIXTURE_DELETE_LOCKED` | Fixture belongs to a locked version. |
| `EXPECTED_SUMMARY_ROW_COUNT_INVALID` | Fixture expected row count is invalid. |
| `EXPECTED_SUMMARY_PARSED_COUNT_INVALID` | Fixture expected parsed count is invalid. |
| `EXPECTED_SUMMARY_EXCEPTION_COUNT_INVALID` | Fixture expected exception count is invalid. |
| `EXPECTED_SUMMARY_PARSED_TOTAL_INVALID` | Fixture expected parsed total is invalid. |
| `EXPECTED_SUMMARY_EVENT_COUNTS_INVALID` | Fixture expected event count map is invalid. |

## Maker-Checker Rules

Activation and rollback require an approver different from `format_pack_versions.created_by`. This prevents a single actor from creating and activating the same version.

Activation and rollback are transaction-scoped pointer switches. The prior active version is retired and the target version is activated in the same transaction. Definition JSON and `definition_hash` are not mutated by activation or rollback.

## Single-Active Invariant

The DB enforces one active version per pack with a partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "format_pack_versions_one_active_per_pack_idx"
  ON "format_pack_versions"("pack_id")
  WHERE "status" = 'active';
```

The activation service also checks active rows after pointer switches, and `findActiveVersion` raises a consistency error if multiple active rows are detected.

## W0C Scope

W0C should implement:

- validated staging rows -> shadow ledger entries
- deterministic `entry_ref` generation
- idempotent reversal and correction posting
- recovery report generation
- later n8n transport integration after the ledger posting boundary is explicit

## Out Of Scope

W0B does not include:

- custody
- public wallet APIs
- public seller-facing import APIs
- payment movement
- provider calls
- payout or PA split settlement
- wallet lending
- recovery reports
- n8n workflows
- production or staging deploys
- live DB mutation

## Validation

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
