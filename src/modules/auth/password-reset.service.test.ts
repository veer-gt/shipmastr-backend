import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { PasswordResetPurpose } from "@prisma/client";
import { createCourierInvite, hashPasswordResetToken, resetPasswordWithToken, verifyPasswordResetToken } from "./password-reset.service.js";

const now = new Date("2026-05-08T13:30:00.000Z");

function makePasswordResetClient() {
  const state = {
    users: [{
      id: "user_1",
      merchantId: "merchant_1",
      email: "seller@example.com",
      passwordHash: "old_hash",
      merchant: {
        id: "merchant_1",
        name: "Skymax Store"
      }
    }] as any[],
    courierUsers: [{
      id: "courier_user_1",
      courierId: "courier_1",
      email: "ops@courier.example",
      name: "Courier Ops",
      passwordHash: "old_courier_hash",
      courier: {
        id: "courier_1",
        name: "Northline Express"
      }
    }] as any[],
    tokens: [] as any[],
    auditLogs: [] as any[]
  };

  const client = {
    $transaction: async (callback: any) => callback(client),
    passwordResetToken: {
      create: async ({ data }: any) => {
        const token = {
          id: `token_${state.tokens.length + 1}`,
          createdAt: now,
          usedAt: null,
          ...data
        };
        state.tokens.push(token);
        return token;
      },
      findUnique: async ({ where }: any) => {
        const token = state.tokens.find((item) => item.tokenHash === where.tokenHash || item.id === where.id);
        if (!token) return null;
        const user = state.users.find((item) => item.id === token.userId);
        const courierUser = state.courierUsers.find((item) => item.id === token.courierUserId);
        return { ...token, user: user || null, courierUser: courierUser || null };
      },
      update: async ({ where, data }: any) => {
        const token = state.tokens.find((item) => item.id === where.id);
        if (!token) throw new Error("TOKEN_NOT_FOUND");
        Object.assign(token, data);
        return token;
      }
    },
    user: {
      update: async ({ where, data }: any) => {
        const user = state.users.find((item) => item.id === where.id);
        if (!user) throw new Error("USER_NOT_FOUND");
        Object.assign(user, data);
        return user;
      }
    },
    courierUser: {
      findUnique: async ({ where }: any) => {
        const user = state.courierUsers.find((item) => item.id === where.id || item.email === where.email);
        return user || null;
      },
      update: async ({ where, data }: any) => {
        const user = state.courierUsers.find((item) => item.id === where.id);
        if (!user) throw new Error("COURIER_USER_NOT_FOUND");
        Object.assign(user, data);
        return user;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("password reset tokens", () => {
  it("verifies a valid invite token without exposing raw email", async () => {
    const { client, state } = makePasswordResetClient();
    const rawToken = "invite-token";
    state.tokens.push({
      id: "token_1",
      userId: "user_1",
      tokenHash: hashPasswordResetToken(rawToken),
      purpose: PasswordResetPurpose.INVITE,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: now
    });

    const result = await verifyPasswordResetToken({ token: rawToken }, client);

    assert.equal(result.valid, true);
    assert.equal(result.purpose, PasswordResetPurpose.INVITE);
    assert.equal(result.email?.includes("seller@example.com"), false);
  });

  it("resets password once and marks the token used", async () => {
    const { client, state } = makePasswordResetClient();
    const rawToken = "reset-token";
    state.tokens.push({
      id: "token_1",
      userId: "user_1",
      tokenHash: hashPasswordResetToken(rawToken),
      purpose: PasswordResetPurpose.RESET,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: now
    });

    const result = await resetPasswordWithToken({ token: rawToken, newPassword: "new-password-123" }, client);

    assert.deepEqual(result, { ok: true });
    assert.equal(await bcrypt.compare("new-password-123", state.users[0].passwordHash), true);
    assert.ok(state.tokens[0].usedAt);
    assert.equal(state.auditLogs[0]?.action, "PASSWORD_RESET_COMPLETED");
  });

  it("creates Courier Partner invite tokens and verifies them as Courier Partner accounts", async () => {
    const { client, state } = makePasswordResetClient();

    const result = await createCourierInvite({ courierUserId: "courier_user_1", actorId: "admin_1" }, client);
    const token = new URL(result.inviteLink).searchParams.get("invite") || "";

    assert.equal(result.ok, true);
    assert.equal(result.emailSent, false);
    assert.equal(state.tokens[0]?.courierUserId, "courier_user_1");
    assert.equal(state.auditLogs[0]?.action, "COURIER_INVITE_CREATED");

    const verified = await verifyPasswordResetToken({ token }, client);
    assert.equal(verified.valid, true);
    assert.equal(verified.accountType, "COURIER_PARTNER");
    assert.equal(verified.email?.includes("ops@courier.example"), false);
  });

  it("resets a courier password without touching seller users", async () => {
    const { client, state } = makePasswordResetClient();
    const rawToken = "courier-reset-token";
    state.tokens.push({
      id: "token_1",
      courierUserId: "courier_user_1",
      userId: null,
      tokenHash: hashPasswordResetToken(rawToken),
      purpose: PasswordResetPurpose.RESET,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: now
    });

    const result = await resetPasswordWithToken({ token: rawToken, newPassword: "courier-password-123" }, client);

    assert.deepEqual(result, { ok: true });
    assert.equal(await bcrypt.compare("courier-password-123", state.courierUsers[0].passwordHash), true);
    assert.equal(state.users[0].passwordHash, "old_hash");
    assert.ok(state.tokens[0].usedAt);
    assert.equal(state.auditLogs[0]?.action, "COURIER_PASSWORD_RESET_COMPLETED");
  });
});
