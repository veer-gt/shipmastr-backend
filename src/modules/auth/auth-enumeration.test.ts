import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public auth routes keep unknown-account work and generic responses", async () => {
  const source = await readFile("src/modules/auth/auth.routes.ts", "utf8");
  assert.match(source, /verifyPassword\(body\.password, DUMMY_PASSWORD_HASH\)/);
  assert.match(source, /throw new HttpError\(400, "INVALID_LOGIN"\)/);
  assert.match(source, /return res\.json\(\{ ok: true \}\)/);
  assert.match(source, /return res\.status\(202\)\.json\(\{ ok: true \}\)/);
});

test("password reset has a neutral unknown-account path", async () => {
  const source = await readFile("src/modules/auth/password-reset.service.ts", "utf8");
  assert.match(source, /verifyPassword\(email, DUMMY_PASSWORD_HASH\)/);
  assert.match(source, /return \{ ok: true \}/);
});
