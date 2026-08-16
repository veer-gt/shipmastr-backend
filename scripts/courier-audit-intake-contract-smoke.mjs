import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  courierAuditIntakeRequestSchema
} from "../dist/modules/courierAuditIntake/courier-audit-intake.contract.js";
import {
  createCourierAuditIntakeSignature,
  deriveCourierAuditIdempotencyKey,
  verifyCourierAuditIntakeAuth
} from "../dist/modules/courierAuditIntake/courier-audit-intake.crypto.js";

const fixtureBytes = readFileSync(new URL("./fixtures/courier-audit-intake-v1.synthetic.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const validated = courierAuditIntakeRequestSchema.parse(fixture);
const bodyString = JSON.stringify(validated);
const bodyBuffer = Buffer.from(bodyString, "utf8");
const idempotencyKey = deriveCourierAuditIdempotencyKey(validated.source);
const timestamp = "1786795200";
const secret = "synthetic-courier-audit-intake-v1.test-signing-secret";
const signature = createCourierAuditIntakeSignature({ rawBody: bodyBuffer, timestamp, secret });
const verificationInput = { timestamp, signature, secret, nowMs: Number(timestamp) * 1000 };

if (!verifyCourierAuditIntakeAuth({ ...verificationInput, rawBody: bodyBuffer })) {
  throw new Error("same-byte signature verification failed");
}

const whitespaceMutatedBodyBuffer = Buffer.from(`${bodyString}\n`, "utf8");
if (verifyCourierAuditIntakeAuth({ ...verificationInput, rawBody: whitespaceMutatedBodyBuffer })) {
  throw new Error("whitespace-mutated signature verification unexpectedly succeeded");
}

const bodySha256 = createHash("sha256").update(bodyBuffer).digest("hex");
const idempotencySha256 = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
console.log(`courier-audit-intake-contract smoke ok bodySha256=${bodySha256} idempotencySha256=${idempotencySha256} schemaVersion=${validated.schemaVersion}`);
