export enum UserRole {
  SELLER = "SELLER",
  COURIER = "COURIER",
  ADMIN = "ADMIN",
}

const INTERNAL_ADMIN_ROLES = new Set([
  "MASTER_ADMIN",
  "ADMIN",
  "OPS_MANAGER",
  "FINANCE_MANAGER",
  "RISK_MANAGER",
  "COURIER_MANAGER",
  "SUPPORT_AGENT",
]);

const COURIER_ROLES = new Set([
  "EXTERNAL_COURIER",
  "COURIER",
  "COURIER_ADMIN",
  "COURIER_MANAGER",
]);

export function normalizeAccountRole(value?: string | null) {
  const role = String(value || "").toUpperCase();

  if (INTERNAL_ADMIN_ROLES.has(role)) return UserRole.ADMIN;
  if (COURIER_ROLES.has(role)) return UserRole.COURIER;

  return UserRole.SELLER;
}

export function isSellerRole(value?: string | null) {
  return normalizeAccountRole(value) === UserRole.SELLER;
}

export function isCourierRole(value?: string | null) {
  return normalizeAccountRole(value) === UserRole.COURIER;
}

export function isAdminRole(value?: string | null) {
  return normalizeAccountRole(value) === UserRole.ADMIN;
}

export function dashboardPathForRole(value?: string | null) {
  const role = normalizeAccountRole(value);

  if (role === UserRole.ADMIN) return "/admin/dashboard";
  if (role === UserRole.COURIER) return "/courier/dashboard";

  return "/seller/dashboard";
}
