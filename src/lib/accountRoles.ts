export enum UserRole {
  MASTER_ADMIN = "MASTER_ADMIN",
  SELLER = "SELLER",
  COURIER = "COURIER",
  ADMIN = "ADMIN",
  MERCHANT_OWNER = "MERCHANT_OWNER",
  MERCHANT_STAFF = "MERCHANT_STAFF",
  SELLER_OWNER = "SELLER_OWNER",
  SELLER_STAFF = "SELLER_STAFF",
  COURIER_ADMIN = "COURIER_ADMIN",
  COURIER_OPS = "COURIER_OPS",
}

export enum ActorType {
  MERCHANT = "MERCHANT",
  SELLER = "SELLER",
  COURIER_PARTNER = "COURIER_PARTNER",
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
  "COURIER_PARTNER",
  "COURIER_ADMIN",
  "COURIER_OPS",
  "COURIER_MANAGER",
]);

const MERCHANT_ROLES = new Set([
  "MERCHANT",
  "MERCHANT_OWNER",
  "MERCHANT_STAFF",
]);

const SELLER_ROLES = new Set([
  "EXTERNAL_MERCHANT",
  "SELLER",
  "SELLER_OWNER",
  "SELLER_STAFF",
  "OWNER",
  "STAFF",
]);

const MERCHANT_USER_TYPES = new Set(["MERCHANT", "MERCHANT_ACCOUNT"]);
const SELLER_USER_TYPES = new Set(["EXTERNAL_MERCHANT", "SELLER", "SELLER_ACCOUNT"]);
const COURIER_USER_TYPES = new Set(["EXTERNAL_COURIER", "COURIER", "COURIER_PARTNER"]);

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

export function actorTypeForAccount(input?: {
  role?: string | null | undefined;
  userType?: string | null | undefined;
  onboardingStatus?: string | null | undefined;
  accountType?: string | null | undefined;
}) {
  const role = String(input?.role || "").toUpperCase();
  const userType = String(input?.userType || input?.accountType || "").toUpperCase();
  const onboardingStatus = String(input?.onboardingStatus || "").toUpperCase();

  if (INTERNAL_ADMIN_ROLES.has(role) || userType === "INTERNAL_SHIPMASTR") return ActorType.ADMIN;
  if (COURIER_ROLES.has(role) || COURIER_USER_TYPES.has(userType)) return ActorType.COURIER_PARTNER;
  if (MERCHANT_ROLES.has(role) || MERCHANT_USER_TYPES.has(userType)) return ActorType.MERCHANT;
  if (SELLER_ROLES.has(role) || SELLER_USER_TYPES.has(userType)) {
    return onboardingStatus === "READY_TO_SHIP" ? ActorType.MERCHANT : ActorType.SELLER;
  }

  return onboardingStatus === "READY_TO_SHIP" ? ActorType.MERCHANT : ActorType.SELLER;
}

export function canonicalRoleForAccount(input?: {
  role?: string | null | undefined;
  userType?: string | null | undefined;
  onboardingStatus?: string | null | undefined;
  accountType?: string | null | undefined;
}) {
  const role = String(input?.role || "").toUpperCase();
  const actorType = actorTypeForAccount(input);

  if (actorType === ActorType.ADMIN) return role && INTERNAL_ADMIN_ROLES.has(role) ? role : UserRole.ADMIN;
  if (actorType === ActorType.COURIER_PARTNER) {
    if (role === "COURIER_OPS" || role === "SUPPORT_STAFF") return UserRole.COURIER_OPS;
    return UserRole.COURIER_ADMIN;
  }
  if (actorType === ActorType.MERCHANT) {
    return role === "MERCHANT_STAFF" || role === "STAFF" ? UserRole.MERCHANT_STAFF : UserRole.MERCHANT_OWNER;
  }

  return role === "SELLER_STAFF" || role === "STAFF" ? UserRole.SELLER_STAFF : UserRole.SELLER_OWNER;
}

export function dashboardPathForRole(value?: string | null, input?: { onboardingStatus?: string | null | undefined; userType?: string | null | undefined; accountType?: string | null | undefined }) {
  const actorType = actorTypeForAccount({
    role: value,
    userType: input?.userType,
    onboardingStatus: input?.onboardingStatus,
    accountType: input?.accountType
  });
  const role = normalizeAccountRole(value);

  if (role === UserRole.ADMIN || actorType === ActorType.ADMIN) return "/admin/dashboard";
  if (role === UserRole.COURIER || actorType === ActorType.COURIER_PARTNER) return "/courier/dashboard";
  if (actorType === ActorType.MERCHANT) return "/merchant";

  return "/seller/dashboard";
}
