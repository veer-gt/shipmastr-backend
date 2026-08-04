import assert from "node:assert/strict";
import test from "node:test";

import {
  isInternalMasterAdminUser,
  isProtectedMasterAdminEmail,
  SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL
} from "./masterAdmin.js";

test("recognizes the permanent Shipmastr owner email exactly and case-insensitively", () => {
  assert.equal(isProtectedMasterAdminEmail(SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL), true);
  assert.equal(isProtectedMasterAdminEmail("  INDRAVEER.CHAUHAN@GMAIL.COM  "), true);
  assert.equal(isProtectedMasterAdminEmail("attacker@example.com"), false);
});

test("Master Admin authorization requires the persisted internal type and exact role", () => {
  assert.equal(isInternalMasterAdminUser({
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    userType: "INTERNAL_SHIPMASTR",
    role: "MASTER_ADMIN"
  }), true);

  assert.equal(isInternalMasterAdminUser({
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    userType: "INTERNAL_SHIPMASTR",
    role: "ADMIN"
  }), false);

  assert.equal(isInternalMasterAdminUser({
    email: SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL,
    userType: "SELLER_ACCOUNT",
    role: "MASTER_ADMIN"
  }), false);
});
