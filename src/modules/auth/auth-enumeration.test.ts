import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { neutralPublicRegistrationResponse } from "./public-auth-response.js";

test("existing public registration uses the exact neutral response body", () => {
  assert.deepEqual(neutralPublicRegistrationResponse(), { ok: true });
  assert.equal(Object.keys(neutralPublicRegistrationResponse()).length, 1);
});

test("public auth routes keep unknown-account work and generic responses", async () => {
  const source = await readFile("src/modules/auth/auth.routes.ts", "utf8");
  assert.match(source, /verifyPassword\(body\.password, DUMMY_PASSWORD_HASH\)/);
  assert.match(source, /throw new HttpError\(400, "INVALID_LOGIN"\)/);
  assert.match(source, /neutralPublicRegistrationResponse\(\)/);
  assert.match(source, /public self-service endpoint/);
  assert.doesNotMatch(source, /legacy direct-registration endpoint returns an account conflict/);
});

test("password reset has a neutral unknown-account path", async () => {
  const source = await readFile("src/modules/auth/password-reset.service.ts", "utf8");
  assert.match(source, /verifyPassword\(email, DUMMY_PASSWORD_HASH\)/);
  assert.match(source, /return \{ ok: true \}/);
});
