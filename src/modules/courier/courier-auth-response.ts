import { ActorType, dashboardPathForRole, UserRole } from "../../lib/accountRoles.js";

export type CourierAuthUser = {
  id: string;
  name: string;
  email: string;
  courierId: string;
  role?: string | null;
};

export type CourierPartner = {
  id: string;
  name: string;
  code: string;
};

export function courierAuthIdentity(user: CourierAuthUser, courier: CourierPartner) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: UserRole.COURIER_ADMIN,
    canonicalRole: UserRole.COURIER_ADMIN,
    authRole: UserRole.COURIER,
    actorType: ActorType.COURIER_PARTNER,
    accountType: ActorType.COURIER_PARTNER,
    courierId: user.courierId,
    courierName: courier.name,
    courierCode: courier.code,
    dashboardPath: dashboardPathForRole(UserRole.COURIER_ADMIN)
  };
}

export function courierAuthResponse(
  user: CourierAuthUser,
  courier: CourierPartner,
  token: string
) {
  const identity = courierAuthIdentity(user, courier);
  return {
    token,
    ...identity,
    user: identity
  };
}
