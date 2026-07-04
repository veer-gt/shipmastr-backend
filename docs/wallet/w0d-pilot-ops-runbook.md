# W0D Pilot Ops Runbook

W0D is an internal/local pilot wrapper for the W0 wallet ledger and import pipeline. It does not add public HTTP routes, seller-facing balances, custody movement, payout movement, provider calls, or deployment automation.

The normalized W0B schema is authoritative for pilot intake:

- `import_files`
- `staging_rows`
- `format_packs`
- `format_pack_versions`
- `format_pack_fixtures`
- `format_pack_test_runs`

Do not reintroduce the older sketch schema. W0D only orchestrates the already-merged W0B and W0C services.

## Wrapper Methods

`PilotOpsService` exposes these local/internal methods:

- `checkW0Readiness`
- `runFormatPackValidationFlow`
- `runImportDryRun`
- `runImportAndStage`
- `postStagedRowsToShadowLedger`
- `generatePilotRecoveryReport`
- `planImportCorrection`
- `approveAndApplyCorrection`
- `runEndToEndPilotDryRun`
- `runEndToEndPilotLocal`

All mutating paths are opt-in. Dry-run is the default posture.

## File Hash Rule

W0D derives `fileHash` server-side from the exact CSV content it parses.

- If `csvContent` is supplied, W0D computes SHA-256 from that content and uses the computed value for import-file dedupe.
- If `storagePath` is supplied, W0D reads the content through the local content provider, computes SHA-256, and uses the computed value.
- `expectedFileHash` is verification-only. If supplied and it does not match the computed content hash, W0D rejects with `FILE_HASH_MISMATCH`.
- Caller-supplied `fileHash` must not be used as the authority when content is available.

This prevents stale client metadata from poisoning import dedupe.

## Local Command

Build first:

```bash
cd backend
npm run build
```

Then run the local command:

```bash
node scripts/wallet-w0-pilot.mjs readiness --source courier_mis --counterparty courier_alpha
node scripts/wallet-w0-pilot.mjs import-dry-run --source courier_mis --counterparty courier_alpha --format-pack-version-id fpv_local --file ./tmp/local.csv
node scripts/wallet-w0-pilot.mjs import-dry-run --source courier_mis --counterparty courier_alpha --format-pack-version-id fpv_local --file ./tmp/local.csv --expected-file-hash <sha256>
node scripts/wallet-w0-pilot.mjs stage-file --source courier_mis --counterparty courier_alpha --format-pack-version-id fpv_local --file ./tmp/local.csv
node scripts/wallet-w0-pilot.mjs stage-file --execute --source courier_mis --counterparty courier_alpha --format-pack-version-id fpv_local --file ./tmp/local.csv
node scripts/wallet-w0-pilot.mjs post-shadow --file-id file_local
node scripts/wallet-w0-pilot.mjs post-shadow --execute --file-id file_local
node scripts/wallet-w0-pilot.mjs report --brand-org-id seller_alpha --period 2026-07
```

The script refuses cloud or production-like runtime. It never prints secrets and does not connect to external providers.

Use `--file <path>` for local CSV input. `--csv <path>` remains accepted as a backward-compatible alias. Both forms are read locally and then hashed server-side by W0D before parsing.

## Format Pack Flow

`runFormatPackValidationFlow` always runs fixtures and records a format-pack test run. This is an audit record, not a ledger mutation.

With dry-run enabled, it returns intended transitions only and includes:

- `fixtureRunExecuted`
- `fixtureRunRecorded`
- `fixtureRunSkipped`
- `statusMutationPerformed`

Current dry-run behavior records fixture test-run rows because the existing fixture runner is auditable. It does not change pack status and never activates a pack in dry-run.

With `dryRun=false`, it may validate a pack. Activation requires:

- `activate=true`
- an `approvedBy` principal
- maker-checker separation from `requestedBy`

If the same actor is supplied for both sides of the gate, W0D rejects with `PRINCIPAL_NOT_DISTINCT`.

## Import Flow

`runImportDryRun` parses input with `persistStagingRows=false`.

`runImportAndStage` returns intended operations unless `execute=true`. Execution lands an import file, parses input, and replaces staging rows through existing W0B services.

The stage summary includes:

- server-derived `fileHash`
- `shippable`
- `blockingIssues`
- `metrics`

## Shadow Ledger Posting

`postStagedRowsToShadowLedger` delegates to `ShadowLedgerPostingService`. That service maps rows and posts through `LedgerService` only.

W0D must not write directly to:

- journal entries
- journal postings
- account balances
- wallet event outbox

Posting summaries include `autoPostRateBps` and `humanTouchPerThousandRows`.

## Recovery Report

`generatePilotRecoveryReport` delegates to the W0C recovery report service and forces row details off. It returns aggregate import quality, financial summary, and tie-out only.

A report that does not tie out does not ship. W0D sets `shippable=false` when:

- debit and credit totals are not balanced
- posted staging rows have no matching ledger entry
- ledger entries have no matching posted staging row

Report tie-out warnings are promoted into pilot warnings.

## Ops Metrics

W0D returns two local pilot metrics:

- `autoPostRateBps`: posted rows multiplied by 10000 divided by staged or attempted rows.
- `humanTouchPerThousandRows`: exception, failed, or skipped rows multiplied by 1000 divided by total rows.

For stage-only parse summaries, `autoPostRateBps` is `null` because no ledger posting has happened yet. When the denominator is zero, metrics return `null`.

`humanTouchPerThousandRows` is currently a proxy metric: `(exceptionRowCount * 1000) / totalRows`. During pilots, ops must also record actual operator minutes per import file in pilot notes. A later metrics patch may replace the proxy with actual minutes once the ops log exists.

## Correction Flow

`planImportCorrection` delegates to the W0C correction planner. Plans are preview-only unless `persistPlan=true`.

`approveAndApplyCorrection` is preview-only unless `execute=true` and `dryRun=false`. Execution requires:

- approved principal
- applied principal
- maker-checker separation

If the approval and apply principals are the same actor, W0D rejects with `PRINCIPAL_NOT_DISTINCT`.

Correction application continues to use the W0C-3B safeguards:

- target entry refetch
- shadow-scope requirement
- stale plan checks
- single-reversal invariant
- duplicate reversal recovery

## Common Failure Modes

- `ACTIVE_FORMAT_PACK_NOT_FOUND`: create or activate a local format pack for the requested scope.
- `FORMAT_PACK_FIXTURES_REQUIRED`: add fixture coverage before validation can pass.
- fixture status `failed`: inspect fixture summary diffs and unknown charge codes.
- parse exceptions: review W0B parser output and format-pack mappings.
- `W0_PILOT_MAKER_CHECKER_REQUIRED`: use separate internal principals for approval and execution.
- `EXECUTE_REQUIRED`: local execution was requested without the explicit execute gate.

## Explicit Non-Goals

W0D intentionally does not implement:

- W1, W2, or W3
- shadow dispute aging
- repeat charge resolver or classifier work
- custody ledger accounts
- payment movement
- payout movement
- bank movement
- public seller APIs
- provider calls
- notification automation
- deployment automation

Shadow dispute aging is separate future work and must not be hidden inside the W0D pilot wrapper.

## Final W0 Status

W0A, W0B, W0C, W0C-3B-H1, W0D, and W0D-H1 are complete in local source. W0 is code-complete for the shadow-only audit ledger foundation after source-control preservation. It is pilot-ready once one real anonymized Bigship-style MIS file is rehearsed locally.

W0 remains shadow-only and zero custody. It exposes no public wallet surface. The normalized W0B schema remains authoritative for import intake. W1, W2, and W3 remain future gated phases.
