import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { courierAuditIntakeRequestSchema } from "./courier-audit-intake.contract.js";
import { audit } from "../audit/audit.service.js";
import {
  getCourierAuditIntakeDetail,
  ingestCourierAuditIntake,
  listCourierAuditIntakes
} from "./courier-audit-intake.service.js";

const MODULE_SOURCE_DIR = join(process.cwd(), "src/modules/courierAuditIntake");

const forbiddenImportPathPatterns: Array<[string, RegExp]> = [
  ["lead mutation", /(?:lead|crm)/iu],
  ["wallet or recharge mutation", /(?:wallet|recharge)/iu],
  ["payment or refund mutation", /(?:payment|refund)/iu],
  ["settlement mutation", /settlement/iu],
  ["COD remittance mutation", /cod[-_]?remittance/iu],
  ["shipment mutation", /shipment/iu],
  ["courier-provider mutation", /(?:courier[-_]?provider|provider[-_]?mutation|courier[-_]?integration)/iu],
  ["notification or messaging mutation", /(?:notification|whatsapp|email|sms|mailer)/iu]
];

const forbiddenSymbolPatterns: Array<[string, RegExp]> = [
  ["createCourierAuditLead", /\bcreateCourierAuditLead\b/u],
  ["wallet/recharge service", /\b(?:wallet|recharge)(?:Service|Repository|Client|Account)?\b/iu],
  ["payment/refund service", /\b(?:payment|refund)(?:Service|Repository|Client|Transaction)?\b/iu],
  ["settlement service", /\bsettlement(?:Service|Repository|Client|Transaction)?\b/iu],
  ["COD remittance service", /\b(?:create|update|delete|process|settle)(?:Cod|COD)?[-_]?Remittances?\b/u],
  ["shipment mutation", /\b(?:create|update|delete|cancel|book)(?:Courier)?Shipments?\b/u],
  ["courier-provider mutation", /\b(?:create|update|delete|register|disable)(?:Courier|Provider)(?:Account|Connection|Integration)?\b/u],
  ["notification/WhatsApp/email send", /\b(?:send|queue|publish)(?:Notification|WhatsApp|Email|Sms|Message)\b/u]
];

function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier) specifiers.add(specifier);
  }
  return [...specifiers];
}

function productionModuleSources(): Array<{ file: string; source: string }> {
  return readdirSync(MODULE_SOURCE_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(MODULE_SOURCE_DIR, file), "utf8") }));
}

function syntheticRequest() {
  return courierAuditIntakeRequestSchema.parse({
    schemaVersion: "courier-audit-intake.v1",
    source: {
      provider: "GMAIL",
      accountId: "courier-audit-boundary-test",
      messageId: "synthetic-message-001",
      threadId: "synthetic-thread-001",
      receivedAt: "2026-08-07T15:58:45.123Z",
      from: { name: "Synthetic Billing", email: "billing@example.test" },
      subject: "Synthetic courier invoice",
      bodySha256: "a".repeat(64),
      snippet: "Synthetic bounded snippet"
    },
    attachments: [{
      sourceAttachmentId: "synthetic-attachment-001",
      filename: "invoice.txt",
      declaredMimeType: "text/plain",
      detectedMimeType: "text/plain",
      sizeBytes: 128,
      sha256: "b".repeat(64),
      artifactKind: "TEXT",
      processingStatus: "PARSED_DETERMINISTIC",
      parser: "text-v1"
    }],
    extraction: {
      extractedAt: "2026-08-07T15:59:30.456Z",
      parserName: "synthetic-boundary-parser",
      parserVersion: "1.0.0",
      mode: "DETERMINISTIC",
      modelProvider: null,
      modelName: null,
      promptVersion: null,
      result: {
        companyName: "Synthetic Logistics",
        contactName: "Synthetic Contact",
        contactEmail: "billing@example.test",
        contactPhone: "919876543210",
        courierName: "Synthetic Courier",
        documentKinds: ["COURIER_INVOICE"],
        invoiceNumbers: ["INV-BOUNDARY-001"],
        billingPeriodStart: "2026-07-01",
        billingPeriodEnd: "2026-07-31",
        currency: "INR",
        totalBilledAmount: "100.00",
        shipmentCount: 1,
        awbSamples: ["AWB-BOUNDARY-001"],
        summary: "Synthetic boundary fixture"
      },
      warnings: [],
      confidence: 0.9
    }
  });
}

function recordingDatabase() {
  const operations: string[] = [];
  const intakeId = "00000000-0000-4000-8000-000000000011";
  const createdAt = new Date("2026-08-07T16:00:01.000Z");
  const request = syntheticRequest();
  const revision = {
    id: "00000000-0000-4000-8000-000000000012",
    createdAt,
    intakeId,
    revision: 1,
    schemaVersion: request.schemaVersion,
    parserName: request.extraction.parserName,
    parserVersion: request.extraction.parserVersion,
    mode: request.extraction.mode,
    modelProvider: null,
    modelName: null,
    promptVersion: null,
    extractedAt: new Date(request.extraction.extractedAt),
    extractionResult: request.extraction.result,
    normalizedProjection: { companyName: "Synthetic Logistics" },
    warnings: [],
    confidence: request.extraction.confidence
  };
  const intake = {
    id: intakeId,
    createdAt,
    sourceProvider: request.source.provider,
    sourceAccountId: request.source.accountId,
    providerMessageId: request.source.messageId,
    providerThreadId: request.source.threadId,
    sourceReceivedAt: new Date(request.source.receivedAt),
    senderName: request.source.from.name,
    senderEmail: request.source.from.email,
    subject: request.source.subject,
    bodySha256: request.source.bodySha256,
    bodySnippet: request.source.snippet,
    sourceFingerprintSha256: "c".repeat(64),
    attachmentManifest: request.attachments,
    revisions: [revision]
  };

  const database = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      courierAuditIntake: {
        create: async () => {
          operations.push("courierAuditIntake.create");
          return intake;
        }
      },
      courierAuditExtractionRevision: {
        create: async () => {
          operations.push("courierAuditExtractionRevision.create");
          return revision;
        }
      }
    }),
    $queryRaw: async () => {
      operations.push("courierAuditIntake.$queryRaw");
      return [{
        id: intakeId,
        sourceProvider: "GMAIL",
        sourceReceivedAt: intake.sourceReceivedAt,
        createdAt,
        senderName: intake.senderName,
        senderEmail: intake.senderEmail,
        attachmentCount: 1,
        warningCount: 0,
        companySummary: "Synthetic Logistics"
      }];
    },
    courierAuditIntake: {
      findUnique: async () => {
        operations.push("courierAuditIntake.findUnique");
        return intake;
      }
    },
    auditLog: {
      create: async () => {
        operations.push("auditLog.create");
        return { id: "audit-boundary-001", createdAt };
      }
    }
  } as any;

  return { database, operations, intakeId };
}

describe("courier audit intake no-side-effect boundary", () => {
  it("keeps production module imports and references inside the intake/audit boundary", () => {
    const violations: string[] = [];

    for (const { file, source } of productionModuleSources()) {
      for (const specifier of importSpecifiers(source)) {
        for (const [label, pattern] of forbiddenImportPathPatterns) {
          if (pattern.test(specifier)) violations.push(`${file}: import ${specifier} (${label})`);
        }
      }
      for (const [label, pattern] of forbiddenSymbolPatterns) {
        if (pattern.test(source)) violations.push(`${file}: ${label}`);
      }
    }

    assert.deepEqual(violations, []);
  });

  it("ingests and serves admin reads using only intake, revision, and audit operations", async () => {
    const { database, operations, intakeId } = recordingDatabase();
    const request = syntheticRequest();

    const ingestResult = await ingestCourierAuditIntake(request, database);
    assert.equal(ingestResult.intakeId, intakeId);
    assert.equal(ingestResult.duplicate, false);

    const list = await listCourierAuditIntakes({ limit: 25 }, database);
    assert.equal(list.items[0]?.id, intakeId);

    const detail = await getCourierAuditIntakeDetail(intakeId, database);
    assert.equal(detail?.id, intakeId);

    await audit({
      actorId: "synthetic-admin",
      action: "courier_audit_intake.detail_viewed",
      entityType: "CourierAuditIntake",
      entityId: intakeId,
      metadata: { status: "success" }
    }, database);

    assert.deepEqual(operations, [
      "courierAuditIntake.create",
      "courierAuditExtractionRevision.create",
      "courierAuditIntake.$queryRaw",
      "courierAuditIntake.findUnique",
      "auditLog.create"
    ]);
    assert.equal(operations.some((operation) => /(?:lead|wallet|recharge|payment|refund|settlement|cod|shipment|notification|whatsapp|email)/iu.test(operation)), false);
  });
});
