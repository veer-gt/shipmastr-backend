import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { mapStagingRowToShadowLedgerCommand, parsePostingAmountMinor } from "./shadow-ledger-mapper.js";

const accounts = {
  seller: {
    shippingBalance: "wa_seller_shipping",
    codReceivable: "wa_seller_cod",
    disputeHold: "wa_seller_dispute"
  },
  courier: {
    courierPayable: "wa_courier_payable",
    courierCodDue: "wa_courier_cod"
  }
};

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    fileId: "file_1",
    rowNo: 2,
    parsed: { amount_minor: "11800", externalToken: "RAW-ONLY-REF" },
    eventClass: "freight_charged",
    shipmentId: "internal-shipment-1",
    status: "validated",
    postedEntryRef: null,
    ...overrides
  };
}

function map(overrides: Record<string, unknown> = {}) {
  return mapStagingRowToShadowLedgerCommand({
    importFile: { id: "file_1", formatPackVersionId: "fpv_1" },
    row: baseRow(overrides),
    accounts,
    createdBy: "system:w0c1-test"
  });
}

describe("W0C-1 shadow ledger mapper", () => {
  it("builds opaque deterministic shadow shipment charge commands", () => {
    const first = map();
    const second = map();

    assert.equal(first.entryRef, second.entryRef);
    assert.equal(first.command.commandHash, second.command.commandHash);
    assert.match(first.entryRef, /^W0IMP-SHIP-[a-f0-9]{24}$/);
    assert.equal(first.command.entryType, "shipment_charge");
    assert.equal(first.command.ledgerScope, "shadow");
    assert.equal(first.command.sourceType, "shipment");
    assert.match(first.command.sourceRef, /^shp_[a-f0-9]{24}$/);
    assert.equal(first.command.narrative, "W0 shadow shipment charge");
    assert.deepEqual(first.command.postings.map((posting) => [posting.accountId, posting.direction, posting.amountPaise]), [
      ["wa_seller_shipping", "debit", "11800"],
      ["wa_courier_payable", "credit", "11800"]
    ]);
    assert.equal(first.entryRef.includes("RAW-ONLY-REF"), false);
    assert.equal(first.command.sourceRef.includes("internal-shipment-1"), false);
    assert.equal(String(first.command.narrative).includes("RAW-ONLY-REF"), false);
  });

  it("uses event mapping direction rather than signed money direction", () => {
    const refund = map({
      eventClass: "shipment_refund",
      parsed: { amount_minor: "-11800" }
    });

    assert.equal(refund.command.entryType, "shipment_refund");
    assert.equal(refund.amountMinor, "11800");
    assert.deepEqual(refund.command.postings.map((posting) => [posting.accountId, posting.direction]), [
      ["wa_courier_payable", "debit"],
      ["wa_seller_shipping", "credit"]
    ]);
  });

  it("keeps RTO and return freight charge entry types distinct from shipment refunds", () => {
    assert.equal(map({ eventClass: "rto_freight_charged" }).command.entryType, "rto_freight_charge");
    assert.equal(map({ eventClass: "return_freight_charged" }).command.entryType, "return_freight_charge");
  });

  it("changes command hash when parsed payload changes", () => {
    const first = map({ parsed: { amount_minor: "11800", zone: "a" } });
    const second = map({ parsed: { amount_minor: "11900", zone: "a" } });

    assert.notEqual(first.entryRef, second.entryRef);
    assert.notEqual(first.command.commandHash, second.command.commandHash);
  });

  it("changes command hash when event or internal shipment source changes", () => {
    const first = map();
    const changedEvent = map({ eventClass: "cod_collected" });
    const changedShipment = map({ shipmentId: "internal-shipment-2" });

    assert.notEqual(first.command.commandHash, changedEvent.command.commandHash);
    assert.notEqual(first.command.commandHash, changedShipment.command.commandHash);
    assert.notEqual(first.command.sourceRef, changedShipment.command.sourceRef);
  });

  it("rejects unsupported events and unsafe amounts before ledger posting", () => {
    assert.throws(() => map({ eventClass: "deduction_unattributed" }), (error) => error instanceof ImportPipelineError && error.code === "UNATTRIBUTED_DEDUCTION_NOT_POSTED");
    assert.throws(() => map({ eventClass: "unknown" }), (error) => error instanceof ImportPipelineError && error.code === "UNKNOWN_EVENT_CLASS");
    assert.throws(() => map({ shipmentId: null }), (error) => error instanceof ImportPipelineError && error.code === "MISSING_SHIPMENT_ID");
    assert.throws(() => parsePostingAmountMinor("0", { allowNegative: false }), (error) => error instanceof ImportPipelineError && error.code === "ZERO_AMOUNT");
    assert.throws(() => parsePostingAmountMinor("abc", { allowNegative: false }), (error) => error instanceof ImportPipelineError && error.code === "BAD_AMOUNT");
    assert.throws(() => parsePostingAmountMinor("-118", { allowNegative: false }), (error) => error instanceof ImportPipelineError && error.code === "NEGATIVE_AMOUNT_UNSUPPORTED");
  });
});
