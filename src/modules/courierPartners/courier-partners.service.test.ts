import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CourierPartnerStatus,
  PartnerType,
  SellerCourierPartnerStatus,
  ShipmentSegment
} from "@prisma/client";
import {
  autoEnableCourierPartnersMessage,
  autoEnableCourierPartners,
  defaultSystemCourierPartnerSeed,
  getInternalCourierPartnerCode,
  serializePublicAutoEnableResult
} from "./courier-partners.service.js";

const now = new Date("2026-06-06T10:00:00.000Z");

function makeClient(input: {
  country?: string;
  supportedSegments?: ShipmentSegment[];
} = {}) {
  const state = {
    partners: [{
      id: "courier_bigship",
      name: "Bigship",
      code: "bigship",
      active: true,
      status: CourierPartnerStatus.active,
      isSystemManaged: true,
      defaultForNewSellers: true,
      credentialsRequiredFromSeller: false,
      country: input.country ?? "IN",
      supportedSegments: input.supportedSegments ?? [
        ShipmentSegment.domestic_b2c,
        ShipmentSegment.domestic_b2b,
        ShipmentSegment.hyperlocal
      ],
      priority: 50,
      createdAt: now
    }],
    mappings: [] as any[]
  };

  const withPartner = (mapping: any) => ({
    ...mapping,
    courierPartner: state.partners.find((partner) => partner.id === mapping.courierPartnerId) ?? null
  });

  const client = {
    courierPartner: {
      findMany: async ({ where }: any) => state.partners
        .filter((partner) => {
          const supportedSegments = where.supportedSegments?.hasSome ?? [];
          return partner.active === where.active &&
            partner.status === where.status &&
            partner.isSystemManaged === where.isSystemManaged &&
            partner.defaultForNewSellers === where.defaultForNewSellers &&
            partner.credentialsRequiredFromSeller === where.credentialsRequiredFromSeller &&
            partner.country === where.country &&
            supportedSegments.some((segment: ShipmentSegment) => partner.supportedSegments.includes(segment));
        })
        .sort((left, right) => left.priority - right.priority)
    },
    sellerCourierPartner: {
      findUnique: async ({ where }: any) => {
        const unique = where.sellerId_courierPartnerId;
        const mapping = state.mappings.find((record) =>
          record.sellerId === unique.sellerId &&
          record.courierPartnerId === unique.courierPartnerId
        );
        return mapping ? withPartner(mapping) : null;
      },
      create: async ({ data }: any) => {
        const mapping = {
          id: `scp_${state.mappings.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.mappings.push(mapping);
        return withPartner(mapping);
      }
    }
  };

  return { client: client as any, state };
}

describe("courier partner auto-enable foundation", () => {
  it("defines the default internal Bigship system-managed seed", () => {
    const seed = defaultSystemCourierPartnerSeed();

    assert.equal(seed.code, "bigship");
    assert.equal(seed.name, "Bigship");
    assert.equal(seed.status, "active");
    assert.equal(seed.isSystemManaged, true);
    assert.equal(seed.defaultForNewSellers, true);
    assert.equal(seed.credentialsRequiredFromSeller, false);
    assert.equal(seed.country, "IN");
    assert.deepEqual(seed.supportedSegments, [
      ShipmentSegment.domestic_b2c,
      ShipmentSegment.domestic_b2b,
      ShipmentSegment.hyperlocal
    ]);
  });

  it("auto-enables the system-managed partner for an IN domestic_b2c seller", async () => {
    const { client, state } = makeClient();

    const result = await autoEnableCourierPartners({
      sellerId: "seller_1",
      country: "IN",
      segments: ["domestic_b2c"]
    }, client);

    assert.equal(result.enabled.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(state.mappings.length, 1);
    assert.equal(state.mappings[0]?.sellerId, "seller_1");
    assert.equal(state.mappings[0]?.partnerType, PartnerType.system_managed);
    assert.equal(state.mappings[0]?.status, SellerCourierPartnerStatus.active);
    assert.equal(state.mappings[0]?.credentialsRequiredFromSeller, false);
    assert.deepEqual(state.mappings[0]?.enabledSegments, [ShipmentSegment.domestic_b2c]);
    assert.equal(getInternalCourierPartnerCode(result.enabled[0]!), "bigship");
  });

  it("does not duplicate mappings on repeated auto-enable", async () => {
    const { client, state } = makeClient();
    const input = {
      sellerId: "seller_1",
      country: "IN",
      segments: ["domestic_b2c"]
    };

    await autoEnableCourierPartners(input, client);
    const second = await autoEnableCourierPartners(input, client);

    assert.equal(state.mappings.length, 1);
    assert.equal(second.enabled.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0]?.reason, "already_enabled");
  });

  it("hides Bigship in the public response and returns Shipmastr Courier Network", async () => {
    const { client } = makeClient();
    const result = await autoEnableCourierPartners({
      sellerId: "seller_public",
      country: "IN",
      segments: ["domestic_b2c"]
    }, client);

    const publicResult = serializePublicAutoEnableResult(result);
    const json = JSON.stringify(publicResult);

    assert.equal(publicResult.enabled[0]?.partner_code, "shipmastr_courier_network");
    assert.equal(publicResult.enabled[0]?.partner_name, "Shipmastr Courier Network");
    assert.equal(publicResult.enabled[0]?.status, "active");
    assert.equal(publicResult.enabled[0]?.partner_type, "system_managed");
    assert.doesNotMatch(json, /bigship/i);
  });

  it("returns no enabled partners cleanly for unsupported country or segment", async () => {
    const { client, state } = makeClient();

    const unsupportedCountry = await autoEnableCourierPartners({
      sellerId: "seller_us",
      country: "US",
      segments: ["domestic_b2c"]
    }, client);
    const unsupportedSegment = await autoEnableCourierPartners({
      sellerId: "seller_cross_border",
      country: "IN",
      segments: ["cross_border"]
    }, client);

    assert.deepEqual(unsupportedCountry, { enabled: [], skipped: [] });
    assert.deepEqual(unsupportedSegment, { enabled: [], skipped: [] });
    assert.equal(autoEnableCourierPartnersMessage(unsupportedCountry), "No eligible courier partners found.");
    assert.equal(autoEnableCourierPartnersMessage(unsupportedSegment), "No eligible courier partners found.");
    assert.equal(state.mappings.length, 0);
  });

  it("mounts the public courier partner route without admin-only middleware", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const moduleRoutes = readFileSync("src/modules/courierPartners/courier-partners.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/courier-partners", courierPartnersRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/v1\/courier-partners", courierPartnersRouter\);/);
    assert.match(moduleRoutes, /courierPartnersRouter\.post\("\/auto-enable", autoEnableCourierPartnersHandler\);/);
    assert.doesNotMatch(routes, /apiRouter\.use\("\/courier-partners", requireAdminJwt/);
  });
});
