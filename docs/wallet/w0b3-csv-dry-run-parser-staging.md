# W0B-3 CSV Dry-Run Parser And Staging Rows

W0B-3 adds the internal parser execution path for courier MIS-style CSV files. It lands import file metadata, runs a dry-run parser against a selected format pack version, resolves shipment references through an injected resolver, and optionally writes `staging_rows`.

It does not post to the wallet ledger, create recovery reports, activate format packs, or expose a public seller API.

## What W0B-3 Implements

- `ImportFileService`
  - idempotent `import_files` landing by `file_hash`
  - status helpers for `parsed`, `validated`, `staged`, and `exception`
- `FormatPackParserService`
  - CSV parsing with quoted fields, commas, escaped quotes, CRLF/LF support, BOM stripping, trailing newline handling, and blank-line skips
  - deterministic case-insensitive header fingerprint and alias resolution
  - duplicate canonical header detection with `AMBIGUOUS_HEADER`
  - row filters for blank rows, repeated headers, and subtotal rows
  - whitelisted primitive transforms
  - charge-code event classification
  - duplicate-key detection
  - BigInt-safe total tie validation
  - dry-run summary output
- `StagingRowService`
  - transactional replacement of staging rows for one import file
  - raw row quarantine
  - parsed JSON with BigInt values serialized as strings
  - row/file exception persistence
- `ShipmentReferenceResolver`
  - interface-only boundary for mapping hostile external refs to internal shipment IDs

## Dry-Run Parser Flow

1. Load the requested `format_pack_versions` row.
2. Re-run `FormatPackDefinitionValidator` before execution.
3. Parse CSV content.
4. Match headers through `headers.fingerprint` and `headers.aliases`.
5. Apply safe row filters.
6. Extract configured columns.
7. Execute only whitelisted parser primitives.
8. Classify charge codes to allowed event classes.
9. Resolve `external_awb` through the injected shipment resolver when provided.
10. Detect row exceptions and duplicate keys.
11. Mark non-skipped financial rows with zero `amount_minor` as `ZERO_AMOUNT`.
12. Sum non-exception `amount_minor` values with BigInt.
13. Compare against `statedTotalMinor` when provided.
14. Return dry-run results.
15. Optionally replace `staging_rows` and update `import_files.status`.

## Import File Landing And Idempotency

`ImportFileService.landFile()` creates an `import_files` row with status `landed`. If the same `file_hash` is already present, the existing row is returned and no duplicate is created.

This service performs no network, GCS, n8n, provider, payment, or ledger work.

## Staging Row Persistence

When `persistStagingRows` is true and `fileId` is provided:

- existing rows for the file are deleted
- new rows are inserted in one transaction
- raw row JSON is preserved
- parsed values are stored with BigInt fields as strings
- `event_class`, `shipment_id`, status, and exception metadata are stored
- `posted_entry_ref` is always null in W0B-3
- `import_files.status` becomes `staged` or `exception`
- the row replacement and import file status update happen in the same transaction

Successful parse, resolver, and total checks return `fileStatus=validated`; persisted files become `staged`.
Any row exception or total mismatch returns and persists `exception`.
Skipped rows alone do not make the file exceptional.

## Row And File Exceptions

Current row exception codes include:

- `UNKNOWN_HEADER`
- `AMBIGUOUS_HEADER`
- `UNKNOWN_CHARGE_CODE`
- `BAD_MONEY`
- `BAD_DATE`
- `BAD_WEIGHT`
- `REQUIRED_FIELD_MISSING`
- `UNRESOLVED_SHIPMENT`
- `AMBIGUOUS_DUPLICATE`
- `ZERO_AMOUNT`
- `ROW_PARSE_ERROR`

Current file exception codes include:

- `HEADER_FINGERPRINT_MISMATCH`
- `TOTAL_MISMATCH`

The stable W0B-3 exception vocabulary is:

- `UNKNOWN_HEADER`
- `HEADER_FINGERPRINT_MISMATCH`
- `AMBIGUOUS_HEADER`
- `UNKNOWN_CHARGE_CODE`
- `BAD_MONEY`
- `BAD_DATE`
- `BAD_WEIGHT`
- `REQUIRED_FIELD_MISSING`
- `AMBIGUOUS_DUPLICATE`
- `TOTAL_MISMATCH`
- `UNRESOLVED_SHIPMENT`
- `UNSUPPORTED_PRIMITIVE`
- `ZERO_AMOUNT`

## BigInt And Minor Units

Money parsing uses integer minor units only. `parse_paise` accepts values such as `118`, `118.00`, `₹118.00`, `Rs. 118.00`, `INR 118.00`, `1,499.50`, negative values, and parenthesized negatives. It rejects more than two decimal places, empty values, non-numeric values, `NaN`, and `Infinity`. JSON-like output serializes BigInt values as strings.

The import pipeline does not use floating-point money conversion.
Explicit signs from the source file are preserved; W0B-3 does not infer or double-negate event amounts. Positive and negative rows are tied against stated totals as signed BigInt minor units.

## Duplicate Detection

Duplicate detection is based on normalized parsed values, not raw row text. Skipped rows and rows already in exception state are excluded. The first valid row wins; later duplicate rows are marked `AMBIGUOUS_DUPLICATE`.

## Raw Rows Are Quarantine

Raw staging rows may contain hostile courier refs or external labels. That is expected for quarantine and operator inspection. Parsed rows may retain external refs required for resolution, but W0B-3 never writes these values into wallet ledger tables.

## I17 Boundary

AWB-like external refs can exist in `raw` and parsed staging rows only. W0B-3 does not create ledger entries, ledger postings, balance rows, hold rows, outbox rows, or wallet recovery reports.

## Courier Drift Without Deploy

Courier header, date, or charge-code drift is fixed by creating a new `format_pack_versions.definition`:

- add a new header alias
- add a declared date format
- add a charge-code mapping

The parser engine remains code; format packs remain data.

## Why W0B-3 Does Not Activate Packs

Activation requires fixture proof, canary handling, and maker-checker approval. Those are intentionally deferred to W0B-4.

## Future Work

W0B-4:

- fixture runner
- draft to validated transition
- canary to active transition
- maker-checker activation
- single-active transaction

W0C:

- staging rows to shadow ledger entries
- reversals and corrections
- recovery reports

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
```

Security boundary checks:

```sh
grep -R "eval(\\|new Function\\|vm\\.\\|child_process\\|require(\\|import(" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
grep -R "parseFloat\\|Math.round\\|Number(" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
grep -R "journal_entries\\|journal_postings\\|LedgerService\\|postEntry\\|wallet_events_outbox\\|account_balances\\|wallet_holds" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
```

## Rollback Notes

W0B-3 is local source-only service work. If rollback is needed before merge, remove the W0B-3 import-pipeline service files and this document. No Cloud Run, live database, n8n, custody, payment, payout, or provider rollback is involved.

## Explicit Non-Goals

W0B-3 does not implement a fixture runner, maker-checker activation, staging-to-ledger posting, recovery reports, payment/custody/bank movement, provider calls, n8n workflow changes, GCP secrets, Cloud Run deploys, live database writes, or public seller-facing wallet UI.
