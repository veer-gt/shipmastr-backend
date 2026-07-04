import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  canonicalJson,
  definitionHash,
  FormatPackDefinitionValidationError,
  FormatPackDefinitionValidator
} from "./format-pack-definition.validator.js";
import { validFormatPackDefinition } from "./format-pack-definition.fixture.js";
import type { FormatPackDefinition } from "./types.js";

function assertInvalid(definition: FormatPackDefinition, expectedCode: string) {
  const validator = new FormatPackDefinitionValidator();
  assert.throws(() => validator.validate(definition), (error) => {
    assert.ok(error instanceof FormatPackDefinitionValidationError);
    assert.ok(error.issues.some((issue) => issue.code === expectedCode), JSON.stringify(error.issues));
    return true;
  });
}

describe("format pack definition validator", () => {
  it("accepts a valid courier MIS definition", () => {
    const result = new FormatPackDefinitionValidator().validate(validFormatPackDefinition());
    assert.equal(result.ok, true);
    assert.equal(result.definitionHash.length, 64);
  });

  it("accepts header alias drift as data-only definition change", () => {
    const definition = validFormatPackDefinition({
      headers: {
        fingerprint: ["waybill", "billing head", "net amount"],
        aliases: {
          awb: ["awb", "waybill", "shipment number"],
          charge_code: ["charge code", "fee type", "billing head", "charge head"],
          amount: ["amount", "net amount", "charge", "total billed"],
          event_date: ["date", "billing date", "invoice date"]
        }
      }
    });

    const result = new FormatPackDefinitionValidator().validate(definition);
    assert.equal(result.ok, true);
  });

  it("produces a deterministic hash independent of object key order", () => {
    const first = validFormatPackDefinition();
    const second = {
      total_rule: { must_equal: "stated_total_minor", field: "amount_minor" },
      duplicate_key: ["external_awb", "charge_code", "amount_minor", "event_date"],
      charge_code_map: {
        COD: "cod_collected",
        WGT_DEBIT: "weight_dispute_debit",
        RET: "return_freight_charged",
        RTO: "rto_freight_charged",
        FWD: "freight_charged"
      },
      columns: {
        event_date: { transforms: [{ parse_date: ["DD/MM/YYYY", "YYYY-MM-DD"] }], from: "event_date" },
        amount_minor: { transforms: ["parse_paise"], from: "amount" },
        charge_code: { transforms: ["trim", "normalize_whitespace"], from: "charge_code" },
        external_awb: { transforms: ["trim"], from: "awb" }
      },
      headers: {
        aliases: {
          event_date: ["date", "billing date"],
          amount: ["amount", "net amount", "charge"],
          charge_code: ["charge code", "fee type", "billing head"],
          awb: ["awb", "waybill", "docket no", "tracking number"]
        },
        fingerprint: ["awb", "charge code", "amount"]
      },
      source: "courier_mis",
      schema_version: "1"
    };

    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(definitionHash(first), definitionHash(second));
  });

  it("rejects unknown top-level keys", () => {
    assertInvalid(validFormatPackDefinition({ parser_plugin: "native" }), "TOP_LEVEL_KEY_UNKNOWN");
  });

  it("rejects unknown primitives", () => {
    assertInvalid(validFormatPackDefinition({
      columns: {
        external_awb: { from: "awb", transforms: ["trimmed"] }
      }
    }), "UNKNOWN_PRIMITIVE");
  });

  it("rejects executable-looking definition strings", () => {
    assertInvalid(validFormatPackDefinition({
      metadata: {
        transform: ["ev", "al("].join("") + "row.amount)"
      }
    }), "EXECUTABLE_STRING");
  });

  it("rejects constructor-like executable strings", () => {
    assertInvalid(validFormatPackDefinition({
      metadata: {
        transform: ["new ", "Function"].join("") + "(row)"
      }
    }), "EXECUTABLE_STRING");
  });

  it("rejects SQL-like transform strings", () => {
    assertInvalid(validFormatPackDefinition({
      columns: {
        amount_minor: { from: "amount", transforms: ["SELECT amount FROM rows"] }
      }
    }), "SQL_LIKE_STRING");
  });

  it("rejects module-loader and runtime escape strings", () => {
    for (const unsafe of [
      ["req", "uire("].join("") + "fs)",
      ["imp", "ort("].join("") + "fs)",
      ["v", "m."].join("") + "runInContext",
      ["child", "_process"].join(""),
      "spawn courier"
    ]) {
      assertInvalid(validFormatPackDefinition({ metadata: { unsafe } }), "EXECUTABLE_STRING");
    }
  });

  it("rejects arbitrary regex config", () => {
    assertInvalid(validFormatPackDefinition({
      columns: {
        external_awb: { from: "awb", transforms: [{ parse_string: { regex: ".*" } }] }
      }
    }), "ARBITRARY_REGEX_NOT_ALLOWED");
  });

  it("rejects invalid charge code event classes", () => {
    assertInvalid(validFormatPackDefinition({
      charge_code_map: {
        FWD: "pay_courier_now"
      }
    }), "EVENT_CLASS_INVALID");
  });

  it("rejects missing header fingerprint when headers are present", () => {
    assertInvalid(validFormatPackDefinition({ headers: { aliases: {} } }), "HEADERS_FINGERPRINT_REQUIRED");
  });

  it("rejects invalid duplicate key shape", () => {
    assertInvalid(validFormatPackDefinition({ duplicate_key: ["external_awb", "missing_column"] }), "DUPLICATE_KEY_UNKNOWN_COLUMN");
  });

  it("rejects invalid total rule shape", () => {
    assertInvalid(validFormatPackDefinition({ total_rule: { field: "charge_code", must_equal: "stated_total_minor" } }), "TOTAL_RULE_FIELD_NOT_NUMERIC");
  });

  it("rejects future ledger output mapping attempts", () => {
    assertInvalid(validFormatPackDefinition({
      journal_outputs: {
        ref: "external_awb"
      }
    }), "TOP_LEVEL_KEY_UNKNOWN");
  });

  it("does not contain dynamic execution escape hatches in import pipeline source", () => {
    const moduleDir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(moduleDir).filter((file) => file.endsWith(".js"));
    const forbidden = [
      ["ev", "al("].join(""),
      ["new ", "Function"].join(""),
      ["v", "m."].join(""),
      ["child", "_process"].join(""),
      ["req", "uire("].join(""),
      ["imp", "ort("].join("")
    ];

    for (const file of files) {
      const contents = readFileSync(join(moduleDir, file), "utf8");
      for (const needle of forbidden) {
        assert.equal(contents.includes(needle), false, `${file} contains forbidden dynamic code marker`);
      }
    }
  });
});
