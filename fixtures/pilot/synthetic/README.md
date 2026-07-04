# W0 Synthetic Fixture Kit

Deterministic hostile courier-MIS + paired seller export, for exercising the W0
pipeline before a real courier file exists.

## What this proves and what it cannot

Proves: the machinery — format-pack authoring loop, date/amount parsing, the
AWB→shipment resolver, repeat-billing classification, the tie-out gate, e2e
posting, and recovery-report rendering.

Cannot prove: that real hostility is handled. You cannot discover hostility you
invented. The W0 definition of done still requires a real courier file as the
first golden fixture. Treat any report generated from this data as a SAMPLE and
watermark it as such.

## Files

- `generate-courier-fixture.mjs` — the generator (Node 18+, zero deps,
  deterministic per seed; integer-paise arithmetic only)
- `bigship-mis-2026-07.csv` — hostile MIS, 60 shipments + adjustment rows
  (70 data rows), footer total ₹6,674.70 that ties
- `shopify-orders-2026-07.csv` — paired seller export; ingest this FIRST so the
  resolver's Order Ref join has a target (plus 2 unbilled orders as findings)
- `traps-manifest.json` — the answer key: every trap, its rows/AWBs, expected
  pipeline behavior, and computed vs stated totals in paise

## Usage

```bash
node generate-courier-fixture.mjs --out ./fixtures/pilot/synthetic \
  --rows 60 --seed 20260704 --period 2026-07
# tie-out failure variant for gate testing:
node generate-courier-fixture.mjs --out ./fixtures/pilot/synthetic-notie --no-tie
```

Then: ingest the orders CSV as seller_export, run `w0:import-dry-run` on the
MIS, build the pack against the dry-run's complaints, attach as fixture, gate,
activate, `w0:local-e2e`, and check the report against `traps-manifest.json` —
the manifest is the grading rubric for the run.

## Swapping in reality

Headers are Bigship-LIKE, not Bigship's actual export. When a real file lands:
edit `MIS_HEADERS` and the row writer, keep the traps, keep the manifest
convention, and re-anonymize real files by script (format-preserving fakes for
names/phones/addresses; AWBs re-keyed consistently; headers, charge codes, date
quirks, duplicates, and amounts untouched — anonymize identity, preserve
hostility).

## Trap inventory

T1 mixed date formats in one column · T2 duplicate row (overlap re-drop) ·
T3 same-AWB freight rebill (reverse_and_repost candidate) · T4 unknown charge
head MISC ADJ · T5 comma-grouped and trailing-space amounts · T6 mid-file blank
line + repeated header · T7 footer TOTAL row (excluded from data; source of
statedTotalMinor) · T9 three-decimal weights · T10 fake consignee PII columns
(staging-raw only, per I17) · T11 blank/mangled Order Refs (unresolved
exceptions) · T12 unbilled orders in seller export (audit finding, not
exception) · T13 weight-dispute debit ×4 + credit ×1 (pending until W0C-4) ·
T14 RTO freight ×2
