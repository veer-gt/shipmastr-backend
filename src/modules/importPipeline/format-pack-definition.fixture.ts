import type { FormatPackDefinition } from "./types.js";

export function validFormatPackDefinition(overrides: Partial<FormatPackDefinition> = {}): FormatPackDefinition {
  return {
    schema_version: "1",
    source: "courier_mis",
    headers: {
      fingerprint: ["awb", "charge code", "amount"],
      aliases: {
        awb: ["awb", "waybill", "docket no", "tracking number"],
        charge_code: ["charge code", "fee type", "billing head"],
        amount: ["amount", "net amount", "charge"],
        event_date: ["date", "billing date"]
      }
    },
    columns: {
      external_awb: { from: "awb", transforms: ["trim"] },
      charge_code: { from: "charge_code", transforms: ["trim", "normalize_whitespace"] },
      amount_minor: { from: "amount", transforms: ["parse_paise"] },
      event_date: { from: "event_date", transforms: [{ parse_date: ["DD/MM/YYYY", "YYYY-MM-DD"] }] }
    },
    charge_code_map: {
      FWD: "freight_charged",
      RTO: "rto_freight_charged",
      RET: "return_freight_charged",
      WGT_DEBIT: "weight_dispute_debit",
      COD: "cod_collected"
    },
    duplicate_key: ["external_awb", "charge_code", "amount_minor", "event_date"],
    total_rule: { field: "amount_minor", must_equal: "stated_total_minor" },
    ...overrides
  };
}
