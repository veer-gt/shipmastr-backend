# W0C-2 Shadow Recovery Reports

W0C-2 adds a read-only report service for import-pipeline recovery analysis. It is an internal backend service surface only; it does not mount an HTTP controller and does not expose public API routes.

## Service Surface

- `RecoveryReportService.generateRecoveryReport(input)`
- `RecoveryReportExporter.toJson(report)`
- Module export: `importPipelineModule.recoveryReportService`

Input:

```ts
{
  brandOrgId: string;
  period?: string;
  fileIds?: string[];
  courierCounterparty?: string;
  fromDate?: string;
  toDate?: string;
  includeRows?: boolean;
  format?: "json";
}
```

## Why Ledger-First

W0C-2 reports read the shadow journal and postings as the audit product. Source payloads are used only through already-staged metadata and exception rows. Financial totals are mapped from journal entries plus account types so a report can tie back to balanced postings.

## Scope Rule

Reports are scoped to `ledgerScope: "shadow"` and are analytical only. They must never be interpreted as available wallet balance, payable balance, custodial money movement, settlement approval, or payment authority.

The service selects import files first, then analyzes shadow ledger entries connected to those files through posted staging references or existing import metadata. Any non-shadow ledger entry connected to selected staging rows is excluded and surfaced as a warning.

No correction, reversal, settlement, provider call, or notification is performed by this service.

## Sections

The report contains:

- `metadata`: selected brand, period/date/file filters, generated time, report version, warnings.
- `importQuality`: file and row counts, auto-post rate, statuses, exception codes, format-pack versions.
- `financialSummary`: freight, RTO, return, refund, dispute, COD, courier payable impact, seller shipping impact.
- `rtoSummary`: RTO freight, RTO count, cost per RTO, share of freight, return freight, refund.
- `weightDisputeSummary`: dispute debits, credits, recovered amount, open exposure, recovery rate.
- `codSummary`: collected, remitted, net receivable, counts.
- `courierSummary`: grouped by import counterparty, including unposted exceptions and unattributed deductions.
- `tieOut`: included journal entries/postings, debit/credit totals, missing row links, extra file-linked ledger entries.
- `exceptions`: unresolved or unknown event rows and exception-code rollups.
- `rowDetails`: optional sanitized row-level view.

## Economic Mapping

The report counts each economic event once:

- `shipment_charge`: seller `shipping_balance` debit, falling back to courier `courier_payable` credit.
- `rto_freight_charge`: seller `shipping_balance` debit.
- `return_freight_charge`: seller `shipping_balance` debit.
- `shipment_refund`: seller `shipping_balance` credit.
- `weight_dispute_hold`: seller `shipping_balance` debit, falling back to seller `dispute_hold` credit.
- `weight_dispute_release`: seller `dispute_hold` debit, falling back to seller `shipping_balance` credit.
- `cod_collected`: seller `cod_receivable` credit.
- `cod_remittance_in`: seller `cod_receivable` debit.

Tie-out totals still sum every included journal posting, so debit and credit totals can be verified independently from the economic event rollup.

## Distinctions

- RTO freight is its own metric and is not counted as a refund.
- Return freight is separate from RTO freight and refund.
- Shipment refund reduces seller shipping impact and courier payable impact.
- Weight dispute recovery is dispute credit divided by dispute debit using integer basis points.
- COD receivable is collected minus remitted, still shadow-only.

## Sanitization Rule

Row details are intentionally narrow:

- internal shipment identifier
- event class
- entry type
- minor-unit amount string
- status
- exception code
- posted entry reference
- internal source type/reference

The service does not join commerce customer tables and does not expose original staging JSON or buyer identity/contact/location data.

## Export

JSON export is intentionally simple and stable:

```ts
new RecoveryReportExporter().toJson(report)
```

CSV/PDF/download surfaces are outside W0C-2.

## Validation

Expected local validation:

```sh
npx prisma validate
npx prisma generate
npm run build
npm test
git diff --check
grep -R "parseFloat\\|Math.round\\|Number(" backend/src/modules/importPipeline backend/src/modules/walletLedger 2>/dev/null || true
grep -R "post" backend/src/modules/importPipeline/recovery* backend/src/modules/importPipeline/*report* 2>/dev/null || true
grep -R "source payload leak markers" backend/src/modules/importPipeline/*report* backend/docs/wallet/w0c2-shadow-recovery-reports.md 2>/dev/null || true
```

## Rollback Notes

W0C-2 has no migration and no write path. Rolling back is a source revert of the report service, exporter, tests, module export, and this document.

## Explicit Non-Goals

- No W0C-3 correction journals.
- No reversal service.
- No wallet availability calculation.
- No custody movement.
- No payment, provider, n8n, webhook, or message action.
- No public controller or route.
- No migration or table.
- No live database operation.

## Future Work

W0C-3 remains responsible for parser-fix correction/reversal workflows, corrected report snapshots, and exception workflow surfaces.

W0D remains responsible for pilot ops wrappers, runbooks, admin command surfaces, and any later transport/orchestration layer.
