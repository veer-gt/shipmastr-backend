import type { Request, Response, NextFunction } from "express";
import {
  hasPermission,
  isMasterAdmin,
  isValidRoleForUserType,
  type Permission,
  type UserRole,
  type UserType,
} from "./roles.js";

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user?.role || !user?.userType) {
      return res.status(401).json({ error: "UNAUTHENTICATED" });
    }

    if (!isValidRoleForUserType(user.userType as UserType, user.role as UserRole)) {
      return res.status(403).json({ error: "INVALID_ROLE_FOR_USER_TYPE" });
    }

    if (!hasPermission(user.role as UserRole, permission)) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    next();
  };
}

export function requireMasterAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;

  if (!isMasterAdmin(user?.userType, user?.role)) {
    return res.status(403).json({ error: "MASTER_ADMIN_REQUIRED" });
  }

  next();
}
