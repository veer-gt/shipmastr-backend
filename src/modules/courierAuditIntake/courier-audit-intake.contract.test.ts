import assert from "node:assert/strict";
import test from "node:test";
import { courierAuditIntakeRequestSchema } from "./courier-audit-intake.contract.js";

const hash = "a".repeat(64);
const MiB_25 = 25 * 1024 * 1024;
const MiB_50 = 50 * 1024 * 1024;
type ProtocolValue = Record<string, unknown>;

const base = (): ProtocolValue => ({
  schemaVersion: "courier-audit-intake.v1",
  source: {
    provider: "GMAIL",
    accountId: "courier-audit-inbox-test",
    messageId: "gmail-msg-1",
    threadId: "gmail-thread-1",
    receivedAt: "2026-08-07T10:20:30.000Z",
    from: { name: "Synthetic Merchant", email: "synthetic@example.test" },
    subject: "Synthetic courier invoice",
    bodySha256: hash,
    snippet: "Synthetic data only"
  },
  attachments: [],
  extraction: {
    extractedAt: "2026-08-07T10:21:10.000Z",
    parserName: "courier-audit-intake",
    parserVersion: "1.0.0",
    mode: "DETERMINISTIC",
    modelProvider: null,
    modelName: null,
    promptVersion: null,
    result: { documentKinds: ["COURIER_INVOICE"], invoiceNumbers: [], awbSamples: [] },
    warnings: [],
    confidence: null
  }
});

const attachment = (overrides: ProtocolValue = {}): ProtocolValue => ({
  sourceAttachmentId: "gmail-part-1",
  filename: "synthetic-invoice.pdf",
  declaredMimeType: "application/pdf",
  detectedMimeType: "application/pdf",
  sizeBytes: 1024,
  sha256: hash,
  artifactKind: "PDF",
  processingStatus: "PARSED_DETERMINISTIC",
  parser: "pdf-text-v1",
  ...overrides
});

const warning = (overrides: ProtocolValue = {}): ProtocolValue => ({
  code: "AMBIGUOUS_CURRENCY",
  message: "Synthetic ambiguity only.",
  field: "currency",
  ...overrides
});

const parsed = (value: ProtocolValue): void => {
  courierAuditIntakeRequestSchema.parse(value);
};

const rejected = (value: ProtocolValue): void => {
  assert.throws(() => parsed(value));
};

const withSource = (patch: ProtocolValue): ProtocolValue => ({
  ...base(),
  source: { ...(base().source as ProtocolValue), ...patch }
});

const withExtraction = (patch: ProtocolValue): ProtocolValue => ({
  ...base(),
  extraction: { ...(base().extraction as ProtocolValue), ...patch }
});

const withResult = (patch: ProtocolValue): ProtocolValue => ({
  ...base(),
  extraction: {
    ...(base().extraction as ProtocolValue),
    result: { ...((base().extraction as ProtocolValue).result as ProtocolValue), ...patch }
  }
});

test("accepts the exact v1 contract", () => {
  assert.equal((courierAuditIntakeRequestSchema.parse(base()) as ProtocolValue).schemaVersion, "courier-audit-intake.v1");
});

test("rejects unknown protocol keys at every object boundary", () => {
  rejected({ ...base(), extra: true });
  rejected(withSource({ extra: true }));
  rejected({ ...base(), source: { ...(base().source as ProtocolValue), from: { name: "Synthetic", extra: true } } });
  rejected({ ...base(), attachments: [attachment({ extra: true })] });
  rejected(withExtraction({ extra: true }));
  rejected(withResult({ extra: true }));
  rejected(withExtraction({ warnings: [warning({ extra: true })] }));
});

test("rejects raw source bodies and attachment bytes", () => {
  rejected(withSource({ body: "raw source content" }));
  rejected({ ...base(), attachments: [attachment({ bytes: "raw attachment content" })] });
});

test("rejects malformed protocol enums instead of coercing them", () => {
  rejected(withSource({ provider: "OUTLOOK" }));
  rejected(withExtraction({ mode: "AI" }));
  rejected(withResult({ documentKinds: ["COURIER_INOVICE"] }));
  rejected({ ...base(), attachments: [attachment({ artifactKind: "DOCX" })] });
  rejected({ ...base(), attachments: [attachment({ processingStatus: "PARSED" })] });
});

test("enforces every source string bound at the limit and over it", () => {
  parsed(withSource({ accountId: "a".repeat(128) }));
  rejected(withSource({ accountId: "a".repeat(129) }));
  rejected(withSource({ accountId: "has a space" }));
  parsed(withSource({ messageId: "m".repeat(512) }));
  rejected(withSource({ messageId: "m".repeat(513) }));
  parsed(withSource({ threadId: "t".repeat(512) }));
  rejected(withSource({ threadId: "t".repeat(513) }));
  parsed({ ...base(), source: { ...(base().source as ProtocolValue), from: { name: "n".repeat(200), email: "e".repeat(320) } } });
  rejected({ ...base(), source: { ...(base().source as ProtocolValue), from: { name: "n".repeat(201) } } });
  rejected({ ...base(), source: { ...(base().source as ProtocolValue), from: { email: "e".repeat(321) } } });
  parsed(withSource({ subject: "s".repeat(500), snippet: "p".repeat(2000) }));
  rejected(withSource({ subject: "s".repeat(501) }));
  rejected(withSource({ snippet: "p".repeat(2001) }));
});

test("requires valid source hashes and timestamps without coercion", () => {
  rejected(withSource({ bodySha256: hash.toUpperCase() }));
  rejected(withSource({ bodySha256: "a".repeat(63) }));
  rejected(withSource({ receivedAt: "2026-08-07" }));
});

test("enforces attachment count and every attachment field bound", () => {
  parsed({ ...base(), attachments: Array.from({ length: 20 }, (_, index) => attachment({ sourceAttachmentId: `part-${index}` })) });
  rejected({ ...base(), attachments: Array.from({ length: 21 }, (_, index) => attachment({ sourceAttachmentId: `part-${index}` })) });
  parsed({ ...base(), attachments: [attachment({ sourceAttachmentId: "a".repeat(512), filename: "f".repeat(255), declaredMimeType: "d".repeat(127), detectedMimeType: "m".repeat(127), parser: null, sizeBytes: 1_073_741_824, processingStatus: "SKIPPED_OVERSIZE" })] });
  rejected({ ...base(), attachments: [attachment({ sourceAttachmentId: "a".repeat(513) })] });
  rejected({ ...base(), attachments: [attachment({ filename: "f".repeat(256) })] });
  rejected({ ...base(), attachments: [attachment({ filename: "unsafe\u0000name.pdf" })] });
  rejected({ ...base(), attachments: [attachment({ declaredMimeType: "d".repeat(128) })] });
  rejected({ ...base(), attachments: [attachment({ detectedMimeType: "m".repeat(128) })] });
  rejected({ ...base(), attachments: [attachment({ parser: "p".repeat(129) })] });
  rejected({ ...base(), attachments: [attachment({ sizeBytes: 1_073_741_825 })] });
  rejected({ ...base(), attachments: [attachment({ sizeBytes: -1 })] });
  rejected({ ...base(), attachments: [attachment({ sizeBytes: 1.5 })] });
  rejected({ ...base(), attachments: [attachment({ sha256: "a".repeat(63) })] });
});

test("requires only SKIPPED_OVERSIZE for attachments over 25 MiB", () => {
  parsed({ ...base(), attachments: [attachment({ sizeBytes: MiB_25, processingStatus: "PARSED_DETERMINISTIC" })] });
  parsed({ ...base(), attachments: [attachment({ sizeBytes: MiB_25 + 1, processingStatus: "SKIPPED_OVERSIZE", parser: null })] });
  for (const processingStatus of ["PARSED_DETERMINISTIC", "PARSED_AI", "SKIPPED_UNSUPPORTED", "FAILED"]) {
    rejected({ ...base(), attachments: [attachment({ sizeBytes: MiB_25 + 1, processingStatus, parser: processingStatus.startsWith("PARSED") ? "parser" : null })] });
  }
});

test("allows processed attachments totaling exactly 50 MiB", () => {
  parsed({
    ...base(),
    attachments: [
      attachment({ sourceAttachmentId: "part-1", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-2", sizeBytes: MiB_50 - MiB_25 })
    ]
  });
});

test("rejects processed attachments totaling more than 50 MiB", () => {
  rejected({
    ...base(),
    attachments: [
      attachment({ sourceAttachmentId: "part-1", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-2", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-3", sizeBytes: 1 })
    ]
  });
});

test("excludes sub-25-MiB skipped oversize attachments from the aggregate processing total", () => {
  parsed({
    ...base(),
    attachments: [
      attachment({ sourceAttachmentId: "part-1", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-2", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-3", sizeBytes: 1, processingStatus: "SKIPPED_OVERSIZE", parser: null })
    ]
  });
});

test("excludes sub-25-MiB skipped unsupported attachments from the aggregate processing total", () => {
  parsed({
    ...base(),
    attachments: [
      attachment({ sourceAttachmentId: "part-1", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-2", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-3", sizeBytes: 1, processingStatus: "SKIPPED_UNSUPPORTED", parser: null })
    ]
  });
});

test("counts failed attachments toward the aggregate processing total", () => {
  rejected({
    ...base(),
    attachments: [
      attachment({ sourceAttachmentId: "part-1", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-2", sizeBytes: MiB_25 }),
      attachment({ sourceAttachmentId: "part-3", sizeBytes: MiB_25, processingStatus: "FAILED", parser: null })
    ]
  });
});

test("enforces parsed attachment parser and AI message provenance invariants", () => {
  rejected({ ...base(), attachments: [attachment({ parser: null })] });
  rejected({ ...base(), attachments: [attachment({ processingStatus: "PARSED_AI", parser: "ai-parser" })] });
  parsed({ ...base(), attachments: [attachment({ processingStatus: "SKIPPED_UNSUPPORTED", parser: null }), attachment({ processingStatus: "FAILED", parser: null })] });
  parsed({
    ...base(),
    attachments: [attachment({ processingStatus: "PARSED_AI", parser: "ai-parser" })],
    extraction: {
      ...(base().extraction as ProtocolValue),
      mode: "AI_ASSISTED",
      modelProvider: "synthetic-model-provider",
      modelName: "synthetic-model",
      promptVersion: "prompt-v1"
    }
  });
});

test("enforces deterministic and AI-assisted model provenance cross-fields", () => {
  rejected(withExtraction({ modelProvider: "not-allowed" }));
  for (const missing of ["modelProvider", "modelName", "promptVersion"]) {
    const extraction: ProtocolValue = {
      ...(base().extraction as ProtocolValue),
      mode: "AI_ASSISTED",
      modelProvider: "provider",
      modelName: "model",
      promptVersion: "prompt-v1",
      [missing]: null
    };
    rejected({ ...base(), extraction });
  }
  parsed(withExtraction({ mode: "AI_ASSISTED", modelProvider: "p".repeat(128), modelName: "m".repeat(128), promptVersion: "v".repeat(64) }));
  rejected(withExtraction({ mode: "AI_ASSISTED", modelProvider: "p".repeat(129), modelName: "model", promptVersion: "v1" }));
  rejected(withExtraction({ mode: "AI_ASSISTED", modelProvider: "provider", modelName: "m".repeat(129), promptVersion: "v1" }));
  rejected(withExtraction({ mode: "AI_ASSISTED", modelProvider: "provider", modelName: "model", promptVersion: "v".repeat(65) }));
});

test("enforces result string and array bounds at the limit and over it", () => {
  parsed(withResult({ companyName: "c".repeat(200), contactName: "n".repeat(200), contactEmail: "e".repeat(320), contactPhone: "p".repeat(40), courierName: "r".repeat(120), currency: "USD", totalBilledAmount: "1".repeat(40), summary: "s".repeat(2000) }));
  const overLimitStrings: Array<[string, string]> = [["companyName", "c".repeat(201)], ["contactName", "n".repeat(201)], ["contactEmail", "e".repeat(321)], ["contactPhone", "p".repeat(41)], ["courierName", "r".repeat(121)], ["currency", "USDD"], ["totalBilledAmount", "1".repeat(41)], ["summary", "s".repeat(2001)]];
  for (const [key, value] of overLimitStrings) {
    rejected(withResult({ [key]: value }));
  }
  parsed(withResult({ documentKinds: Array.from({ length: 8 }, () => "OTHER"), invoiceNumbers: Array.from({ length: 20 }, () => "i".repeat(100)), awbSamples: Array.from({ length: 20 }, () => "a".repeat(100)), shipmentCount: 100_000_000, billingPeriodStart: "2026-08-01", billingPeriodEnd: "2026-08-31" }));
  rejected(withResult({ documentKinds: Array.from({ length: 9 }, () => "OTHER") }));
  rejected(withResult({ invoiceNumbers: Array.from({ length: 21 }, () => "invoice") }));
  rejected(withResult({ invoiceNumbers: ["i".repeat(101)] }));
  rejected(withResult({ awbSamples: Array.from({ length: 21 }, () => "awb") }));
  rejected(withResult({ awbSamples: ["a".repeat(101)] }));
  rejected(withResult({ shipmentCount: 100_000_001 }));
  rejected(withResult({ shipmentCount: -1 }));
  rejected(withResult({ shipmentCount: 1.5 }));
  rejected(withResult({ billingPeriodStart: "2026-8-1" }));
  rejected(withResult({ billingPeriodEnd: "2026-02-30" }));
});

test("enforces warning count and every warning string bound", () => {
  parsed(withExtraction({ warnings: Array.from({ length: 50 }, () => warning({ code: "W".repeat(64), message: "m".repeat(500), field: "f".repeat(128) })) }));
  rejected(withExtraction({ warnings: Array.from({ length: 51 }, () => warning()) }));
  rejected(withExtraction({ warnings: [warning({ code: "W".repeat(65) })] }));
  rejected(withExtraction({ warnings: [warning({ code: "not_uppercase" })] }));
  rejected(withExtraction({ warnings: [warning({ message: "m".repeat(501) })] }));
  rejected(withExtraction({ warnings: [warning({ field: "f".repeat(129) })] }));
});

test("enforces extraction timestamps, parser bounds, and confidence range", () => {
  parsed(withExtraction({ parserName: "n".repeat(128), parserVersion: "v".repeat(64), confidence: 0 }));
  parsed(withExtraction({ confidence: 1 }));
  rejected(withExtraction({ extractedAt: "not-a-timestamp" }));
  rejected(withExtraction({ parserName: "" }));
  rejected(withExtraction({ parserName: "n".repeat(129) }));
  rejected(withExtraction({ parserVersion: "" }));
  rejected(withExtraction({ parserVersion: "v".repeat(65) }));
  rejected(withExtraction({ confidence: -0.01 }));
  rejected(withExtraction({ confidence: 1.01 }));
});
