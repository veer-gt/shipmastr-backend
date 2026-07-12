import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import test from "node:test";
import {
  DUMMY_PASSWORD_HASH,
  PASSWORD_BCRYPT_COST,
  hashPassword,
  passwordHashNeedsRehash,
  verifyPasswordAndMaybeRehash
} from "./password-hashing.js";

test("new passwords use the compliant bcrypt cost", async () => {
  const hash = await hashPassword("a password manager value");
  assert.equal(bcrypt.getRounds(hash), PASSWORD_BCRYPT_COST);
  assert.equal(passwordHashNeedsRehash(hash), false);
});

test("weak bcrypt hashes are rehashed only after successful verification", async () => {
  const weak = await bcrypt.hash("legacy-password", 4);
  const upgraded = await verifyPasswordAndMaybeRehash("legacy-password", weak);
  assert.equal(upgraded.valid, true);
  assert.ok(upgraded.replacementHash);
  assert.equal(bcrypt.getRounds(upgraded.replacementHash!), PASSWORD_BCRYPT_COST);

  const failed = await verifyPasswordAndMaybeRehash("wrong-password", weak);
  assert.equal(failed.valid, false);
  assert.equal(failed.replacementHash, null);
});

test("the dummy hash is valid and never requires a rehash", async () => {
  assert.equal(await bcrypt.compare("shipmastr-h1-dummy-password", DUMMY_PASSWORD_HASH), true);
  assert.equal(passwordHashNeedsRehash(DUMMY_PASSWORD_HASH), false);
});
