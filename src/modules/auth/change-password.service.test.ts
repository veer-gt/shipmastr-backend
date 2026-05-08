import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { changePasswordForAccount } from "./change-password.service.js";

function makeClient({ auditFails = false } = {}) {
  const state = {
    user: {
      id: "user_1",
      merchantId: "merchant_1",
      passwordHash: "valid-current-hash"
    },
    courierUser: {
      id: "courier_user_1",
      courierId: "courier_1",
      active: true,
      passwordHash: "valid-current-hash",
      courier: { active: true }
    },
    updates: [] as any[],
    auditLogs: [] as any[]
  };

  const client = {
    user: {
      findUnique: async ({ where }: any) => (where.id === state.user.id ? state.user : null),
      update: async ({ where, data }: any) => {
        assert.equal(where.id, state.user.id);
        state.updates.push({ model: "user", data });
        state.user = { ...state.user, ...data };
        return state.user;
      }
    },
    courierUser: {
      findUnique: async ({ where }: any) => (where.id === state.courierUser.id ? state.courierUser : null),
      update: async ({ where, data }: any) => {
        assert.equal(where.id, state.courierUser.id);
        state.updates.push({ model: "courierUser", data });
        state.courierUser = { ...state.courierUser, ...data };
        return state.courierUser;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        if (auditFails) throw new Error("audit unavailable");
        const record = { id: `audit_${state.auditLogs.length + 1}`, ...data };
        state.auditLogs.push(record);
        return record;
      }
    }
  };

  return { client: client as any, state };
}

const password = {
  compare: async (currentPassword: string, passwordHash: string) => currentPassword === "valid-current" && passwordHash === "valid-current-hash",
  hash: async (newPassword: string) => `hash:${newPassword}`
};

describe("changePasswordForAccount", () => {
  it("changes a seller/admin User password and writes PASSWORD_CHANGED audit", async () => {
    const { client, state } = makeClient();
    const result = await changePasswordForAccount(
      { kind: "USER", userId: "user_1", merchantId: "merchant_1" },
      { currentPassword: "valid-current", newPassword: "next-password" },
      { client, password }
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(state.user.passwordHash, "hash:next-password");
    assert.equal(state.updates[0]?.model, "user");
    assert.equal(state.auditLogs[0]?.action, "PASSWORD_CHANGED");
    assert.equal(state.auditLogs[0]?.merchantId, "merchant_1");
  });

  it("changes a courier password without requiring merchant scope", async () => {
    const { client, state } = makeClient();
    const result = await changePasswordForAccount(
      { kind: "COURIER", userId: "courier_user_1", courierId: "courier_1" },
      { currentPassword: "valid-current", newPassword: "courier-password" },
      { client, password }
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(state.courierUser.passwordHash, "hash:courier-password");
    assert.equal(state.updates[0]?.model, "courierUser");
    assert.equal(state.auditLogs[0]?.entityType, "courier_user");
  });

  it("rejects an invalid current password", async () => {
    const { client } = makeClient();
    await assert.rejects(
      () => changePasswordForAccount(
        { kind: "USER", userId: "user_1", merchantId: "merchant_1" },
        { currentPassword: "wrong", newPassword: "next-password" },
        { client, password }
      ),
      (err: unknown) => err instanceof HttpError && err.status === 400 && err.message === "INVALID_CURRENT_PASSWORD"
    );
  });

  it("requires the new password to differ from the current password", async () => {
    const { client } = makeClient();
    await assert.rejects(
      () => changePasswordForAccount(
        { kind: "USER", userId: "user_1", merchantId: "merchant_1" },
        { currentPassword: "same-password", newPassword: "same-password" },
        { client, password }
      ),
      (err: unknown) => err instanceof HttpError && err.status === 400 && err.message === "NEW_PASSWORD_MUST_DIFFER"
    );
  });

  it("does not fail the password change when audit logging fails", async () => {
    const { client, state } = makeClient({ auditFails: true });
    const result = await changePasswordForAccount(
      { kind: "USER", userId: "user_1", merchantId: "merchant_1" },
      { currentPassword: "valid-current", newPassword: "next-password" },
      { client, password }
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(state.user.passwordHash, "hash:next-password");
  });
});
