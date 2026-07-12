import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { MerchantOnboardingStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { emailTemplates, sendTransactionalEmail } from "../../lib/email.js";
import { ActorType, actorTypeForAccount, canonicalRoleForAccount, dashboardPathForRole, normalizeAccountRole, UserRole } from "../../lib/accountRoles.js";
import { isProtectedMasterAdminEmail } from "../../lib/masterAdmin.js";
import admin from "../../lib/firebase.js";
import { changePasswordForAccount, type PasswordAccount } from "./change-password.service.js";
import { requestPasswordReset, resetPasswordWithToken, verifyPasswordResetToken } from "./password-reset.service.js";

export const authRouter = Router();

const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(180).optional(),
  merchantName: z.string().trim().min(2).max(180).optional(),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128),
  name: z.string().trim().max(120).optional()
}).strict().refine((body) => body.businessName || body.merchantName, {
  path: ["businessName"],
  message: "businessName is required"
});

const requestRegistrationCodeSchema = z.object({
  businessName: z.string().trim().min(2).max(180),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128)
}).strict();

const verifyRegistrationCodeSchema = z.object({
  email: z.string().trim().email().max(320),
  code: z.string().trim().regex(/^\d{6}$/)
}).strict();

const PENDING_REGISTRATION_ACTION = "PENDING_REGISTRATION";
const PENDING_REGISTRATION_ENTITY = "auth_registration";

type PendingRegistrationPayload = {
  businessName: string;
  passwordHash: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
};

const mobileAuthSchema = z.object({
  phoneNumber: z.string().trim().min(7).max(32),
  firebaseIdToken: z.string().min(1).max(4096),
  businessName: z.string().trim().min(2).max(180).optional()
}).strict();

function signSellerToken(user: { id: string; merchantId: string; role: string }) {
  return jwt.sign(
    {
      userId: user.id,
      merchantId: user.merchantId,
      role: user.role
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function signCourierToken(user: { id: string; courierId: string; role?: string | null }) {
  return jwt.sign(
    {
      userId: user.id,
      courierId: user.courierId,
      role: UserRole.COURIER
    },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function normalizeIndianPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const mobile = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    throw new HttpError(400, "INVALID_PHONE");
  }

  return {
    mobile,
    e164: `+91${mobile}`
  };
}

function phoneSellerEmail(mobile: string) {
  return `phone-${mobile}@seller.shipmastr.local`;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function createVerificationCode() {
  return String(randomInt(100000, 1000000));
}

async function sendRegistrationCode(email: string, code: string) {
  const template = emailTemplates.verifyEmail({ code });
  await sendTransactionalEmail({
    to: email,
    type: "verify-email",
    metadata: { purpose: "seller_signup" },
    ...template
  });
}

function sellerUserResponse(
  user: { id: string; email: string; merchantId: string; role: string; userType?: string | null },
  merchant: { id: string; name: string; phone?: string | null; onboardingStatus?: MerchantOnboardingStatus | string | null }
) {
  const role = normalizeAccountRole(user.role);
  const actorType = actorTypeForAccount({
    role: user.role,
    userType: user.userType,
    onboardingStatus: merchant.onboardingStatus
  });
  const canonicalRole = canonicalRoleForAccount({
    role: user.role,
    userType: user.userType,
    onboardingStatus: merchant.onboardingStatus
  });
  const dashboardPath = role === UserRole.SELLER && actorType !== ActorType.MERCHANT && merchant.onboardingStatus !== MerchantOnboardingStatus.READY_TO_SHIP
    ? "/seller/onboarding"
    : dashboardPathForRole(canonicalRole, { onboardingStatus: merchant.onboardingStatus, userType: user.userType, accountType: actorType });
  return {
    id: user.id,
    email: user.email,
    businessName: merchant.name,
    merchantId: merchant.id,
    phoneNumber: merchant.phone || undefined,
    onboardingStatus: merchant.onboardingStatus || MerchantOnboardingStatus.PENDING,
    plan: "Lite",
    role: canonicalRole,
    accountType: actorType,
    authRole: role,
    actorType,
    canonicalRole,
    dashboardPath
  };
}

function courierUserResponse(
  user: { id: string; name: string; email: string; courierId: string; role?: string | null },
  courier: { id: string; name: string; code: string }
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: UserRole.COURIER_ADMIN,
    accountType: ActorType.COURIER_PARTNER,
    authRole: UserRole.COURIER,
    actorType: ActorType.COURIER_PARTNER,
    canonicalRole: UserRole.COURIER_ADMIN,
    courierId: user.courierId,
    courierName: courier.name,
    courierCode: courier.code,
    dashboardPath: dashboardPathForRole(UserRole.COURIER_ADMIN)
  };
}

authRouter.post("/register/request-code", async (req, res) => {
  const body = requestRegistrationCodeSchema.parse(req.body);
  const email = normalizeEmail(body.email);

  const exists = await prisma.user.findUnique({
    where: { email }
  });

  if (exists) throw new HttpError(409, "EMAIL_EXISTS");

  const code = createVerificationCode();
  const [passwordHash, codeHash] = await Promise.all([
    bcrypt.hash(body.password, 12),
    bcrypt.hash(code, 12)
  ]);

  const pendingRecord = await prisma.auditLog.create({
    data: {
      action: PENDING_REGISTRATION_ACTION,
      entityType: PENDING_REGISTRATION_ENTITY,
      entityId: email,
      metadata: {
        email,
        businessName: body.businessName,
        passwordHash,
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        attempts: 0
      }
    }
  });

  try {
    await sendRegistrationCode(email, code);
  } catch (err) {
    await prisma.auditLog.delete({ where: { id: pendingRecord.id } }).catch(() => undefined);
    throw err;
  }

  res.json({ ok: true });
});

authRouter.post("/register/verify-code", async (req, res) => {
  const body = verifyRegistrationCodeSchema.parse(req.body);
  const email = normalizeEmail(body.email);

  const pendingRecord = await prisma.auditLog.findFirst({
    where: {
      action: PENDING_REGISTRATION_ACTION,
      entityType: PENDING_REGISTRATION_ENTITY,
      entityId: email
    },
    orderBy: { createdAt: "desc" }
  });

  if (!pendingRecord) throw new HttpError(400, "CODE_NOT_FOUND");

  const pending = pendingRecord.metadata as unknown as PendingRegistrationPayload | null;
  if (!pending?.passwordHash || !pending.codeHash || !pending.expiresAt || !pending.businessName) {
    throw new HttpError(400, "CODE_NOT_FOUND");
  }

  if (new Date(pending.expiresAt).getTime() < Date.now()) {
    await prisma.auditLog.delete({ where: { id: pendingRecord.id } });
    throw new HttpError(400, "CODE_EXPIRED");
  }

  if (pending.attempts >= 5) {
    throw new HttpError(429, "TOO_MANY_CODE_ATTEMPTS");
  }

  const valid = await bcrypt.compare(body.code, pending.codeHash);
  if (!valid) {
    await prisma.auditLog.update({
      where: { id: pendingRecord.id },
      data: {
        metadata: {
          ...pending,
          attempts: (pending.attempts || 0) + 1
        }
      }
    });
    throw new HttpError(400, "INVALID_CODE");
  }

  const exists = await prisma.user.findUnique({
    where: { email }
  });

  if (exists) {
    await prisma.auditLog.delete({ where: { id: pendingRecord.id } });
    throw new HttpError(409, "EMAIL_EXISTS");
  }

  const { merchant, user } = await prisma.$transaction(async (tx) => {
    const merchant = await tx.merchant.create({
      data: {
        name: pending.businessName,
        email
      }
    });

    const user = await tx.user.create({
      data: {
        merchantId: merchant.id,
        email,
        passwordHash: pending.passwordHash,
        role: UserRole.SELLER_OWNER,
        userType: "SELLER_ACCOUNT"
      }
    });

    await tx.auditLog.delete({ where: { id: pendingRecord.id } });

    return { merchant, user };
  });

  const token = signSellerToken(user);
  const accountTemplate = emailTemplates.accountCreated({ businessName: merchant.name });
  await sendTransactionalEmail({
    to: user.email,
    type: "account-created",
    metadata: { merchantId: merchant.id, userId: user.id },
    ...accountTemplate
  });

  const responseUser = sellerUserResponse(user, merchant);

  res.status(201).json({
    token,
    role: responseUser.role,
    accountType: responseUser.accountType,
    dashboardPath: responseUser.dashboardPath,
    user: responseUser
  });
});

authRouter.post("/register", async (req, res) => {
  const body = registerSchema.parse(req.body);
  const email = normalizeEmail(body.email);

  const exists = await prisma.user.findUnique({
    where: { email }
  });

  if (exists) throw new HttpError(409, "EMAIL_EXISTS");

  const passwordHash = await bcrypt.hash(body.password, 12);
  const merchantName = body.businessName || body.merchantName!;

  const merchant = await prisma.merchant.create({
    data: {
      name: merchantName,
      email
    }
  });

  const user = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      email,
      passwordHash,
      role: UserRole.SELLER_OWNER,
      userType: "SELLER_ACCOUNT",
      ...(body.name ? { name: body.name } : {})
    }
  });

  const token = signSellerToken(user);

  const responseUser = sellerUserResponse(user, merchant);

  res.status(201).json({
    token,
    role: responseUser.role,
    accountType: responseUser.accountType,
    dashboardPath: responseUser.dashboardPath,
    merchant: {
      id: merchant.id,
      name: merchant.name
    },
    user: responseUser
  });
});

authRouter.post("/mobile", async (req, res) => {
  const body = mobileAuthSchema.parse(req.body);
  const requestedPhone = normalizeIndianPhone(body.phoneNumber);

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(body.firebaseIdToken);
  } catch (err) {
    throw new HttpError(401, "INVALID_FIREBASE_TOKEN");
  }

  const verifiedFirebasePhone = decoded.phone_number;
  if (!verifiedFirebasePhone) {
    throw new HttpError(400, "PHONE_NOT_VERIFIED");
  }

  const verifiedPhone = normalizeIndianPhone(verifiedFirebasePhone);
  if (verifiedPhone.e164 !== requestedPhone.e164) {
    throw new HttpError(400, "PHONE_MISMATCH");
  }

  const existingMerchant = await prisma.merchant.findFirst({
    where: { phone: requestedPhone.mobile },
    include: { users: { take: 1, orderBy: { createdAt: "asc" } } }
  });

  if (existingMerchant && existingMerchant.users[0]) {
    const user = existingMerchant.users[0];
    const token = signSellerToken(user);
    const responseUser = sellerUserResponse(user, existingMerchant);

    return res.json({
      token,
      role: responseUser.role,
      accountType: responseUser.accountType,
      dashboardPath: responseUser.dashboardPath,
      user: responseUser
    });
  }

  const merchantName = body.businessName || `Seller ${requestedPhone.mobile.slice(-4)}`;
  const email = phoneSellerEmail(requestedPhone.mobile);
  const passwordHash = await bcrypt.hash(`${decoded.uid}:${requestedPhone.e164}:${env.JWT_SECRET}`, 12);

  const merchant = await prisma.merchant.create({
    data: {
      name: merchantName,
      email,
      phone: requestedPhone.mobile
    }
  });

  const user = await prisma.user.create({
    data: {
      merchantId: merchant.id,
      email,
      passwordHash
    }
  });

  const token = signSellerToken(user);

  const responseUser = sellerUserResponse(user, merchant);

  return res.status(201).json({
    token,
    role: responseUser.role,
    accountType: responseUser.accountType,
    dashboardPath: responseUser.dashboardPath,
    user: responseUser
  });
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(320).optional(),
  email: z.string().trim().min(1).max(320).optional(),
  password: z.string().min(1).max(128)
}).strict().refine((body) => body.identifier || body.email, {
  path: ["identifier"],
  message: "identifier is required"
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128)
}).strict();

const requestPasswordResetSchema = z.object({
  email: z.string().trim().email().max(320)
}).strict();

const verifyResetTokenSchema = z.object({
  token: z.string().trim().min(20).max(512)
}).strict();

const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(512),
  newPassword: z.string().min(8).max(128).optional(),
  new_password: z.string().min(8).max(128).optional()
}).strict().refine((body) => body.newPassword || body.new_password, {
  path: ["newPassword"],
  message: "newPassword is required"
});

function readAuthToken(req: Request) {
  const xAuthToken = req.header("x-auth-token");
  if (xAuthToken) return xAuthToken.trim();

  const authorization = req.header("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function resolvePasswordAccount(req: Request): PasswordAccount {
  const token = readAuthToken(req);
  if (!token) throw new HttpError(401, "No token, authorization denied");

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId?: string;
      merchantId?: string;
      courierId?: string;
      role?: string;
    };
    const role = normalizeAccountRole(decoded.role);

    if (role === UserRole.COURIER) {
      if (!decoded.userId || !decoded.courierId) throw new HttpError(401, "Token is not valid");
      return {
        kind: "COURIER",
        userId: decoded.userId,
        courierId: decoded.courierId
      };
    }

    if (!decoded.userId || !decoded.merchantId) throw new HttpError(401, "Token is not valid");
    return {
      kind: "USER",
      userId: decoded.userId,
      merchantId: decoded.merchantId
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "Token is not valid");
  }
}

authRouter.post("/change-password", async (req, res) => {
  const body = changePasswordSchema.parse(req.body);
  const account = resolvePasswordAccount(req);
  const result = await changePasswordForAccount(account, body);
  res.json(result);
});

authRouter.post("/request-password-reset", async (req, res) => {
  const body = requestPasswordResetSchema.parse(req.body);
  await requestPasswordReset(body);
  res.json({ ok: true });
});

authRouter.post("/forgot-password", async (req, res) => {
  const body = requestPasswordResetSchema.parse(req.body);
  await requestPasswordReset(body);
  res.json({ ok: true, message: "If an account exists, password reset instructions will be sent." });
});

authRouter.post("/verify-reset-token", async (req, res) => {
  const body = verifyResetTokenSchema.parse(req.body);
  res.json(await verifyPasswordResetToken(body));
});

authRouter.post("/reset-password", async (req, res) => {
  const body = resetPasswordSchema.parse(req.body);
  const newPassword = body.newPassword || body.new_password!;
  res.json(await resetPasswordWithToken({ token: body.token, newPassword }));
});

authRouter.post("/login", async (req, res) => {
  const body = loginSchema.parse(req.body);
  const identifier = (body.identifier || body.email || "").trim();
  const mobile = identifier.replace(/\D/g, "");
  const normalizedEmail = normalizeEmail(identifier);

  let user = /^[6-9]\d{9}$/.test(mobile)
    ? await prisma.user.findFirst({
        where: {
          merchant: {
            phone: mobile
          }
        },
        include: { merchant: true }
      })
    : await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { merchant: true }
      });

  if (!user && !/^[6-9]\d{9}$/.test(mobile)) {
    const courierUser = await prisma.courierUser.findUnique({
      where: { email: normalizedEmail },
      include: { courier: true }
    });

    if (!courierUser || !courierUser.active || !courierUser.courier.active) {
      throw new HttpError(400, "INVALID_LOGIN");
    }

    const validCourierPassword = await bcrypt.compare(body.password, courierUser.passwordHash);
    if (!validCourierPassword) throw new HttpError(400, "INVALID_LOGIN");

    await prisma.courierUser.update({
      where: { id: courierUser.id },
      data: { lastLoginAt: new Date() }
    });

    const courierRole = UserRole.COURIER_ADMIN;
    const courierActorType = ActorType.COURIER_PARTNER;
    return res.json({
      token: signCourierToken(courierUser),
      role: courierRole,
      accountType: courierActorType,
      authRole: UserRole.COURIER,
      actorType: courierActorType,
      canonicalRole: courierRole,
      dashboardPath: dashboardPathForRole(courierRole),
      user: courierUserResponse(courierUser, courierUser.courier)
    });
  }

  if (!user) throw new HttpError(400, "INVALID_LOGIN");

  if (
    isProtectedMasterAdminEmail(user.email) &&
    (String(user.role).toUpperCase() !== "MASTER_ADMIN" || String(user.userType || "").toUpperCase() !== "INTERNAL_SHIPMASTR")
  ) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        role: "MASTER_ADMIN",
        userType: "INTERNAL_SHIPMASTR"
      },
      include: { merchant: true }
    });
  }

  const valid = await bcrypt.compare(body.password, user.passwordHash);

  if (!valid) throw new HttpError(400, "INVALID_LOGIN");

  const token = signSellerToken(user);
  const responseUser = sellerUserResponse(user, user.merchant);

  res.json({
    token,
    role: responseUser.role,
    accountType: responseUser.accountType,
    authRole: responseUser.authRole,
    actorType: responseUser.actorType,
    canonicalRole: responseUser.canonicalRole,
    dashboardPath: responseUser.dashboardPath,
    user: responseUser
  });
});

authRouter.get("/me", async (req, res) => {
  const xAuthToken = req.header("x-auth-token");
  const authorization = req.header("authorization") || "";
  const token = xAuthToken || (authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "");

  if (!token) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      merchantId?: string;
      courierId?: string;
      role?: string;
    };

    if (normalizeAccountRole(decoded.role) === UserRole.COURIER) {
      if (!decoded.courierId) return res.status(401).json({ error: "Token is not valid" });

      const courierUser = await prisma.courierUser.findUnique({
        where: { id: decoded.userId },
        include: { courier: true }
      });

      if (!courierUser?.active || !courierUser.courier.active || courierUser.courierId !== decoded.courierId) {
        return res.status(401).json({ error: "Token is not valid" });
      }

      return res.json(courierUserResponse(courierUser, courierUser.courier));
    }

    if (!decoded.merchantId) return res.status(401).json({ error: "Token is not valid" });

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { merchant: true }
    });

    if (!user) return res.status(401).json({ error: "Token is not valid" });

    return res.json({
      id: user.id,
      email: user.email,
      businessName: user.merchant.name,
      merchantId: user.merchantId,
      onboardingStatus: user.merchant.onboardingStatus,
      plan: "Lite",
      role: sellerUserResponse(user, user.merchant).role,
      accountType: sellerUserResponse(user, user.merchant).accountType,
      authRole: normalizeAccountRole(user.role),
      actorType: sellerUserResponse(user, user.merchant).actorType,
      canonicalRole: sellerUserResponse(user, user.merchant).canonicalRole,
      dashboardPath: sellerUserResponse(user, user.merchant).dashboardPath
    });
  } catch (err) {
    return res.status(401).json({ error: "Token is not valid" });
  }
});
