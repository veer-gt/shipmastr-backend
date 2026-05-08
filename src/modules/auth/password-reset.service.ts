import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PasswordResetPurpose, type Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { emailTemplates, sendTransactionalEmail } from "../../lib/email.js";

type Db = Prisma.TransactionClient | typeof prisma;

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FRONTEND_URL = "https://www.shipmastr.com";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function hashPasswordResetToken(token: string) {
  return createHash("sha256")
    .update(`${token}:${env.APP_SECRET_PEPPER}`)
    .digest("hex");
}

function createRawToken() {
  return randomBytes(32).toString("base64url");
}

function frontendBaseUrl() {
  const firstCorsOrigin = env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).find(Boolean);
  return (firstCorsOrigin || DEFAULT_FRONTEND_URL).replace(/\/+$/, "");
}

export function buildPasswordResetLink(token: string) {
  return `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  if (!local || !domain) return "seller account";
  const prefix = local.slice(0, 2);
  return `${prefix}${"*".repeat(Math.max(local.length - 2, 3))}@${domain}`;
}

async function createPasswordToken(input: {
  userId: string;
  purpose: PasswordResetPurpose;
  expiresAt: Date;
}, client: Db = prisma) {
  const token = createRawToken();
  const tokenHash = hashPasswordResetToken(token);

  await client.passwordResetToken.create({
    data: {
      userId: input.userId,
      tokenHash,
      purpose: input.purpose,
      expiresAt: input.expiresAt
    }
  });

  return token;
}

async function findValidToken(token: string, client: Db = prisma) {
  const tokenHash = hashPasswordResetToken(token);
  return client.passwordResetToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { merchant: true }
      }
    }
  });
}

export async function requestPasswordReset(input: { email: string }, client: Db = prisma) {
  const email = normalizeEmail(input.email);
  const user = await client.user.findUnique({
    where: { email },
    include: { merchant: true }
  });

  if (!user) {
    return { ok: true };
  }

  const token = await createPasswordToken({
    userId: user.id,
    purpose: PasswordResetPurpose.RESET,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
  }, client);
  const resetLink = buildPasswordResetLink(token);

  await audit({
    merchantId: user.merchantId,
    actorId: user.id,
    action: "PASSWORD_RESET_REQUESTED",
    entityType: "user",
    entityId: user.id,
    metadata: { email: user.email }
  }, client).catch(() => undefined);

  const template = emailTemplates.passwordReset({ resetLink, businessName: user.merchant.name });
  await sendTransactionalEmail({
    to: user.email,
    type: "password-reset",
    metadata: { userId: user.id, merchantId: user.merchantId },
    ...template
  }).catch(() => undefined);

  return { ok: true };
}

export async function verifyPasswordResetToken(input: { token: string }, client: Db = prisma) {
  const record = await findValidToken(input.token, client);
  const valid = Boolean(record && !record.usedAt && record.expiresAt.getTime() > Date.now());

  return {
    ok: true,
    valid,
    email: valid && record ? maskEmail(record.user.email) : undefined,
    purpose: valid && record ? record.purpose : undefined
  };
}

export async function resetPasswordWithToken(input: {
  token: string;
  newPassword: string;
}, client: Db = prisma) {
  const record = await findValidToken(input.token, client);
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, "INVALID_OR_EXPIRED_RESET_TOKEN");
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  const now = new Date();

  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    await (client as typeof prisma).$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash }
      });
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: now }
      });
      await audit({
        merchantId: record.user.merchantId,
        actorId: record.userId,
        action: "PASSWORD_RESET_COMPLETED",
        entityType: "user",
        entityId: record.userId,
        metadata: { purpose: record.purpose }
      }, tx).catch(() => undefined);
    });
  } else {
    await client.user.update({
      where: { id: record.userId },
      data: { passwordHash }
    });
    await client.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: now }
    });
    await audit({
      merchantId: record.user.merchantId,
      actorId: record.userId,
      action: "PASSWORD_RESET_COMPLETED",
      entityType: "user",
      entityId: record.userId,
      metadata: { purpose: record.purpose }
    }, client).catch(() => undefined);
  }

  return { ok: true };
}

export async function createSellerInvite(input: {
  userId: string;
  actorId?: string;
}, client: Db = prisma) {
  const user = await client.user.findUnique({
    where: { id: input.userId },
    include: { merchant: true }
  });

  if (!user) throw new HttpError(404, "USER_NOT_FOUND");
  if (user.userType === "INTERNAL_SHIPMASTR") throw new HttpError(400, "INVALID_INVITE_USER");

  const token = await createPasswordToken({
    userId: user.id,
    purpose: PasswordResetPurpose.INVITE,
    expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS)
  }, client);
  const inviteLink = buildPasswordResetLink(token);

  const auditInput: Parameters<typeof audit>[0] = {
    merchantId: user.merchantId,
    action: "SELLER_INVITE_CREATED",
    entityType: "user",
    entityId: user.id,
    metadata: {
      email: user.email,
      merchantId: user.merchantId
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  const template = emailTemplates.sellerInvite({
    inviteLink,
    businessName: user.merchant.name
  });
  const emailResult = await sendTransactionalEmail({
    to: user.email,
    type: "seller-invite",
    metadata: { userId: user.id, merchantId: user.merchantId },
    ...template
  }).then(() => ({ emailSent: true })).catch(() => ({ emailSent: false }));

  return {
    ok: true,
    inviteLink,
    emailSent: emailResult.emailSent,
    user: {
      id: user.id,
      email: user.email,
      merchantId: user.merchantId,
      businessName: user.merchant.name
    }
  };
}
