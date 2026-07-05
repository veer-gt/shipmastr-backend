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

## Post-W0 W1A Sandbox Foundation

W1A has a separate internal-only foundation for sandbox closed-loop shipping wallet behavior. It adds guarded custodial shipping balance services, sandbox top-up intents, holds, charge capture, wallet refunds, read-only summaries, and cashout blockers.

W1A does not change W0 behavior. It does not add public APIs, live payment movement, bank movement, checkout split settlement, COD custody, lending, live database work, or deployment automation.

## Post-W0 W1B Read Surfaces

W1B exposes W1A through read-only internal, admin, and seller-safe wallet read surfaces. It adds readiness, summary, and statement endpoints only.

W1B does not add mutation routes, live payment movement, bank movement, checkout split settlement, COD custody, lending, live database work, deployment automation, or external workflow automation. Shadow balances remain excluded from spendable wallet reads.

## Post-W0 W1C Sandbox Smoke

W1C adds a local/internal sandbox operations smoke runner for the W1A/W1B foundation. It plans by default and executes only with explicit local/test flags.

W1C verifies provisioning, sandbox top-up, hold, capture, unused hold remainder release, wallet-only refund, final summary, custodial statement reads, and unsupported-action blockers.

W1C does not add public mutation APIs, live payment movement, bank movement, checkout split settlement, COD custody, lending, live database work, deployment automation, or external workflow automation. Shadow balances remain excluded from spendable wallet reads.

## Post-W0 W1D Activation Gate

W1D adds a read-only wallet activation gate and compliance/accounting checklist. It reports whether live W1 is blocked, sandbox-only, or review-ready.

W1D is not activation. It does not enable live wallet movement, write database rows, add public wallet APIs, or change W0/W1A/W1B/W1C behavior.

Live W1 remains blocked until counsel, accountant, operations, and owner approvals are documented. W2/W3 remain separately gated and not approved.

## Post-W0 W2A COD Instruction Netting

W2A adds non-custodial COD netting instructions only:

- draft/review/approved/exportable instruction batches
- item-level COD net calculation from string minor-unit inputs
- review flags for negative net, missing or duplicate internal shipment reference, invalid amount, unknown courier code, and unsafe inbound reference
- JSON/CSV instruction export for review

W2A does not create COD custody, move money, pay sellers, settle couriers, credit W1 shipping balance, create spendable balances, implement W3 checkout split settlement, or implement early COD/lending.

Live activation remains blocked by W1D and future W2 approvals.

## Post-W0 W2B COD Instruction Read Surfaces

W2B exposes W2A COD instruction batches through protected read and export-preview surfaces only:

- internal W2 COD readiness
- admin batch list and detail reads
- admin export-preview reads
- seller-scoped summary and batch list reads

W2B export-preview does not change batch status, does not create instruction events, and is not payment execution. W2B responses keep `movementExecuted=false`, `custodyCreated=false`, `payoutExecuted=false`, `settlementExecuted=false`, and `spendableBalanceCreated=false`.

W2B does not create COD custody, move money, pay sellers, settle couriers, credit W1 shipping balance, create spendable balances, implement W3 checkout split settlement, or implement early COD/lending.

Live activation remains blocked by W1D and future W2 approvals.

## Post-W0 W2C COD Reconciliation Smoke

W2C adds a local/internal smoke runner for the W2A + W2B instruction stack:

- dry-run by default
- deterministic review and clean fixtures
- review trap verification
- clean `approved_instruction` verification
- W2B read and export-preview verification
- no status change from export-preview
- no W1 COD credit, COD custody, payout execution, courier settlement execution, W3 split settlement, lending, early COD funding, live provider calls, or public mutating seller APIs

W2C execution is local/test-style only and writes W2A instruction records only. It remains blocked for production, staging, and live runtime modes.

## Post-W0 W2D COD Activation Gate

W2D adds a read-only activation gate/checklist for the COD custody-versus-instruction-only decision:

- current mode remains instruction-only
- custody target remains blocked without complete legal, accounting, banking, operations, and owner evidence
- complete custody evidence returns review-ready only, not activated
- W3, lending, and early COD funding remain blocked
- no database writes, routes, custody, payout execution, bank/cashout, provider calls, or live activation are added

Live activation remains blocked by W1D, W2D, and future W2 approvals.

## Post-W0 W3A Checkout Settlement Shadow Preview

W3A adds checkout split settlement preview records only:

- shadow/preview batches, items, allocations, and events
- deterministic split preview formula
- review-required traps for negative preview, missing/duplicate checkout refs, invalid amounts, unsupported currency, and unsafe refs
- local/test smoke CLI with dry-run default
- JSON/CSV preview export
- explicit `movementExecuted=false`, `paymentCaptured=false`, `payoutExecuted=false`, `settlementExecuted=false`, `custodyCreated=false`, and `previewOnly=true`

W3A does not capture payments, pay sellers, settle couriers, create custody, create spendable balances, credit W1 shipping balance, implement lending, or activate payment aggregator behavior.

Live activation remains blocked by future W3D approvals.

## Post-W0 W3B Checkout Settlement Read Surfaces

W3B exposes W3A checkout settlement previews through protected read and export-preview surfaces only:

- internal readiness read
- admin preview batch list
- admin preview batch detail
- admin JSON/CSV export-preview
- seller-scoped preview summary/list reads

Every W3B response keeps `previewOnly=true`, `movementExecuted=false`, `paymentCaptured=false`, `payoutExecuted=false`, `settlementExecuted=false`, and `custodyCreated=false`.

W3B export-preview does not change batch status, does not create events, and is not payment execution.

W3B does not move money, capture payments, pay sellers, settle couriers, create custody, credit W1 shipping balance, implement lending or early COD funding, create bank/cashout movement, or activate payment aggregator behavior.

Live activation remains blocked by future W3D approvals.

## Not Implemented

These remain explicitly outside W0D itself. Later local phases document their own guarded preview or sandbox surfaces separately:

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
