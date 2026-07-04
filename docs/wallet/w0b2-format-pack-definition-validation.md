# W0B-2 Format Pack Definition Validation

W0B-2 adds the internal service foundation for Shipmastr import format packs. It creates no public API, runs no parser over courier files, and posts nothing to the wallet ledger.

## What W0B-2 Implements

- `FormatPackService` for internal creation of `format_packs` rows and draft `format_pack_versions`.
- `FormatPackDefinitionValidator` for strict JSON definition validation.
- Parser primitive registry for the small set of known parser operations.
- Deterministic SHA-256 `definition_hash` from canonical JSON.
- Tests that prove format packs are declarative data and not executable code.

## Parser Engine Is Code, Format Packs Are Data

The parser engine remains deployed application code. Format packs only describe courier-specific headers, aliases, column transforms, charge-code mappings, duplicate keys, and total checks. A courier header, date, or charge-code drift should be handled by creating a new `format_pack_versions` draft row instead of deploying Cloud Run.

W0B-2 validates definitions only. It does not parse CSV files, write `staging_rows`, activate versions, or post ledger entries.

## Definition Schema

Allowed top-level keys:

- `schema_version`
- `source`
- `headers`
- `columns`
- `charge_code_map`
- `event_class_map`
- `row_filters`
- `duplicate_key`
- `total_rule`
- `quirks`
- `metadata`

Unknown top-level keys are rejected.

Required shape checks:

- `headers.fingerprint` must be a non-empty string array when `headers` is present.
- `columns` must be an object when present.
- column configs support `from` and `transforms` only in W0B-2.
- `duplicate_key` must be a non-empty array of parsed column keys.
- `total_rule.field` must reference a parsed numeric or minor-unit field, and `total_rule.must_equal` must be `stated_total_minor`.
- `charge_code_map` and `event_class_map` values must be one of the allowed event classes.

## Allowed Parser Primitives

- `trim`
- `normalize_whitespace`
- `normalize_header`
- `parse_paise`
- `parse_date`
- `parse_grams`
- `parse_string`
- `parse_enum`
- `map_charge_code`
- `infer_sign`
- `classify_event`
- `require_field`
- `optional_field`
- `row_filter`
- `duplicate_key`
- `total_rule`

Unknown primitives are rejected before a draft version can be stored.

## Rejected Unsafe Patterns

Format packs are JSON data and must not include executable behavior. The validator rejects:

- executable-code-like strings
- module-loader/runtime escape strings
- SQL-like transform fragments
- arbitrary regex config
- non-JSON values
- raw transform strings that are not known primitive names

There is no dynamic code execution path in W0B-2.

## Definition Hash Behavior

`definition_hash` is SHA-256 over canonical JSON:

- object keys are sorted recursively
- array order is preserved
- database ids, timestamps, status, and creator metadata are excluded

Two semantically identical definitions with different object key order produce the same hash.

## Ops Drift Workflow

For courier header, date-format, or charge-code drift:

1. Create or find the existing `format_packs` row.
2. Create a new draft `format_pack_versions` row with the changed JSON definition.
3. W0B-2 validates the definition and stores a deterministic `definition_hash`.
4. Keep the version in `draft`.

W0B-2 intentionally does not activate versions. Draft to validated requires the W0B-4 fixture runner.

## Future Work

W0B-3:

- CSV dry-run parser
- `staging_rows` writes
- resolver interface
- row-level exceptions
- total tie validation

W0B-4:

- fixture runner
- draft to validated transition
- canary to active transition
- maker-checker activation
- single active version transaction

W0C:

- staging rows to shadow ledger entries
- reversals and corrections
- recovery reports

## Rollback Notes

W0B-2 is source-only service and documentation work on top of the W0B-1 schema. If needed, remove the `src/modules/importPipeline` files and this document. No live database or Cloud Run rollback is involved because this phase is not deployed and runs no migration.

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
grep -R "journal_entries\\|journal_postings\\|LedgerService\\|postEntry" backend/src/modules/importPipeline backend/src/modules/importModule 2>/dev/null || true
```

## Explicit Non-Goals

W0B-2 does not involve custody, payments, provider calls, n8n, GCP secrets, Cloud Run deploys, public seller APIs, live databases, parser execution, fixture execution, maker-checker activation, or ledger posting.
