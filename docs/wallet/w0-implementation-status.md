# W0 Wallet Implementation Status

This page tracks the internal W0 wallet/import foundation only. It is not a production rollout checklist.

## Current Scope

W0 is the local shadow-ledger and import-pipeline foundation:

- W0A: done, wallet ledger foundation
- W0B: done, normalized import files, staging rows, format packs, fixtures, and activation
- W0C: done, shadow posting, recovery reports, and correction planning/application
- W0C-3B-H1: done, single-reversal and stale correction hardening
- W0D: done, local pilot ops wrapper and runbook
- W0D-H1: done, final pilot ops hardening
- W0D-H3: local synthetic format-pack seed and activation support for SAMPLE fixture rehearsal

The authoritative import schema remains:

- `import_files`
- `staging_rows`
- `format_packs`
- `format_pack_versions`
- `format_pack_fixtures`
- `format_pack_test_runs`

## W0A

Status: implemented locally.

Main points:

- ledger account config seed rows
- account creation validation
- double-entry journal posting
- deterministic balance updates
- idempotent entry refs
- internal outbox record creation

W0A does not expose seller balances or public wallet APIs.

## W0B

Status: implemented locally.

Main points:

- normalized import file landing
- staging rows
- format pack definitions
- fixture runs
- validation and canary/activation flow
- active pack invariants

W0B supersedes the older import sketch and must remain the source of truth for local pilot intake.

## W0C

Status: implemented locally.

Main points:

- staging row to shadow-ledger mapping
- shadow account provisioning
- recovery report aggregates
- correction plan generation
- correction apply with W0C-3B stale plan checks
- single-reversal database invariant
- duplicate reversal recovery behavior

W0C applies corrections only through `LedgerService`.

## W0D

Status: implemented locally in `PilotOpsService`.

W0D adds internal/local orchestration only:

- readiness check
- format pack validation flow
- server-derived file hash verification with optional expected hash
- import dry-run
- import stage execution behind explicit execute flag
- staged-row shadow posting
- recovery report generation
- tie-out based shippable gate
- auto-post rate and human-touch proxy metrics
- correction plan preview/persistence
- correction approve/apply behind explicit execute flag
- end-to-end pilot dry-run
- end-to-end local pilot execution

The local command is:

```bash
node scripts/wallet-w0-pilot.mjs <command>
```

The script defaults to safe preview behavior and refuses cloud or production-like runtime.

W0D-H1 safeguards:

- `fileHash` is derived from parsed content, never trusted from caller metadata when content is available.
- `expectedFileHash` is verification-only and rejects mismatches.
- format-pack activation and correction apply require distinct internal principals.
- a report that does not tie out does not ship.
- fixture dry-runs may record test-run audit rows, but pack status remains unchanged.
- operational summaries include `autoPostRateBps` and `humanTouchPerThousandRows`.

`humanTouchPerThousandRows` is currently a proxy metric: `(exceptionRowCount * 1000) / totalRows`. During pilots, ops must record actual operator minutes per import file in pilot notes until a later metrics patch replaces the proxy with actual minutes.

W0D-H3 adds local-only synthetic rehearsal support:

- seeds `bigship_synthetic_courier_mis`
- activates the `BIGSHIP_SYNTHETIC` / `courier_mis` sample format pack through fixture gate and maker-checker
- reads paired seller-export rows through `--orders-file` for deterministic local resolver IDs
- keeps the synthetic fixture marked SAMPLE only
- separates raw file arithmetic tie from postable ledger subtotal: the normal synthetic fixture ties on `rawFileTotalMinor=667470` and `statedTotalMinor=667470`, while expected hostile row exceptions remain visible separately
- reserves `IMPORT_TOTAL_MISMATCH` for true file tie failures such as the generated `--no-tie` variant

Synthetic rehearsal proves W0 machinery, not real courier hostility. Real anonymized Bigship MIS remains required as the first true golden fixture. Anonymize identity, preserve hostility, keep amounts real, and never commit raw real courier files.

## Final W0 Preservation Status

W0 is code-complete in local source for the shadow-only audit ledger foundation. It is pilot-ready after source-control preservation and one real anonymized Bigship-style MIS file rehearsal.

W0 remains shadow-only and zero custody. There is no public wallet surface. The normalized W0B schema remains authoritative and replaces the older illustrative `format_packs(spec, version, fixture_refs)` sketch.

## Not Implemented

These are explicitly outside W0D:

- W1/W2/W3
- shadow dispute aging
- optional future W0C-4 shadow dispute aging
- repeat charge resolver/classifier behavior
- custody
- payments
- bank movement
- payout movement
- platform split settlement
- lending
- public seller APIs/controllers
- provider integrations
- deployment automation
- live database operations
- external workflow automation

## Safety Expectations

- W0D must not write journal tables directly.
- W0D must not perform money conversion with floating arithmetic.
- W0D must not expose readable operational refs in pilot outputs.
- W0D must not introduce public routes.
- W0D must not change W0 ledger semantics.
