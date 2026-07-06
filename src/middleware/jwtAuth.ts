import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { canonicalRoleForAccount, isAdminRole, isCourierRole, normalizeAccountRole, UserRole } from "../lib/accountRoles.js";
import { isInternalMasterAdminUser } from "../lib/masterAdmin.js";
import { prisma } from "../lib/prisma.js";

type SellerJwtPayload = {
  userId: string;
  merchantId?: string;
  courierId?: string;
  role?: string;
};

function readToken(req: Request) {
  const xAuthToken = req.header("x-auth-token");
  if (xAuthToken) return xAuthToken.trim();

  const authorization = req.header("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

export function requireJwtAuth(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);

  if (!token) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as SellerJwtPayload;

    const role = normalizeAccountRole(decoded.role);
    if (!decoded.userId || !decoded.merchantId || role === UserRole.COURIER) {
      return res.status(401).json({ error: "Token is not valid" });
    }

    req.auth = {
      userId: decoded.userId,
      merchantId: decoded.merchantId,
      role
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Token is not valid" });
  }
}

export function requireAdminJwt(req: Request, res: Response, next: NextFunction) {
  return requireJwtAuth(req, res, async () => {
    if (!isAdminRole(req.auth?.role)) {
      return res.status(403).json({ error: "ADMIN_ONLY" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        merchantId: true,
        email: true,
        userType: true,
        role: true,
      },
    });

    if (!user || !isInternalMasterAdminUser(user)) {
      return res.status(403).json({ error: "INTERNAL_ADMIN_ONLY" });
    }

    req.auth = {
      userId: user.id,
      merchantId: user.merchantId,
      role: normalizeAccountRole(user.role),
    };

    next();
  });
}

export function requireMasterAdminJwt(req: Request, res: Response, next: NextFunction) {
  return requireJwtAuth(req, res, async () => {
    if (!isAdminRole(req.auth?.role)) {
      return res.status(403).json({ error: "ADMIN_ONLY" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        merchantId: true,
        email: true,
        userType: true,
        role: true,
      },
    });

    if (!user || !isInternalMasterAdminUser(user)) {
      return res.status(403).json({ error: "INTERNAL_ADMIN_ONLY" });
    }

    req.auth = {
      userId: user.id,
      merchantId: user.merchantId,
      role: canonicalRoleForAccount(user),
    };

    if (req.auth.role !== UserRole.MASTER_ADMIN) {
      return res.status(403).json({ error: "MASTER_ADMIN_ONLY" });
    }

    next();
  });
}

export async function requireCourierJwt(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);

  if (!token) {
    return res.status(401).json({ error: "No token, authorization denied" });
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as SellerJwtPayload;

    const role = normalizeAccountRole(decoded.role);
    if (!decoded.userId || !decoded.courierId || !isCourierRole(role)) {
      return res.status(401).json({ error: "Token is not valid" });
    }

    const courierUser = await prisma.courierUser.findUnique({
      where: { id: decoded.userId },
      include: { courier: true }
    });

    if (!courierUser?.active || !courierUser.courier.active || courierUser.courierId !== decoded.courierId) {
      return res.status(403).json({ error: "COURIER_ACCESS_DISABLED" });
    }

    req.auth = {
      userId: decoded.userId,
      merchantId: "",
      courierId: decoded.courierId,
      role: UserRole.COURIER
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Token is not valid" });
  }
}
