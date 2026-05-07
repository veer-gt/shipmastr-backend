export const UserType = {
  INTERNAL_SHIPMASTR: "INTERNAL_SHIPMASTR",
  EXTERNAL_COURIER: "EXTERNAL_COURIER",
  EXTERNAL_MERCHANT: "EXTERNAL_MERCHANT",
} as const;

export const UserRole = {
  MASTER_ADMIN: "MASTER_ADMIN",
  ADMIN: "ADMIN",
  OPS_MANAGER: "OPS_MANAGER",
  FINANCE_MANAGER: "FINANCE_MANAGER",
  RISK_MANAGER: "RISK_MANAGER",
  COURIER_MANAGER: "COURIER_MANAGER",
  MANAGER: "MANAGER",
  SUPPORT_AGENT: "SUPPORT_AGENT",
  SUPPORT_STAFF: "SUPPORT_STAFF",
  OWNER: "OWNER",
  STAFF: "STAFF",
} as const;

export type UserType = keyof typeof UserType;
export type UserRole = keyof typeof UserRole;

export const ROLE_MATRIX = {
  INTERNAL_SHIPMASTR: [
    "MASTER_ADMIN",
    "ADMIN",
    "OPS_MANAGER",
    "FINANCE_MANAGER",
    "RISK_MANAGER",
    "COURIER_MANAGER",
    "SUPPORT_AGENT",
  ],

  EXTERNAL_COURIER: [
    "ADMIN",
    "OPS_MANAGER",
    "MANAGER",
    "SUPPORT_AGENT",
    "SUPPORT_STAFF",
  ],

  EXTERNAL_MERCHANT: [
    "ADMIN",
    "OPS_MANAGER",
    "MANAGER",
    "SUPPORT_AGENT",
    "SUPPORT_STAFF",
    "OWNER",
    "STAFF",
  ],
} as const;

export const ROLE_PERMISSIONS = {
  MASTER_ADMIN: ["platform.full_access"],

  ADMIN: [
    "account.manage",
    "users.manage",
    "orders.view",
    "shipments.manage",
    "billing.view",
    "reports.view",
  ],

  OPS_MANAGER: [
    "orders.view",
    "shipments.manage",
    "ndr.manage",
    "rto.review",
    "pickup.manage",
  ],

  FINANCE_MANAGER: [
    "cod.view",
    "payout.review",
    "invoice.manage",
    "finance.reconcile",
  ],

  RISK_MANAGER: [
    "risk.view",
    "risk.review_orders",
    "risk.manage_blacklist",
    "risk.override_decision",
  ],

  COURIER_MANAGER: [
    "courier.manage_partners",
    "courier.manage_rates",
    "webhooks.view_carrier_failures",
  ],

  MANAGER: [
    "orders.view",
    "shipments.manage",
    "reports.view",
    "team.view",
  ],

  SUPPORT_AGENT: [
    "orders.view_limited",
    "shipments.view_limited",
    "tickets.manage",
  ],

  SUPPORT_STAFF: [
    "orders.view_limited",
    "shipments.view_limited",
    "tickets.view",
  ],

  OWNER: [
    "account.manage_own",
    "users.manage_own",
    "orders.manage_own",
    "shipments.create_own",
    "cod.view_own",
    "billing.view_own",
  ],

  STAFF: [
    "orders.manage_assigned",
    "shipments.create_own",
    "cod.view_limited",
  ],
} as const;

export type Permission =
  (typeof ROLE_PERMISSIONS)[keyof typeof ROLE_PERMISSIONS][number];

export function isValidRoleForUserType(userType: UserType, role: UserRole): boolean {
  return ROLE_MATRIX[userType]?.includes(role as never) ?? false;
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return (
    ROLE_PERMISSIONS[role]?.includes("platform.full_access" as never) ||
    ROLE_PERMISSIONS[role]?.includes(permission as never)
  );
}

export function isMasterAdmin(userType?: string | null, role?: string | null): boolean {
  return userType === "INTERNAL_SHIPMASTR" && role === "MASTER_ADMIN";
}
