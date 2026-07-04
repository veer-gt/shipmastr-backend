import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { validFormatPackDefinition } from "./format-pack-definition.fixture.js";
import { FormatPackParserService } from "./format-pack-parser.service.js";
import { parseGrams, parseMinorUnits } from "./parser-primitives.js";
import type { ShipmentReferenceResolver } from "./shipment-reference-resolver.js";
import { StagingRowService } from "./staging-row.service.js";
import type { FormatPackDefinition } from "./types.js";

const resolvedShipmentId = "11111111-1111-1111-1111-111111111111";

class FakeShipmentReferenceResolver implements ShipmentReferenceResolver {
  async resolveShipmentRef(input: { externalRef: string }) {
    return input.externalRef === "AWB123" ? { shipmentId: resolvedShipmentId } : null;
  }
}

function csv(lines: string[]) {
  return lines.join("\n");
}

function makeParserHarness(definition: FormatPackDefinition = validFormatPackDefinition()) {
  const state = {
    rows: [] as any[],
    fileUpdates: [] as any[],
    imports: [] as any[],
    staging: [] as any[],
    ledgerA: [] as any[],
    ledgerB: [] as any[],
    holds: [] as any[],
    balances: [] as any[],
    outbox: [] as any[],
    transactions: 0
  };
  const version = {
    id: "version_1",
    packId: "pack_1",
    version: "draft",
    definition,
    definitionHash: "hash",
    minEngineVersion: "w0b2",
    status: "draft",
    createdBy: "ops",
    pack: {
      id: "pack_1",
      packKey: "bigship-courier-mis",
      source: "courier_mis",
      courierCode: "bigship"
    }
  };
  const parserClient = {
    formatPackVersion: {
      findUnique: async ({ where }: any) => where.id === version.id ? version : null,
      findFirst: async ({ where }: any) => where.id === version.id ? version : null
    }
  };
  const stagingClient = {
    $transaction: async (callback: any) => {
      state.transactions += 1;
      return callback(stagingClient);
    },
    stagingRow: {
      deleteMany: async ({ where }: any) => {
        state.rows = state.rows.filter((row) => row.fileId !== where.fileId);
      },
      createMany: async ({ data }: any) => {
        state.rows.push(...data);
      }
    },
    importFile: {
      update: async ({ where, data }: any) => {
        state.fileUpdates.push({ where, data });
        return { id: where.id, ...data };
      }
    }
  };

  return {
    service: new FormatPackParserService(parserClient as any, new StagingRowService(stagingClient as any)),
    state,
    version
  };
}

function standardCsv(amount = "118.00", chargeCode = "FWD", date = "04/07/2026", awb = "AWB123") {
  return csv([
    "AWB,Charge Code,Amount,Date",
    `${awb},${chargeCode},${amount},${date}`
  ]);
}

describe("W0B-3 CSV dry-run parser", () => {
  it("parses a Bigship-like CSV and persists staging rows without posted refs", async () => {
    const { service, state } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      fileId: "file_1",
      csvContent: standardCsv(),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver(),
      persistStagingRows: true
    });

    assert.equal(result.fileStatus, "validated");
    assert.equal(result.parsedCount, 1);
    assert.equal(result.resolvedCount, 1);
    assert.equal(result.parsedTotalMinor, "11800");
    assert.equal(result.postableTotalMinor, "11800");
    assert.equal(result.rawFileTotalMinor, "11800");
    assert.equal(result.allRowsTotalMinor, "11800");
    assert.equal(result.fileTies, true);
    assert.equal(result.postableRowCount, 1);
    assert.equal(result.statusCounts.resolved, 1);
    assert.equal(result.rowResults[0]?.status, "resolved");
    assert.equal(result.rowResults[0]?.shipmentId, resolvedShipmentId);
    assert.equal(result.rowResults[0]?.parsed?.amount_minor, "11800");
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0]?.postedEntryRef, null);
    assert.equal(state.rows[0]?.parsed.amount_minor, "11800");
    assert.equal(state.fileUpdates[0]?.data.status, "staged");
    assert.equal(state.transactions, 1);
  });

  it("maps header aliases without parser code changes", async () => {
    const definition = validFormatPackDefinition({
      headers: {
        fingerprint: ["waybill", "fee type", "net amount"],
        aliases: {
          awb: ["awb", "waybill", "docket no"],
          charge_code: ["charge code", "fee type"],
          amount: ["amount", "net amount"],
          event_date: ["date", "billing date"]
        }
      }
    });
    const { service } = makeParserHarness(definition);
    const result = await service.dryRunParseCsv({
      csvContent: csv([
        "Waybill,Fee Type,Net Amount,Billing Date",
        "AWB123,FWD,118,2026-07-04"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "validated");
    assert.equal(result.rowResults[0]?.status, "resolved");
  });

  it("returns a file exception for unknown headers", async () => {
    const { service } = makeParserHarness();
    await assert.rejects(
      () => service.dryRunParseCsv({
        csvContent: csv(["Missing,Headers", "x,y"]),
        formatPackVersionId: "version_1"
      }),
      (error: any) => error.code === "HEADER_FINGERPRINT_MISMATCH"
    );
  });

  it("marks unknown charge codes as row exceptions", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: standardCsv("118.00", "NEWCODE"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "0",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "exception");
    assert.equal(result.rowResults[0]?.exceptionCode, "UNKNOWN_CHARGE_CODE");
  });

  it("accepts charge-code drift through a new definition version", async () => {
    const definition = validFormatPackDefinition({
      charge_code_map: {
        FWD: "freight_charged",
        SURCHARGE: "deduction_unattributed"
      }
    });
    const { service } = makeParserHarness(definition);
    const result = await service.dryRunParseCsv({
      csvContent: standardCsv("118.00", "SURCHARGE"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "validated");
    assert.equal(result.rowResults[0]?.eventClass, "deduction_unattributed");
  });

  it("supports declared date format changes and rejects undeclared formats", async () => {
    const { service } = makeParserHarness();
    const isoResult = await service.dryRunParseCsv({
      csvContent: standardCsv("118.00", "FWD", "2026-07-04"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });
    assert.equal(isoResult.rowResults[0]?.parsed?.event_date, "2026-07-04");

    const badResult = await service.dryRunParseCsv({
      csvContent: standardCsv("118.00", "FWD", "07.04.2026"),
      formatPackVersionId: "version_1",
      resolver: new FakeShipmentReferenceResolver()
    });
    assert.equal(badResult.rowResults[0]?.exceptionCode, "BAD_DATE");
  });

  it("parses supported money strings and rejects bad money", () => {
    assert.equal(parseMinorUnits("118").toString(), "11800");
    assert.equal(parseMinorUnits("118.00").toString(), "11800");
    assert.equal(parseMinorUnits("₹118.00").toString(), "11800");
    assert.equal(parseMinorUnits("Rs. 118.00").toString(), "11800");
    assert.equal(parseMinorUnits("INR 118.00").toString(), "11800");
    assert.equal(parseMinorUnits("1,499.50").toString(), "149950");
    assert.equal(parseMinorUnits("-118.00").toString(), "-11800");
    assert.equal(parseMinorUnits("(118.00)").toString(), "-11800");
    for (const value of ["118.999", "abc", "1.2.3", "", "NaN", "Infinity"]) {
      assert.throws(() => parseMinorUnits(value), (error: any) => error.code === "BAD_MONEY");
    }
  });

  it("parses supported weight strings", () => {
    assert.equal(parseGrams("500g"), 500);
    assert.equal(parseGrams("0.5kg"), 500);
    assert.equal(parseGrams("1 KG"), 1000);
    assert.throws(() => parseGrams("1.2345kg"), (error: any) => error.code === "BAD_WEIGHT");
  });

  it("skips blank rows, repeated headers, and subtotal rows", async () => {
    const { service } = makeParserHarness(validFormatPackDefinition({
      row_filters: [{ type: "subtotal_row" }]
    }));
    const result = await service.dryRunParseCsv({
      csvContent: csv([
        "AWB,Charge Code,Amount,Date",
        "",
        "AWB,Charge Code,Amount,Date",
        "Subtotal,,,",
        "AWB123,FWD,118,04/07/2026"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.skippedCount, 3);
    assert.equal(result.parsedCount, 1);
  });

  it("keeps skipped-only rows from becoming file exceptions", async () => {
    const { service } = makeParserHarness(validFormatPackDefinition({
      row_filters: [{ type: "subtotal_row" }]
    }));
    const result = await service.dryRunParseCsv({
      csvContent: csv([
        "AWB,Charge Code,Amount,Date",
        "",
        "AWB,Charge Code,Amount,Date",
        "Subtotal,,,"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "0"
    });

    assert.equal(result.fileStatus, "validated");
    assert.equal(result.skippedCount, 3);
    assert.equal(result.exceptionCount, 0);
  });

  it("marks duplicate parsed keys as row exceptions", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: csv([
        "AWB,Charge Code,Amount,Date",
        "AWB123,FWD,118,04/07/2026",
        "AWB123,FWD,118,04/07/2026"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "exception");
    assert.equal(result.rowResults[1]?.exceptionCode, "AMBIGUOUS_DUPLICATE");
  });

  it("excludes skipped rows before duplicate detection", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: csv([
        "AWB,Charge Code,Amount,Date",
        "AWB123,FWD,118,04/07/2026",
        "AWB,Charge Code,Amount,Date"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "validated");
    assert.equal(result.rowResults[1]?.status, "skipped");
  });

  it("marks total mismatches as file exceptions", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: standardCsv("118.00"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "999",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "exception");
    assert.equal(result.fileExceptionCode, "TOTAL_MISMATCH");
    assert.equal(result.fileTies, false);
    assert.equal(result.rawFileTotalMinor, "11800");
  });

  it("marks unresolved shipment refs as row exceptions when a resolver is supplied", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: standardCsv("118.00", "FWD", "04/07/2026", "UNKNOWN"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.rowResults[0]?.exceptionCode, "UNRESOLVED_SHIPMENT");
    assert.equal(result.fileTies, true);
    assert.equal(result.rawFileTotalMinor, "11800");
    assert.equal(result.postableTotalMinor, "0");
    assert.equal(result.fileExceptionCode, undefined);
    assert.deepEqual(result.rowExceptionCodes, ["UNRESOLVED_SHIPMENT"]);
  });

  it("parses quoted comma CSV fields", async () => {
    const { service } = makeParserHarness(validFormatPackDefinition({
      headers: {
        fingerprint: ["awb", "charge code", "amount"],
        aliases: {
          awb: ["awb"],
          charge_code: ["charge code"],
          amount: ["amount"],
          event_date: ["date"],
          description: ["description"]
        }
      },
      columns: {
        external_awb: { from: "awb", transforms: ["trim"] },
        description: { from: "description", transforms: ["trim"] },
        charge_code: { from: "charge_code", transforms: ["trim"] },
        amount_minor: { from: "amount", transforms: ["parse_paise"] },
        event_date: { from: "event_date", transforms: [{ parse_date: ["DD/MM/YYYY"] }] }
      }
    }));
    const result = await service.dryRunParseCsv({
      csvContent: csv([
        "AWB,Description,Charge Code,Amount,Date",
        "AWB123,\"Forward \"\"prepaid\"\", zone\",FWD,118,04/07/2026"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.rowResults[0]?.parsed?.description, "Forward \"prepaid\", zone");
  });

  it("handles BOMs, CRLF, header spacing, extra headers, and trailing newlines", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: "\uFEFF AWB , Charge Code , Amount , Date , Notes\r\nAWB123,FWD,118,04/07/2026,ok\r\n",
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "validated");
    assert.equal(result.rowResults[0]?.status, "resolved");
  });

  it("rejects duplicate mapped headers as ambiguous", async () => {
    const { service } = makeParserHarness();
    await assert.rejects(
      () => service.dryRunParseCsv({
        csvContent: csv([
          "AWB,Waybill,Charge Code,Amount,Date",
          "AWB123,AWB123,FWD,118,04/07/2026"
        ]),
        formatPackVersionId: "version_1"
      }),
      (error: any) => error.code === "AMBIGUOUS_HEADER"
    );
  });

  it("marks zero financial rows as exceptions after row filters", async () => {
    const { service } = makeParserHarness();
    const result = await service.dryRunParseCsv({
      csvContent: standardCsv("0"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "0",
      resolver: new FakeShipmentReferenceResolver()
    });

    assert.equal(result.fileStatus, "exception");
    assert.equal(result.rowResults[0]?.exceptionCode, "ZERO_AMOUNT");
  });

  it("preserves signed money values and total ties without double-negation", async () => {
    const definition = validFormatPackDefinition({
      charge_code_map: {
        FWD: "freight_charged",
        REFUND: "shipment_refund",
        WGT_CREDIT: "weight_dispute_credit"
      }
    });
    const { service } = makeParserHarness(definition);
    const negativeForward = await service.dryRunParseCsv({
      csvContent: standardCsv("-118.00"),
      formatPackVersionId: "version_1",
      statedTotalMinor: "-11800"
    });
    assert.equal(negativeForward.fileStatus, "validated");
    assert.equal(negativeForward.parsedTotalMinor, "-11800");

    const mixed = await service.dryRunParseCsv({
      csvContent: csv([
        "AWB,Charge Code,Amount,Date",
        "AWB123,FWD,118,04/07/2026",
        "AWB124,REFUND,(18.00),04/07/2026",
        "AWB125,WGT_CREDIT,-10.00,04/07/2026"
      ]),
      formatPackVersionId: "version_1",
      statedTotalMinor: "9000"
    });

    assert.equal(mixed.fileStatus, "validated");
    assert.equal(mixed.parsedTotalMinor, "9000");
  });

  it("does not touch wallet arrays in parser or persistence tests", async () => {
    const { service, state } = makeParserHarness();
    await service.dryRunParseCsv({
      fileId: "file_ledger_guard",
      csvContent: standardCsv(),
      formatPackVersionId: "version_1",
      statedTotalMinor: "11800",
      resolver: new FakeShipmentReferenceResolver(),
      persistStagingRows: true
    });

    assert.equal(state.ledgerA.length, 0);
    assert.equal(state.ledgerB.length, 0);
    assert.equal(state.holds.length, 0);
    assert.equal(state.balances.length, 0);
    assert.equal(state.outbox.length, 0);
  });

  it("keeps import pipeline source free of dynamic execution markers and controllers", () => {
    const moduleDir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(moduleDir).filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"));
    const forbidden = [
      ["ev", "al("].join(""),
      ["new ", "Function"].join(""),
      ["v", "m."].join(""),
      ["child", "_process"].join(""),
      ["req", "uire("].join(""),
      ["imp", "ort("].join(""),
      ["Router", "("].join("")
    ];

    for (const file of files) {
      const contents = readFileSync(join(moduleDir, file), "utf8");
      for (const marker of forbidden) {
        assert.equal(contents.includes(marker), false, `${file} contains forbidden marker`);
      }
    }
  });
});
