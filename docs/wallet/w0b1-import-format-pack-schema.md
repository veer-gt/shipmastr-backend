# W0B-1 Format-Pack Import Pipeline Schema

## Scope

W0B-1 adds the database foundation for Shipmastr's format-pack import pipeline. It is schema-only: no parser services, fixture runner, maker-checker activation methods, public routes, wallet ledger posting, custody, payment movement, payouts, PA settlement, lending, n8n, GCS, Cloud Run, or live database work is implemented here.

W0 remains shadow-only. This phase prepares the operational records needed to turn hostile courier, seller, COD remittance, and bank files into validated staging rows in later phases.

## Tables Added

Migration:

`20260704130000_w0b1_import_format_pack_schema`

Tables:

- `import_files`: file landing registry keyed by `file_hash`, source, counterparty, period, storage path, optional format-pack pointers, optional stated total, and lifecycle status.
- `staging_rows`: per-row quarantine and staging records with original `raw` JSONB, normalized `parsed` JSONB, conceptual event class, internal shipment id, exception metadata, and future `posted_entry_ref`.
- `format_packs`: format pack registry keyed by `pack_key`, source, and optional courier code.
- `format_pack_versions`: versioned declarative JSONB definitions, definition hash, minimum engine version, status, creator/approver metadata, and activation/retirement timestamps.
- `format_pack_fixtures`: fixture metadata and expected summaries for future regression gates.
- `format_pack_test_runs`: fixture runner output records for future validation gates.

## Parser Engine Code, Format Packs Data

The parser engine belongs in backend code so parsing behavior is reviewable, tested, bounded, and deployable through normal engineering controls.

Format packs are data. They describe headers, aliases, column mappings, charge-code dictionaries, date formats, total rules, duplicate keys, and source quirks. Ordinary courier header/date/charge-code changes should be handled by publishing a new tested `format_pack_versions` row instead of changing Cloud Run code.

W0B-1 stores only the versioned definitions. W0B-2 will add definition validation and parser services.

## Schema-Only Boundary

This task deliberately does not parse CSV files and does not run fixtures. It only creates the durable records that later services need:

- file registry
- quarantined staging row storage
- format pack registry and versioning
- fixture metadata
- fixture test-run storage

No public HTTP controller is added.

## Raw Row Quarantine

`staging_rows.raw` is quarantine storage. It may contain external file content, including courier tracking references and other hostile values from uploaded files. Raw rows are retention-bound operational evidence and must not be copied into journal entries.

`staging_rows.parsed` is a normalized candidate representation for later validation. It may still carry external refs required for resolution until a future resolver maps them to internal ids.

## I17 Preservation

I17 is preserved by keeping buyer-resolvable and provider file references out of wallet ledger tables:

- W0B-1 does not write `journal_entries`.
- W0B-1 does not write `journal_postings`.
- W0B-1 does not call `LedgerService` or `postEntry`.
- `posted_entry_ref` is nullable and reserved for W0C.
- `shipment_id` is intended to hold the internal resolved shipment id once a future resolver succeeds.

External refs can exist only in import quarantine/staging records until future validation resolves them into internal opaque ids.

## Conceptual Status Models

`import_files.status` uses text for these conceptual states:

- `landed`
- `parsed`
- `validated`
- `staged`
- `exception`

`staging_rows.status` uses text for these conceptual states:

- `staged`
- `parsed`
- `resolved`
- `validated`
- `exception`
- `ready_for_posting`

`format_pack_versions.status` uses text for these conceptual states:

- `draft`
- `validated`
- `canary`
- `active`
- `retired`
- `rejected`

`format_pack_test_runs.status` uses text for:

- `passed`
- `failed`

Text statuses are intentional in W0B-1 to match the request and keep schema iteration low-friction before the parser and activation services settle.

## Future W0B-2

W0B-2 should implement:

- `FormatPackService`
- declarative definition validation
- unknown primitive rejection
- explicit rejection of `eval`, `new Function`, dynamic imports, SQL fragments, executable JavaScript, and unsafe arbitrary regex behavior
- draft, validated, canary, active, retired, rejected transition methods
- active-version pointer switching through transactional service methods

## Still Out Of Scope

Later phases must cover:

- CSV parsing
- fixture runner
- maker-checker activation
- staging-to-shadow-ledger posting
- recovery reports
- ImportModule to LedgerService integration
- n8n transport integration
- GCS/live storage integration
- production API deployment

## Validation Commands

```bash
cd /Users/mac/shipmastr-fullstack/backend
npx prisma validate
npx prisma generate
npm run build
npm test
git diff --check
grep -R "journal_entries\\|journal_postings\\|LedgerService\\|postEntry" backend/src/modules backend/prisma/migrations/20260704130000_w0b1_import_format_pack_schema
```

The grep can find pre-existing W0A wallet ledger implementation files. It must not find W0B-1 parser/import code that writes ledger tables or calls `LedgerService.postEntry`.

## Rollback Notes

This migration is additive. If rolled back before use, remove the six W0B-1 tables and their indexes/foreign keys:

- `format_pack_test_runs`
- `format_pack_fixtures`
- `staging_rows`
- `import_files`
- `format_pack_versions`
- `format_packs`

Once real import files or staging rows exist, do not delete operational evidence casually. Prefer retention-policy cleanup and append-only exception/audit behavior in later phases.
