import { z } from "zod";

const MAX_ATTACHMENT_SIZE_BYTES = 1_073_741_824;
const MAX_PROCESSING_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_PROCESSING_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const optionalBoundedString = (maximum: number) => z.string().max(maximum).optional();
const nullableBoundedResultString = (maximum: number) => z.string().max(maximum).nullable().optional();

export const documentKindSchema = z.enum([
  "COURIER_INVOICE",
  "MIS",
  "WEIGHT_DISPUTE",
  "COD_REMITTANCE",
  "RATE_CARD",
  "OTHER",
  "UNKNOWN"
]);

export const artifactKindSchema = z.enum(["PDF", "CSV", "XLSX", "IMAGE", "TEXT", "OTHER"]);

export const processingStatusSchema = z.enum([
  "PARSED_DETERMINISTIC",
  "PARSED_AI",
  "SKIPPED_UNSUPPORTED",
  "SKIPPED_OVERSIZE",
  "FAILED"
]);

const extractionModeSchema = z.enum(["DETERMINISTIC", "AI_ASSISTED"]);

const sourceSchema = z.object({
  provider: z.literal("GMAIL"),
  accountId: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/),
  messageId: z.string().min(1).max(512),
  threadId: optionalBoundedString(512),
  receivedAt: timestampSchema,
  from: z.object({
    name: optionalBoundedString(200),
    email: optionalBoundedString(320)
  }).strict(),
  subject: optionalBoundedString(500),
  bodySha256: sha256Schema,
  snippet: optionalBoundedString(2_000)
}).strict();

const attachmentSchema = z.object({
  sourceAttachmentId: z.string().min(1).max(512),
  filename: z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f]*$/),
  declaredMimeType: optionalBoundedString(127),
  detectedMimeType: z.string().min(1).max(127),
  sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_SIZE_BYTES),
  sha256: sha256Schema,
  artifactKind: artifactKindSchema,
  processingStatus: processingStatusSchema,
  parser: z.string().max(128).nullable().optional()
}).strict();

const warningSchema = z.object({
  code: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1).max(500),
  field: optionalBoundedString(128)
}).strict();

const extractionResultSchema = z.object({
  companyName: nullableBoundedResultString(200),
  contactName: nullableBoundedResultString(200),
  contactEmail: nullableBoundedResultString(320),
  contactPhone: nullableBoundedResultString(40),
  courierName: nullableBoundedResultString(120),
  documentKinds: z.array(documentKindSchema).max(8),
  invoiceNumbers: z.array(z.string().max(100)).max(20),
  billingPeriodStart: z.iso.date().nullable().optional(),
  billingPeriodEnd: z.iso.date().nullable().optional(),
  currency: nullableBoundedResultString(3),
  totalBilledAmount: z.string().min(1).max(40).regex(/^-?\d+(?:\.\d+)?$/).nullable().optional(),
  shipmentCount: z.number().int().min(0).max(100_000_000).nullable().optional(),
  awbSamples: z.array(z.string().max(100)).max(20),
  summary: nullableBoundedResultString(2_000)
}).strict();

const extractionSchema = z.object({
  extractedAt: timestampSchema,
  parserName: z.string().min(1).max(128),
  parserVersion: z.string().min(1).max(64),
  mode: extractionModeSchema,
  modelProvider: z.string().max(128).nullable(),
  modelName: z.string().max(128).nullable(),
  promptVersion: z.string().max(64).nullable(),
  result: extractionResultSchema,
  warnings: z.array(warningSchema).max(50),
  confidence: z.number().min(0).max(1).nullable()
}).strict();

export const courierAuditIntakeRequestSchema = z.object({
  schemaVersion: z.literal("courier-audit-intake.v1"),
  source: sourceSchema,
  attachments: z.array(attachmentSchema).max(20),
  extraction: extractionSchema
}).strict().superRefine((value, context) => {
  const { extraction } = value;

  if (extraction.mode === "DETERMINISTIC" && (
    extraction.modelProvider !== null ||
    extraction.modelName !== null ||
    extraction.promptVersion !== null
  )) {
    context.addIssue({ code: "custom", path: ["extraction"], message: "Deterministic extraction cannot declare model provenance." });
  }

  if (extraction.mode === "AI_ASSISTED" && (
    !extraction.modelProvider ||
    !extraction.modelName ||
    !extraction.promptVersion
  )) {
    context.addIssue({ code: "custom", path: ["extraction"], message: "AI-assisted extraction requires complete model provenance." });
  }

  let totalProcessingAttachmentSizeBytes = 0;
  for (const [index, attachment] of value.attachments.entries()) {
    const isParsed = attachment.processingStatus === "PARSED_DETERMINISTIC" || attachment.processingStatus === "PARSED_AI";
    if (isParsed) {
      totalProcessingAttachmentSizeBytes += attachment.sizeBytes;
    }
    if (isParsed && !attachment.parser) {
      context.addIssue({ code: "custom", path: ["attachments", index, "parser"], message: "Parsed attachments require a parser." });
    }
    if (attachment.processingStatus === "PARSED_AI" && extraction.mode !== "AI_ASSISTED") {
      context.addIssue({ code: "custom", path: ["attachments", index, "processingStatus"], message: "AI-parsed attachments require AI-assisted extraction provenance." });
    }
    if (attachment.sizeBytes > MAX_PROCESSING_ATTACHMENT_SIZE_BYTES && attachment.processingStatus !== "SKIPPED_OVERSIZE") {
      context.addIssue({ code: "custom", path: ["attachments", index, "processingStatus"], message: "Attachments over 25 MiB must be skipped as oversize." });
    }
  }

  if (totalProcessingAttachmentSizeBytes > MAX_TOTAL_PROCESSING_ATTACHMENT_SIZE_BYTES) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Processed attachments cannot exceed 50 MiB in total." });
  }
});

export type CourierAuditDocumentKind = z.infer<typeof documentKindSchema>;
export type CourierAuditAttachment = z.infer<typeof attachmentSchema>;
export type CourierAuditWarning = z.infer<typeof warningSchema>;
export type CourierAuditIntakeRequest = z.infer<typeof courierAuditIntakeRequestSchema>;

export interface CourierAuditNormalizedProjection {
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhoneE164: string | null;
  courierName: string | null;
  documentKinds: CourierAuditDocumentKind[];
  invoiceNumbers: string[];
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  currency: string | null;
  totalBilledMinorUnits: string | null;
  shipmentCount: number | null;
  awbSamples: string[];
  summary: string | null;
}
