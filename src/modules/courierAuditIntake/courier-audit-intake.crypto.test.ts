import assert from "node:assert/strict";
import test from "node:test";
import {
  createCourierAuditIntakeSignature,
  deriveCourierAuditIdempotencyKey,
  verifyCourierAuditIntakeAuth
} from "./courier-audit-intake.crypto.js";

const secret = "s".repeat(32);
const timestamp = "1786096800";
const nowMs = 1_786_096_800_000;
const compact = Buffer.from('{"a":1}', "utf8");
const spaced = Buffer.from('{ "a": 1 }', "utf8");
const signature = "sha256=0f45a96d5baaf9c1ce5ec1625d741a3e1930b5e1949621433b647f55451b908f";

test("creates the documented HMAC-SHA256 signature over ASCII timestamp, delimiter, and exact body bytes", () => {
  assert.equal(createCourierAuditIntakeSignature({ rawBody: compact, timestamp, secret }), signature);
});

test("accepts the signed compact body and rejects an otherwise equivalent spaced body", () => {
  assert.equal(verifyCourierAuditIntakeAuth({ rawBody: compact, timestamp, signature, secret, nowMs }), true);
  assert.equal(verifyCourierAuditIntakeAuth({ rawBody: spaced, timestamp, signature, secret, nowMs }), false);
});

test("rejects an absent raw body before authenticating", () => {
  assert.equal(verifyCourierAuditIntakeAuth({ timestamp, signature, secret, nowMs }), false);
});

test("rejects signature values outside the exact lowercase sha256 header format", () => {
  for (const malformed of [
    signature.replace("sha256=", "SHA256="),
    signature.replace("sha256=", "sha256:"),
    `sha256=${signature.slice("sha256=".length).toUpperCase()}`,
    `sha256=${"g".repeat(64)}`,
    `sha256=${signature.slice("sha256=".length, -2)}`,
    `${signature}00`
  ]) {
    assert.equal(verifyCourierAuditIntakeAuth({ rawBody: compact, timestamp, signature: malformed, secret, nowMs }), false);
  }
});

test("accepts only canonical unsigned Unix seconds", () => {
  const zeroSignature = createCourierAuditIntakeSignature({ rawBody: compact, timestamp: "0", secret });
  assert.equal(verifyCourierAuditIntakeAuth({ rawBody: compact, timestamp: "0", signature: zeroSignature, secret, nowMs: 0 }), true);

  for (const invalidTimestamp of ["01", "+1", "-1", "1.0", "1e3", " 1", ""]) {
    assert.equal(
      verifyCourierAuditIntakeAuth({
        rawBody: compact,
        timestamp: invalidTimestamp,
        signature: "sha256=4408847b0b2251331678c3e4c3564e34a209a2ffd680418f7a6b2defc40c014e",
        secret,
        nowMs
      }),
      false
    );
  }
});

test("rejects an unsafe timestamp even when its signature and replay time otherwise match", () => {
  const unsafeTimestamp = "9007199254740992";
  assert.equal(
    verifyCourierAuditIntakeAuth({
      rawBody: compact,
      timestamp: unsafeTimestamp,
      signature: "sha256=4408847b0b2251331678c3e4c3564e34a209a2ffd680418f7a6b2defc40c014e",
      secret,
      nowMs: Number(unsafeTimestamp) * 1000
    }),
    false
  );
});

test("accepts replay timestamps through the inclusive 300-second boundary in either direction", () => {
  const nowSeconds = Math.trunc(nowMs / 1000);
  for (const offset of [-300, -299, 299, 300]) {
    const boundaryTimestamp = String(nowSeconds + offset);
    const boundarySignature = createCourierAuditIntakeSignature({ rawBody: compact, timestamp: boundaryTimestamp, secret });
    assert.equal(
      verifyCourierAuditIntakeAuth({ rawBody: compact, timestamp: boundaryTimestamp, signature: boundarySignature, secret, nowMs }),
      true
    );
  }
});

test("rejects stale and future replay timestamps one second beyond the boundary", () => {
  const nowSeconds = Math.trunc(nowMs / 1000);
  for (const offset of [-301, 301]) {
    const boundaryTimestamp = String(nowSeconds + offset);
    const boundarySignature = createCourierAuditIntakeSignature({ rawBody: compact, timestamp: boundaryTimestamp, secret });
    assert.equal(
      verifyCourierAuditIntakeAuth({ rawBody: compact, timestamp: boundaryTimestamp, signature: boundarySignature, secret, nowMs }),
      false
    );
  }
});

test("derives the required deterministic NUL-separated Gmail source idempotency digest", () => {
  assert.equal(
    deriveCourierAuditIdempotencyKey({
      provider: "GMAIL",
      accountId: "courier-audit-inbox",
      messageId: "provider-native-message-123"
    }),
    "d00c89c6b8d56f28b5f9e843e6b37fd78b71330c54c766092148b577ec5c6be1"
  );
});
