import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("login cannot reconcile or mutate the protected owner role before or after password verification", async () => {
  const source = await readFile("src/modules/auth/auth.routes.ts", "utf8");
  const start = source.indexOf('authRouter.post("/login"');
  const end = source.indexOf('authRouter.get("/me"', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const login = source.slice(start, end);

  assert.match(login, /verifyPasswordAndMaybeRehash\(body\.password,\s*user\.passwordHash\)/);
  assert.doesNotMatch(login, /isProtectedMasterAdminEmail/);
  assert.doesNotMatch(login, /role:\s*"MASTER_ADMIN"/);
  assert.doesNotMatch(login, /userType:\s*"INTERNAL_SHIPMASTR"/);
  assert.doesNotMatch(login, /SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL/);
});

test("the auth route no longer imports the protected-email helper", async () => {
  const source = await readFile("src/modules/auth/auth.routes.ts", "utf8");
  assert.doesNotMatch(source, /import\s*\{\s*isProtectedMasterAdminEmail\s*\}/);
});
