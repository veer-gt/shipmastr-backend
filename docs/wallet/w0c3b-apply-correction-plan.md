# W0C-3B Apply Correction Plan

W0C-3B applies approved W0 shadow correction plans. It is still a shadow-only phase. It does not add public routes, external transport, custody flows, provider calls, or live deployment work.

The journal remains append-only. Corrections are new entries:

- reversal entries for old shadow entries
- corrected entries for newly planned interpretations

Old journal rows are never edited.

## Approval Flow

`approveCorrectionBatch` moves a planned batch to approved.

Rules:

- batch must be `planned`
- approver must be an internal principal
- approver must differ from maker
- blocking items stop approval
- approval posts no ledger entries

Accepted principal forms:

- `import_pipeline_w0`
- `system:*`
- `usr_*`

## Apply Flow

`applyCorrectionBatch` applies an approved or retryable failed batch.

Rules:

- dry run returns operations only
- dry run does not call the ledger
- dry run does not update correction rows
- non-dry-run processes items in stable order
- all ledger writes go through `LedgerService.postEntry`
- correction status updates happen only after successful ledger calls

## Action Handling

| Action | Behavior |
| --- | --- |
| `no_change` | mark skipped, no ledger call |
| `still_exception` | mark skipped, no ledger call |
| `post_new` | post one corrected shadow entry |
| `reverse_only` | post one inverse shadow reversal |
| `reverse_and_repost` | post inverse reversal, then corrected shadow entry |
| `ambiguous_match` | block |
| `unmatched_old_row` | block |

## Reversal Entry Rules

Reversals:

- use deterministic `W0COR-REV-*` refs
- set `reversal_of`
- use exact inverse postings
- preserve old shadow source context only when ledger-safe
- use the safe narrative `W0 shadow correction reversal`
- reject non-shadow targets
- reject reversal-of-reversal targets
- are protected by the database invariant `je_single_reversal_idx`, a unique partial index on `journal_entries(reversal_of)` for non-null targets

## Corrected Posting Rules

Corrected entries:

- use deterministic `W0COR-NEW-*` or `W0COR-FIX-*` refs
- reuse W0C-1 shadow mapping
- use only seller/courier W0 shadow accounts
- use the safe narrative `W0 shadow correction posting`
- derive commands from sanitized planned diff fields

## Replay Behavior

Each item stores reversal and corrected refs. On retry:

- an existing reversal ref is refetched and reused only when it resolves to a valid inverse reversal for the target
- an existing corrected ref is reused
- already applied items are returned without posting
- a partial failure after reversal can be retried to finish corrected posting
- if a concurrent duplicate reversal loses the database race, apply refetches the existing reversal and treats it as idempotent only when command hash, target, scope, currency, and inverse postings match
- mismatched duplicate reversals fail with `REVERSAL_UNIQUE_CONFLICT`

Ledger idempotency remains enforced by deterministic entry refs and command hashes.

## Stale Plan Checks

Before posting a reversal, apply refetches the current batch, item, and target entry.

Checks:

- batch must still be approved or retryable failed
- item must still be planned or retryable failed
- blocking actions cannot apply
- old target entry must exist
- old target entry must still be shadow scope
- old target entry must not itself be a reversal
- old target entry must not already have another reversal
- old target entry type must still match the planned old event class when available
- old target postings must still match the planned old amount and debit/credit shape when available

Stable correction-apply error codes:

- `TARGET_ENTRY_NOT_FOUND`
- `TARGET_ALREADY_REVERSED`
- `TARGET_ENTRY_SCOPE_MISMATCH`
- `TARGET_ENTRY_CHANGED`
- `STALE_CORRECTION_PLAN`
- `REVERSAL_UNIQUE_CONFLICT`

## I17 Safety

Generated journal fields include only opaque internal ids, correction refs, shadow source refs, and internal principal ids. Raw row payloads and carrier or human-resolvable refs are excluded from commands, metadata, narratives, and hashes.

## Shadow Boundary

W0C-3B rejects non-shadow reversal targets and corrected postings are created only with W0C-1 shadow account mapping. No custody or money-movement path is introduced.

## LedgerService Extension

`LedgerService.postEntry` accepts optional `reversalOf`. The field is stored on `journal_entries.reversal_of`, validated against an existing entry, and scoped to the same ledger scope.

## W0D Remains

- pilot ops wrapper
- admin command scripts
- operating runbook
- fixture/import/report operating sequence
- later n8n transport integration

Shadow dispute aging is intentionally separate future work and is not part of W0C-3B.

## Validation

Run:

- `npx prisma validate`
- `npx prisma generate`
- `npm run build`
- `npm test`
- `git diff --check`

Rollback for this phase is code rollback plus disabling usage of the apply service. Posted correction entries remain append-only ledger facts and are not edited.
