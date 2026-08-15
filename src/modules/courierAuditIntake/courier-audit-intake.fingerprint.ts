import { createHash } from "node:crypto";
import type { CourierAuditIntakeRequest } from "./courier-audit-intake.contract.js";

type CanonicalAttachmentTuple = [string, string, string | null, number, string];

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareStrings(left, right);
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalAttachmentTuple(attachment: CourierAuditIntakeRequest["attachments"][number]): CanonicalAttachmentTuple {
  return [
    attachment.sourceAttachmentId,
    attachment.filename,
    attachment.declaredMimeType ?? null,
    attachment.sizeBytes,
    attachment.sha256
  ];
}

function compareCanonicalAttachmentTuples(left: CanonicalAttachmentTuple, right: CanonicalAttachmentTuple): number {
  return compareStrings(left[0], right[0]) ||
    compareStrings(left[1], right[1]) ||
    compareNullableStrings(left[2], right[2]) ||
    compareNumbers(left[3], right[3]) ||
    compareStrings(left[4], right[4]);
}

export function deriveCourierAuditSourceFingerprint(request: CourierAuditIntakeRequest): string {
  const canonical = [
    request.source.provider,
    request.source.accountId,
    request.source.messageId,
    request.source.threadId ?? null,
    request.source.receivedAt,
    request.source.from.email ?? null,
    request.source.from.name ?? null,
    request.source.subject ?? null,
    request.source.bodySha256,
    request.attachments
      .map(canonicalAttachmentTuple)
      .sort(compareCanonicalAttachmentTuples)
  ];

  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
