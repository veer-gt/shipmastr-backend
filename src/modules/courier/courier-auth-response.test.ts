import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ActorType, UserRole } from "../../lib/accountRoles.js";
import { courierAuthIdentity, courierAuthResponse } from "./courier-auth-response.js";

const user = {
  id: "courier-user-1",
  name: "Courier Admin",
  email: "courier-admin@example.test",
  courierId: "courier-1",
  role: "COURIER_ADMIN"
};

const courier = {
  id: "courier-1",
  name: "Example Courier",
  code: "EXAMPLE"
};

describe("Courier authentication response contract", () => {
  it("uses one canonical identity for both login paths and /me", () => {
    const expected = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: UserRole.COURIER_ADMIN,
      canonicalRole: UserRole.COURIER_ADMIN,
      authRole: UserRole.COURIER,
      actorType: ActorType.COURIER_PARTNER,
      accountType: ActorType.COURIER_PARTNER,
      courierId: courier.id,
      courierName: courier.name,
      courierCode: courier.code,
      dashboardPath: "/courier/dashboard"
    };

    assert.deepEqual(courierAuthIdentity(user, courier), expected);
    assert.deepEqual(courierAuthResponse(user, courier, "token"), {
      token: "token",
      ...expected,
      user: expected
    });
  });

  it("keeps both login routes and both /me routes on the shared serializer", () => {
    const authRoutes = readFileSync("src/modules/auth/auth.routes.ts", "utf8");
    const courierRoutes = readFileSync("src/modules/courier/courier.routes.ts", "utf8");

    assert.match(authRoutes, /courierAuthResponse\(courierUser, courierUser\.courier, signCourierToken\(courierUser\)\)/);
    assert.match(authRoutes, /courierAuthIdentity\(courierUser, courierUser\.courier\)/);
    assert.match(courierRoutes, /courierAuthResponse\(courierUser, courierUser\.courier, signCourierToken\(courierUser\)\)/);
    assert.match(courierRoutes, /courierAuthIdentity\(user, user\.courier\)/);
  });
});
