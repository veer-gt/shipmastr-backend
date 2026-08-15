import assert from "node:assert/strict";
import test from "node:test";
import type { CourierAuditIntakeRequest } from "./courier-audit-intake.contract.js";
import { deriveCourierAuditSourceFingerprint } from "./courier-audit-intake.fingerprint.js";

const expectedFingerprint = "4bec7350d04c972da6ad8b783097b01e7d362d8568bf2703b32fc94f942c9588";

function requestWithAttachments(attachments: CourierAuditIntakeRequest["attachments"]): CourierAuditIntakeRequest {
  return {
    schemaVersion: "courier-audit-intake.v1",
    source: {
      provider: "GMAIL",
      accountId: "courier-audit-inbox@example.test",
      messageId: "provider-message-0001",
      threadId: "thread-0001",
      receivedAt: "2026-08-07T12:34:56.000Z",
      from: {
        email: "sender@example.test",
        name: "Synthetic Sender"
      },
      subject: "Synthetic courier audit",
      bodySha256: "a".repeat(64),
      snippet: "This source field is intentionally excluded."
    },
    attachments,
    extraction: {
      extractedAt: "2026-08-07T12:35:00.000Z",
      parserName: "deterministic-parser",
      parserVersion: "v1",
      mode: "DETERMINISTIC",
      modelProvider: null,
      modelName: null,
      promptVersion: null,
      result: {
        companyName: "Synthetic Courier",
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        courierName: null,
        documentKinds: [],
        invoiceNumbers: [],
        billingPeriodStart: null,
        billingPeriodEnd: null,
        currency: null,
        totalBilledAmount: null,
        shipmentCount: null,
        awbSamples: [],
        summary: null
      },
      warnings: [],
      confidence: 1
    }
  };
}

function attachment(overrides: Partial<CourierAuditIntakeRequest["attachments"][number]>): CourierAuditIntakeRequest["attachments"][number] {
  return {
    sourceAttachmentId: "attachment-z",
    filename: "zeta.csv",
    declaredMimeType: "text/csv",
    detectedMimeType: "text/csv",
    sizeBytes: 456,
    sha256: "c".repeat(64),
    artifactKind: "CSV",
    processingStatus: "PARSED_DETERMINISTIC",
    parser: "csv-parser",
    ...overrides
  };
}

function fixture(): CourierAuditIntakeRequest {
  return requestWithAttachments([
    attachment({ sourceAttachmentId: "attachment-z", filename: "zeta.csv", declaredMimeType: "text/csv", sizeBytes: 456, sha256: "c".repeat(64) }),
    attachment({ sourceAttachmentId: "attachment-a", filename: "omega.pdf", declaredMimeType: "application/pdf", sizeBytes: 789, sha256: "d".repeat(64) }),
    attachment({ sourceAttachmentId: "attachment-a", filename: "alpha.pdf", declaredMimeType: "application/pdf", sizeBytes: 123, sha256: "b".repeat(64) })
  ]);
}

test("uses the fixed canonical tuple hash and sorts attachments by sourceAttachmentId then filename", () => {
  const outOfOrder = fixture();
  const canonicalOrder = requestWithAttachments([...outOfOrder.attachments].sort((left, right) =>
    left.sourceAttachmentId.localeCompare(right.sourceAttachmentId) || left.filename.localeCompare(right.filename)
  ));

  assert.equal(deriveCourierAuditSourceFingerprint(outOfOrder), expectedFingerprint);
  assert.equal(deriveCourierAuditSourceFingerprint(canonicalOrder), expectedFingerprint);
});

test("excludes extraction, model provenance, schema version, and processing-derived fields", () => {
  const original = fixture();
  const changes: Array<(value: CourierAuditIntakeRequest) => void> = [
    (value) => { Reflect.set(value, "schemaVersion", "another-schema-version"); },
    (value) => { value.extraction.extractedAt = "2026-08-08T12:35:00.000Z"; },
    (value) => { value.extraction.parserName = "another-parser"; },
    (value) => { value.extraction.parserVersion = "v99"; },
    (value) => {
      value.extraction.mode = "AI_ASSISTED";
      value.extraction.modelProvider = "synthetic-provider";
      value.extraction.modelName = "synthetic-model";
      value.extraction.promptVersion = "prompt-v2";
    },
    (value) => { value.extraction.result.companyName = "Changed extraction result"; },
    (value) => { value.extraction.warnings = [{ code: "SYNTHETIC_WARNING", message: "Changed warning" }]; },
    (value) => { value.extraction.confidence = 0.25; },
    (value) => { value.attachments[0]!.detectedMimeType = "application/octet-stream"; },
    (value) => { value.attachments[0]!.artifactKind = "OTHER"; },
    (value) => { value.attachments[0]!.processingStatus = "SKIPPED_UNSUPPORTED"; },
    (value) => { value.attachments[0]!.parser = null; }
  ];

  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.equal(deriveCourierAuditSourceFingerprint(changed), expectedFingerprint);
  }
});

test("changes the fingerprint for every approved immutable source and attachment metadata field", () => {
  const original = fixture();
  const changes: Array<(value: CourierAuditIntakeRequest) => void> = [
    (value) => { Reflect.set(value.source, "provider", "OUTLOOK"); },
    (value) => { value.source.accountId = "other-inbox@example.test"; },
    (value) => { value.source.messageId = "provider-message-0002"; },
    (value) => { value.source.threadId = "thread-0002"; },
    (value) => { value.source.receivedAt = "2026-08-08T12:34:56.000Z"; },
    (value) => { value.source.from.email = "other-sender@example.test"; },
    (value) => { value.source.from.name = "Other Sender"; },
    (value) => { value.source.subject = "Other subject"; },
    (value) => { value.source.bodySha256 = "e".repeat(64); },
    (value) => { value.attachments[0]!.sourceAttachmentId = "attachment-y"; },
    (value) => { value.attachments[0]!.filename = "other.csv"; },
    (value) => { value.attachments[0]!.declaredMimeType = "application/octet-stream"; },
    (value) => { value.attachments[0]!.sizeBytes = 457; },
    (value) => { value.attachments[0]!.sha256 = "e".repeat(64); }
  ];

  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.notEqual(deriveCourierAuditSourceFingerprint(changed), expectedFingerprint);
  }
});
