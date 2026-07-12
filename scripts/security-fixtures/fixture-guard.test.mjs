import assert from "node:assert/strict";
import test from "node:test";
import { scanFixtureText } from "./fixture-guard.mjs";

test("fixture guard permits reserved-domain synthetic webhook data", () => {
  assert.deepEqual(scanFixtureText(JSON.stringify({ email: "fixture@example.test", store: "fixture-shop.example.test", order: "fixture_order_001" })), []);
});

test("fixture guard reports only rule identifiers, never matched values", () => {
  const findings = scanFixtureText("Authorization: Bearer abcdefghijklmnop\nemail: real.person@not-example.invalid\nprivate: -----BEGIN PRIVATE KEY-----");
  assert.deepEqual(findings.map((finding) => finding.rule), ["bearer-token", "non-reserved-email", "private-key"]);
  assert.equal(Object.keys(findings[0] ?? {}).includes("value"), false);
});
