# W0C-3A Import Correction Planner

W0C-3A adds a read-only correction planner for already posted W0 shadow imports. It compares stored staging rows from one import file with a fresh parser dry run of the same file under a newer format pack version.

The planner does not apply corrections. It never creates ledger entries, never calls the ledger posting service, and never mutates staging rows or import files. When persistence is requested, it writes only correction batch and correction item plan rows.

## Inputs

- `importFileId`
- `newFormatPackVersionId`
- `reason`
- `createdBy`
- optional shipment resolver for dry-run parsing
- optional `persistPlan`

`createdBy` must be an internal principal:

- `import_pipeline_w0`
- `system:*`
- `usr_*`

Free-form human contact values are rejected.

## Dry-Run Flow

1. Load the import file and current staging rows.
2. Read the same stored file content through a content-provider abstraction.
3. Run `FormatPackParserService.dryRunParseCsv` with `persistStagingRows=false`.
4. Convert old and new rows into sanitized comparable rows.
5. Compare normalized internal fields only.
6. Return a plan, and optionally persist it.

The content provider is injected. Tests use a fake provider; the planner itself performs no remote object read.

## Fingerprints

Fingerprints are generated from normalized internal fields:

- shipment id
- event class
- amount minor
- row status
- exception code
- event date
- charge code
- source event category
- duplicate key

The planner uses canonical JSON and a SHA-256 prefix. Source row payloads and external readable refs are excluded.

## Actions

- `no_change`
- `post_new`
- `reverse_only`
- `reverse_and_repost`
- `still_exception`
- `unmatched_old_row`
- `ambiguous_match`

Unsupported event classes, missing shipment links, zero or bad amount minor values, and parser exception rows are unpostable and remain planning-only items.

## Persistence

When `persistPlan=true`, the planner writes:

- `import_correction_batches`
- `import_correction_items`

The batch stores a sanitized dry-run summary. Items store only fingerprints, opaque old posted entry refs, proposed row numbers, action, status, and sanitized diffs. Reversal and corrected entry refs remain null in W0C-3A.

## Explicit Non-Goals

- no correction apply workflow
- no reversal posting
- no ledger mutation
- no staging row mutation
- no import file mutation
- no public route
- no provider integration
- no live deploy
