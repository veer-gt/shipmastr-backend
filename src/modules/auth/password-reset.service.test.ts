import assert from "node:assert/strict";
import { describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { PasswordResetPurpose } from "@prisma/client";
import { hashPasswordResetToken, resetPasswordWithToken, verifyPasswordResetToken } from "./password-reset.service.js";

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
        return user ? { ...token, user } : token;
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
});
