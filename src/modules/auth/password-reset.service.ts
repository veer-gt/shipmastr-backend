import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PasswordResetPurpose, type Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
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

export function buildCourierPasswordResetLink(token: string) {
  return `${frontendBaseUrl()}/courier/login?reset=${encodeURIComponent(token)}`;
}

export function buildCourierInviteLink(token: string) {
  return `${frontendBaseUrl()}/courier/login?invite=${encodeURIComponent(token)}`;
}

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  if (!local || !domain) return "seller account";
  const prefix = local.slice(0, 2);
  return `${prefix}${"*".repeat(Math.max(local.length - 2, 3))}@${domain}`;
}

async function createPasswordToken(input: {
  userId?: string;
  courierUserId?: string;
  purpose: PasswordResetPurpose;
  expiresAt: Date;
}, client: Db = prisma) {
  if (!input.userId && !input.courierUserId) {
    throw new HttpError(400, "PASSWORD_TOKEN_ACCOUNT_REQUIRED");
  }

  const token = createRawToken();
  const tokenHash = hashPasswordResetToken(token);
  const data: Prisma.PasswordResetTokenUncheckedCreateInput = {
    tokenHash,
    purpose: input.purpose,
    expiresAt: input.expiresAt
  };
  if (input.userId) data.userId = input.userId;
  if (input.courierUserId) data.courierUserId = input.courierUserId;

  await client.passwordResetToken.create({
    data
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
      },
      courierUser: {
        include: { courier: true }
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

  if (user) {
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

  const courierUser = await client.courierUser.findUnique({
    where: { email },
    include: { courier: true }
  });

  if (!courierUser) {
    return { ok: true };
  }

  const token = await createPasswordToken({
    courierUserId: courierUser.id,
    purpose: PasswordResetPurpose.RESET,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
  }, client);
  const resetLink = buildCourierPasswordResetLink(token);

  await client.auditLog.create({
    data: {
      actorId: courierUser.id,
      action: "COURIER_PASSWORD_RESET_REQUESTED",
      entityType: "courier_user",
      entityId: courierUser.id,
      metadata: {
        courierId: courierUser.courierId,
        email: courierUser.email
      }
    }
  }).catch(() => undefined);

  const template = emailTemplates.passwordReset({ resetLink, businessName: courierUser.courier.name });
  await sendTransactionalEmail({
    to: courierUser.email,
    type: "password-reset",
    metadata: { courierUserId: courierUser.id, courierId: courierUser.courierId },
    ...template
  }).catch(() => undefined);

  return { ok: true };
}

export async function verifyPasswordResetToken(input: { token: string }, client: Db = prisma) {
  const record = await findValidToken(input.token, client);
  const valid = Boolean(record && !record.usedAt && record.expiresAt.getTime() > Date.now());
  const account = valid && record?.courierUser ? "COURIER_PARTNER" : valid && record?.user ? "SELLER" : undefined;
  const email = record?.courierUser?.email || record?.user?.email;

  return {
    ok: true,
    valid,
    email: valid && email ? maskEmail(email) : undefined,
    purpose: valid && record ? record.purpose : undefined,
    accountType: account
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

  const completeReset = async (tx: Db) => {
    if (record.courierUserId) {
      await tx.courierUser.update({
        where: { id: record.courierUserId },
        data: { passwordHash }
      });
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: now }
      });
      await tx.auditLog.create({
        data: {
          actorId: record.courierUserId,
          action: "COURIER_PASSWORD_RESET_COMPLETED",
          entityType: "courier_user",
          entityId: record.courierUserId,
          metadata: {
            purpose: record.purpose,
            courierId: record.courierUser?.courierId || null
          }
        }
      }).catch(() => undefined);
      return;
    }

    if (!record.userId || !record.user) {
      throw new HttpError(400, "INVALID_OR_EXPIRED_RESET_TOKEN");
    }

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
  };

  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    await (client as typeof prisma).$transaction(async (tx) => completeReset(tx));
  } else {
    await completeReset(client);
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
  }).then(() => {
    logger.info({
      sellerInviteEmail: {
        userId: user.id,
        merchantId: user.merchantId,
        status: "sent"
      }
    }, "Seller invite email sent");
    return { emailSent: true };
  }).catch((err) => {
    logger.info({
      sellerInviteEmail: {
        userId: user.id,
        merchantId: user.merchantId,
        status: "manual_link",
        error: err instanceof Error ? err.message : "EMAIL_SEND_FAILED"
      }
    }, "Seller invite email skipped");
    return { emailSent: false };
  });

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

export async function createCourierInvite(input: {
  courierUserId: string;
  actorId?: string | undefined;
}, client: Db = prisma) {
  const courierUser = await client.courierUser.findUnique({
    where: { id: input.courierUserId },
    include: { courier: true }
  });

  if (!courierUser) throw new HttpError(404, "COURIER_USER_NOT_FOUND");

  const token = await createPasswordToken({
    courierUserId: courierUser.id,
    purpose: PasswordResetPurpose.INVITE,
    expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS)
  }, client);
  const inviteLink = buildCourierInviteLink(token);

  const auditData: Prisma.AuditLogUncheckedCreateInput = {
    action: "COURIER_INVITE_CREATED",
    entityType: "courier_user",
    entityId: courierUser.id,
    metadata: {
      courierId: courierUser.courierId,
      email: courierUser.email
    }
  };
  if (input.actorId) auditData.actorId = input.actorId;

  await client.auditLog.create({
    data: auditData
  }).catch(() => undefined);

  const template = emailTemplates.courierInvite({
    inviteLink,
    courierName: courierUser.courier.name,
    contactName: courierUser.name
  });
  const emailResult = await sendTransactionalEmail({
    to: courierUser.email,
    type: "courier-invite",
    metadata: { courierUserId: courierUser.id, courierId: courierUser.courierId },
    ...template
  }).then(() => {
    logger.info({
      courierInviteEmail: {
        courierUserId: courierUser.id,
        courierId: courierUser.courierId,
        status: "sent"
      }
    }, "Courier invite email sent");
    return { emailSent: true };
  }).catch((err) => {
    logger.info({
      courierInviteEmail: {
        courierUserId: courierUser.id,
        courierId: courierUser.courierId,
        status: "manual_link",
        error: err instanceof Error ? err.message : "EMAIL_SEND_FAILED"
      }
    }, "Courier invite email skipped");
    return { emailSent: false };
  });

  return {
    ok: true,
    inviteLink,
    emailSent: emailResult.emailSent,
    user: {
      id: courierUser.id,
      email: courierUser.email,
      courierId: courierUser.courierId,
      courierName: courierUser.courier.name
    }
  };
}
