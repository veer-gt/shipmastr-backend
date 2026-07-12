import { env } from "../config/env.js";
import { isInternalAdminRole } from "./accountRoles.js";

export const SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL = "indraveer.chauhan@gmail.com";

function normalizeEmail(email?: string | null) {
  return String(email || "").trim().toLowerCase();
}

export function isProtectedMasterAdminEmail(email?: string | null) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const protectedEmails = new Set(
    [SHIPMASTR_OWNER_MASTER_ADMIN_EMAIL, env.ADMIN_EMAIL]
      .map(normalizeEmail)
      .filter(Boolean)
  );

  return protectedEmails.has(normalized);
}

export function isInternalMasterAdminUser(user?: {
  email?: string | null;
  role?: string | null;
  userType?: string | null;
} | null) {
  if (!user || String(user.userType || "").toUpperCase() !== "INTERNAL_SHIPMASTR") return false;
  if (String(user.role || "").toUpperCase() === "MASTER_ADMIN") return true;
  return isProtectedMasterAdminEmail(user.email);
}

export function isInternalAdminUser(user?: {
  email?: string | null;
  role?: string | null;
  userType?: string | null;
} | null) {
  return Boolean(
    user &&
    String(user.userType || "").toUpperCase() === "INTERNAL_SHIPMASTR" &&
    isInternalAdminRole(user.role)
  );
}
