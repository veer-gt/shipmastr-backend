import assert from "node:assert/strict";
import test from "node:test";
import type { CourierAuditIntakeRequest, CourierAuditWarning } from "./courier-audit-intake.contract.js";
import { normalizeCourierAuditExtraction } from "./courier-audit-intake.normalize.js";

type Extraction = CourierAuditIntakeRequest["extraction"];

const extraction = (overrides: Partial<Extraction["result"]> = {}, warnings: CourierAuditWarning[] = []): Extraction => ({
  extractedAt: "2026-08-07T10:21:10.000Z",
  parserName: "synthetic-courier-audit-parser",
  parserVersion: "1.0.0",
  mode: "DETERMINISTIC",
  modelProvider: null,
  modelName: null,
  promptVersion: null,
  result: {
    documentKinds: ["COURIER_INVOICE"],
    invoiceNumbers: [],
    awbSamples: [],
    ...overrides
  },
  warnings,
  confidence: null
});

const warning = (index: number): CourierAuditWarning => ({
  code: `SOURCE_WARNING_${index}`,
  message: `Synthetic source warning ${index}.`,
  field: "source"
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
};

test("canonicalizes safe whitespace in bounded text and samples", () => {
  const result = normalizeCourierAuditExtraction(extraction({
    companyName: "  Synthetic\t\n Courier   Pvt. Ltd.  ",
    contactName: "  Parcel\nOperations  ",
    courierName: "  Fast\tTrack  ",
    invoiceNumbers: ["  INV\t\n001  "],
    awbSamples: ["  AWB\n  001  "],
    summary: "  Synthetic\n\n summary.  "
  }));

  assert.deepEqual(result.normalizedProjection, {
    companyName: "Synthetic Courier Pvt. Ltd.",
    contactName: "Parcel Operations",
    contactEmail: null,
    contactPhoneE164: null,
    courierName: "Fast Track",
    documentKinds: ["COURIER_INVOICE"],
    invoiceNumbers: ["INV 001"],
    billingPeriodStart: null,
    billingPeriodEnd: null,
    currency: null,
    totalBilledMinorUnits: null,
    shipmentCount: null,
    awbSamples: ["AWB 001"],
    summary: "Synthetic summary."
  });
  assert.deepEqual(result.warnings, []);
});

test("lowercases a syntactically valid email", () => {
  const result = normalizeCourierAuditExtraction(extraction({ contactEmail: "  Operations+Billing@Example.TEST  " }));

  assert.equal(result.normalizedProjection.contactEmail, "operations+billing@example.test");
  assert.deepEqual(result.warnings, []);
});

test("sets an invalid email to null and appends a bounded warning", () => {
  const result = normalizeCourierAuditExtraction(extraction({ contactEmail: "not an email" }));

  assert.equal(result.normalizedProjection.contactEmail, null);
  assert.deepEqual(result.warnings, [{
    code: "INVALID_CONTACT_EMAIL",
    message: "Contact email could not be normalized deterministically.",
    field: "contactEmail"
  }]);
});

test("normalizes only the three deterministic Indian phone forms", () => {
  for (const contactPhone of ["+919876543210", "919876543210", "9876543210"]) {
    const result = normalizeCourierAuditExtraction(extraction({ contactPhone }));
    assert.equal(result.normalizedProjection.contactPhoneE164, "+919876543210");
    assert.deepEqual(result.warnings, []);
  }
});

test("sets an ambiguous phone to null and appends a warning", () => {
  const result = normalizeCourierAuditExtraction(extraction({ contactPhone: "+1 415 555 0100" }));

  assert.equal(result.normalizedProjection.contactPhoneE164, null);
  assert.deepEqual(result.warnings, [{
    code: "AMBIGUOUS_CONTACT_PHONE",
    message: "Contact phone could not be normalized deterministically.",
    field: "contactPhone"
  }]);
});

test("uppercases exactly three-letter currencies", () => {
  const result = normalizeCourierAuditExtraction(extraction({ currency: "inr" }));

  assert.equal(result.normalizedProjection.currency, "INR");
  assert.deepEqual(result.warnings, []);
});

test("sets non-letter or non-three-letter currencies to null with a warning", () => {
  for (const currency of ["12$", "INRR"]) {
    const result = normalizeCourierAuditExtraction(extraction({ currency }));
    assert.equal(result.normalizedProjection.currency, null);
    assert.deepEqual(result.warnings, [{
      code: "INVALID_CURRENCY",
      message: "Currency could not be normalized deterministically.",
      field: "currency"
    }]);
  }
});

test("converts exact INR decimal strings to minor-unit digit strings without numeric precision loss", () => {
  const cases: Array<[string, string]> = [
    ["1234.50", "123450"],
    ["0.01", "1"],
    ["9007199254740991.99", "900719925474099199"]
  ];

  for (const [totalBilledAmount, expectedMinorUnits] of cases) {
    const result = normalizeCourierAuditExtraction(extraction({ currency: "INR", totalBilledAmount }));
    assert.equal(result.normalizedProjection.totalBilledMinorUnits, expectedMinorUnits);
    assert.deepEqual(result.warnings, []);
  }
});

test("sets invalid INR values and unsupported currency values to null with bounded warnings", () => {
  const invalidInr = normalizeCourierAuditExtraction(extraction({ currency: "INR", totalBilledAmount: "12.345" }));
  assert.equal(invalidInr.normalizedProjection.totalBilledMinorUnits, null);
  assert.deepEqual(invalidInr.warnings, [{
    code: "INVALID_INR_AMOUNT",
    message: "Billed amount could not be normalized to INR minor units deterministically.",
    field: "totalBilledAmount"
  }]);

  const unsupported = normalizeCourierAuditExtraction(extraction({ currency: "USD", totalBilledAmount: "10.00" }));
  assert.equal(unsupported.normalizedProjection.totalBilledMinorUnits, null);
  assert.deepEqual(unsupported.warnings, [{
    code: "UNSUPPORTED_CURRENCY_MINOR_UNIT_NORMALIZATION",
    message: "Minor-unit normalization is supported only for INR in V1.",
    field: "totalBilledAmount"
  }]);
});

test("sets an amount without a currency to null and appends a bounded warning", () => {
  const result = normalizeCourierAuditExtraction(extraction({ totalBilledAmount: "10.00" }));

  assert.equal(result.normalizedProjection.totalBilledMinorUnits, null);
  assert.deepEqual(result.warnings, [{
    code: "MISSING_CURRENCY_MINOR_UNIT_NORMALIZATION",
    message: "Billed amount could not be normalized because currency is missing.",
    field: "totalBilledAmount"
  }]);
});

test("preserves strict document kinds and normalized invoice and AWB samples", () => {
  const documentKinds = ["COURIER_INVOICE", "MIS", "WEIGHT_DISPUTE", "COD_REMITTANCE", "RATE_CARD", "OTHER", "UNKNOWN"] as const;
  const result = normalizeCourierAuditExtraction(extraction({
    documentKinds: [...documentKinds],
    invoiceNumbers: ["INV-001", "MIS-002"],
    awbSamples: ["AWB-001", "AWB-002"],
    billingPeriodStart: "2026-08-01",
    billingPeriodEnd: "2026-08-31",
    shipmentCount: 42
  }));

  assert.deepEqual(result.normalizedProjection.documentKinds, documentKinds);
  assert.deepEqual(result.normalizedProjection.invoiceNumbers, ["INV-001", "MIS-002"]);
  assert.deepEqual(result.normalizedProjection.awbSamples, ["AWB-001", "AWB-002"]);
  assert.equal(result.normalizedProjection.billingPeriodStart, "2026-08-01");
  assert.equal(result.normalizedProjection.billingPeriodEnd, "2026-08-31");
  assert.equal(result.normalizedProjection.shipmentCount, 42);
});

test("appends generated warnings in deterministic order and truncates at the 50-warning bound", () => {
  const fortyNineWarnings = Array.from({ length: 49 }, (_, index) => warning(index));
  const input = extraction({ contactEmail: "invalid", contactPhone: "+1 415 555 0100" }, fortyNineWarnings);
  const result = normalizeCourierAuditExtraction(input);

  assert.equal(result.warnings.length, 50);
  assert.deepEqual(result.warnings.slice(0, 49), fortyNineWarnings);
  assert.deepEqual(result.warnings[49], {
    code: "INVALID_CONTACT_EMAIL",
    message: "Contact email could not be normalized deterministically.",
    field: "contactEmail"
  });

  const full = normalizeCourierAuditExtraction(extraction({ contactEmail: "invalid" }, Array.from({ length: 50 }, (_, index) => warning(index))));
  assert.equal(full.warnings.length, 50);
  assert.deepEqual(full.warnings, Array.from({ length: 50 }, (_, index) => warning(index)));
});

test("does not mutate extraction evidence and produces identical projections for identical input", () => {
  const input = deepFreeze(extraction({
    companyName: "  Synthetic\n Courier  ",
    contactEmail: "INVALID",
    contactPhone: "+1 415 555 0100",
    currency: "USD",
    totalBilledAmount: "10.00",
    invoiceNumbers: ["  INV-001  "],
    awbSamples: ["  AWB-001  "]
  }, [warning(1)]));
  const original = structuredClone(input);

  const first = normalizeCourierAuditExtraction(input);
  const second = normalizeCourierAuditExtraction(input);

  assert.deepEqual(input, original);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first.warnings, input.warnings);
  assert.notStrictEqual(first.normalizedProjection.documentKinds, input.result.documentKinds);
  for (const generatedWarning of first.warnings.slice(1)) {
    assert.match(generatedWarning.code, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(generatedWarning.code.length <= 64);
    assert.ok(generatedWarning.message.length <= 500);
    assert.ok((generatedWarning.field?.length ?? 0) <= 128);
  }
});
