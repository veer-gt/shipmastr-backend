import { createHash } from "node:crypto";
import type { CourierAuditIntakeRequest } from "./courier-audit-intake.contract.js";

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
    [...request.attachments]
      .sort((left, right) => left.sourceAttachmentId.localeCompare(right.sourceAttachmentId) || left.filename.localeCompare(right.filename))
      .map((attachment) => [
        attachment.sourceAttachmentId,
        attachment.filename,
        attachment.declaredMimeType ?? null,
        attachment.sizeBytes,
        attachment.sha256
      ])
  ];

  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
