import assert from "node:assert/strict";
import test from "node:test";
import {
  H2A_CREATE_CONFIRMATION,
  H2A_FIXTURE_KIND,
  H2A_MERCHANT_MARKER,
  H2A_STORE_URL,
  h2aCreateSchema
} from "./h2a-staging-tenant.validation.js";

const valid = {
  fixtureType: H2A_FIXTURE_KIND,
  confirmation: H2A_CREATE_CONFIRMATION,
  merchantName: H2A_MERCHANT_MARKER,
  ownerName: "H2A Synthetic Tenant B Owner",
  email: "h2a-tenant-b-20260714T153000Z@shipmastr.invalid",
  storeUrl: H2A_STORE_URL,
  password: "a-staging-only-password-that-is-at-least-24",
  expiresInMinutes: 60
};

test("accepts only the exact synthetic tenant contract", () => {
  assert.deepEqual(h2aCreateSchema.parse(valid), valid);
});

test("rejects real domains, alternate markers, short passwords, and extras", () => {
  for (const patch of [
    { email: "real@example.com" },
    { merchantName: "Real Merchant" },
    { ownerName: "Real Owner" },
    { storeUrl: "https://real.example.com" },
    { password: "too-short" },
    { unexpected: true }
  ]) {
    assert.throws(() => h2aCreateSchema.parse({ ...valid, ...patch }));
  }
});

test("does not coerce malformed expiry values", () => {
  assert.throws(() => h2aCreateSchema.parse({ ...valid, expiresInMinutes: "60" }));
});
