import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP_RE = /^(0|[1-9]\d{0,15})$/;
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/;

export function deriveCourierAuditIdempotencyKey(source: {
  provider: "GMAIL";
  accountId: string;
  messageId: string;
}): string {
  return createHash("sha256")
    .update(Buffer.from(`${source.provider}\0${source.accountId}\0${source.messageId}`, "utf8"))
    .digest("hex");
}

export function createCourierAuditIntakeSignature(input: {
  rawBody: Buffer;
  timestamp: string;
  secret: string;
}): string {
  return `sha256=${createHmac("sha256", input.secret)
    .update(Buffer.from(`${input.timestamp}.`, "ascii"))
    .update(input.rawBody)
    .digest("hex")}`;
}

export function verifyCourierAuditIntakeAuth(input: {
  rawBody?: Buffer;
  timestamp?: string;
  signature?: string;
  secret: string;
  nowMs?: number;
}): boolean {
  if (!input.rawBody || !input.timestamp || !input.signature) return false;
  if (!TIMESTAMP_RE.test(input.timestamp)) return false;

  const match = SIGNATURE_RE.exec(input.signature);
  if (!match) return false;
  const suppliedHex = match[1];
  if (!suppliedHex) return false;

  const seconds = Number(input.timestamp);
  if (!Number.isSafeInteger(seconds)) return false;

  const nowSeconds = Math.trunc((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - seconds) > 300) return false;

  const expectedHex = createCourierAuditIntakeSignature({
    rawBody: input.rawBody,
    timestamp: input.timestamp,
    secret: input.secret
  }).slice("sha256=".length);
  const expected = Buffer.from(expectedHex, "hex");
  const supplied = Buffer.from(suppliedHex, "hex");

  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
