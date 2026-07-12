import type { Prisma } from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { hashPassword, verifyPassword } from "./password-hashing.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type PasswordAccount =
  | {
      kind: "USER";
      userId: string;
      merchantId: string;
    }
  | {
      kind: "COURIER";
      userId: string;
      courierId: string;
    };

export type ChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
};

type PasswordHasher = {
  compare(currentPassword: string, passwordHash: string): Promise<boolean>;
  hash(newPassword: string): Promise<string>;
};

type ChangePasswordDeps = {
  client?: Db;
  password?: PasswordHasher;
};

const defaultPassword: PasswordHasher = {
  compare: verifyPassword,
  hash: hashPassword
};

async function writePasswordChangedAudit(account: PasswordAccount, client: Db) {
  try {
    const input = {
      actorId: account.userId,
      action: "PASSWORD_CHANGED",
      entityType: account.kind === "USER" ? "user" : "courier_user",
      entityId: account.userId,
      metadata: {
        accountKind: account.kind
      },
      ...(account.kind === "USER" ? { merchantId: account.merchantId } : {})
    };

    await audit(
      input,
      client
    );
  } catch (err) {
    logger.warn({ err, accountKind: account.kind, actorId: account.userId }, "Password change audit log failed");
  }
}

export async function changePasswordForAccount(
  account: PasswordAccount,
  input: ChangePasswordInput,
  deps: ChangePasswordDeps = {}
) {
  if (input.currentPassword === input.newPassword) {
    throw new HttpError(400, "NEW_PASSWORD_MUST_DIFFER");
  }

  const client = deps.client || prisma;
  const password = deps.password || defaultPassword;

  if (account.kind === "COURIER") {
    const courierUser = await client.courierUser.findUnique({
      where: { id: account.userId },
      select: {
        id: true,
        courierId: true,
        active: true,
        passwordHash: true,
        courier: {
          select: { active: true }
        }
      }
    });

    if (!courierUser || courierUser.courierId !== account.courierId || !courierUser.active || !courierUser.courier.active) {
      throw new HttpError(401, "Token is not valid");
    }

    const valid = await password.compare(input.currentPassword, courierUser.passwordHash);
    if (!valid) throw new HttpError(400, "INVALID_CURRENT_PASSWORD");

    const passwordHash = await password.hash(input.newPassword);
    await client.courierUser.update({
      where: { id: courierUser.id },
      data: { passwordHash }
    });

    await writePasswordChangedAudit(account, client);
    return { ok: true };
  }

  const user = await client.user.findUnique({
    where: { id: account.userId },
    select: {
      id: true,
      merchantId: true,
      passwordHash: true
    }
  });

  if (!user || user.merchantId !== account.merchantId) {
    throw new HttpError(401, "Token is not valid");
  }

  const valid = await password.compare(input.currentPassword, user.passwordHash);
  if (!valid) throw new HttpError(400, "INVALID_CURRENT_PASSWORD");

  const passwordHash = await password.hash(input.newPassword);
  await client.user.update({
    where: { id: user.id },
    data: { passwordHash }
  });

  await writePasswordChangedAudit(account, client);
  return { ok: true };
}
