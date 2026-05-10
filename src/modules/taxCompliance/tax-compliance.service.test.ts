import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccountGstinVerificationStatus, PickupPointStatus } from "@prisma/client";
import {
  approveMerchantPickupPoint,
  createCourierGstinRecord,
  createCourierOperationalLocation,
  createMerchantGstinRecord,
  createMerchantPickupPoint,
  getCourierActivationReadiness,
  rejectMerchantGstinRecord,
  updateCourierOperationalLocation,
  verifyCourierGstinRecord,
  verifyMerchantGstinRecord
} from "./tax-compliance.service.js";

const now = new Date("2026-05-10T08:00:00.000Z");

function matchesWhere(row: any, where: any = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("not" in value) return row[key] !== value.not;
    }

    return row[key] === value;
  });
}

function sortByCreatedDesc<T extends { createdAt: Date }>(rows: T[]) {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function makeTaxClient() {
  const state = {
    merchantGstins: [] as any[],
    merchantPickups: [] as any[],
    courier: {
      id: "courier_1",
      name: "Northline Express",
      gstin: "27AAPFU0939F1ZV",
      bookingMode: "manual"
    },
    courierGstins: [] as any[],
    courierLocations: [] as any[],
    rateCards: [] as any[],
    serviceablePincodes: [] as any[],
    auditLogs: [] as any[]
  };

  const withMerchantLinkedGstin = (pickup: any) => ({
    ...pickup,
    linkedGstin: pickup.linkedGstinId
      ? state.merchantGstins.find((record) => record.id === pickup.linkedGstinId) || null
      : null
  });

  const withCourierLinkedGstin = (location: any) => ({
    ...location,
    linkedGstin: location.linkedGstinId
      ? state.courierGstins.find((record) => record.id === location.linkedGstinId) || null
      : null
  });

  const client = {
    merchantGstinRecord: {
      findMany: async ({ where }: any) => sortByCreatedDesc(state.merchantGstins.filter((row) => matchesWhere(row, where))),
      findFirst: async ({ where }: any) => sortByCreatedDesc(state.merchantGstins.filter((row) => matchesWhere(row, where)))[0] || null,
      create: async ({ data }: any) => {
        const record = {
          id: `merchant_gstin_${state.merchantGstins.length + 1}`,
          legalName: null,
          tradeName: null,
          registrationStatus: null,
          registeredAddress: null,
          registeredPincode: null,
          source: null,
          verificationStatus: AccountGstinVerificationStatus.PENDING_REVIEW,
          verifiedAt: null,
          verifiedBy: null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          createdAt: new Date(now.getTime() + state.merchantGstins.length),
          updatedAt: now,
          ...data
        };
        state.merchantGstins.push(record);
        return { ...record };
      },
      update: async ({ where, data }: any) => {
        const record = state.merchantGstins.find((row) => row.id === where.id);
        assert.ok(record);
        Object.assign(record, data, { updatedAt: now });
        return { ...record };
      }
    },
    merchantPickupPoint: {
      findMany: async ({ where }: any) => state.merchantPickups.filter((row) => matchesWhere(row, where)).map(withMerchantLinkedGstin),
      findFirst: async ({ where }: any) => {
        const record = state.merchantPickups.find((row) => matchesWhere(row, where));
        return record ? withMerchantLinkedGstin(record) : null;
      },
      create: async ({ data }: any) => {
        const record = {
          id: `merchant_pickup_${state.merchantPickups.length + 1}`,
          addressLine2: null,
          email: null,
          status: PickupPointStatus.PENDING_REVIEW,
          blockerReason: null,
          approvedAt: null,
          approvedBy: null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          createdAt: new Date(now.getTime() + state.merchantPickups.length),
          updatedAt: now,
          ...data
        };
        state.merchantPickups.push(record);
        return withMerchantLinkedGstin(record);
      },
      update: async ({ where, data }: any) => {
        const record = state.merchantPickups.find((row) => row.id === where.id);
        assert.ok(record);
        Object.assign(record, data, { updatedAt: now });
        return withMerchantLinkedGstin(record);
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const record of state.merchantPickups) {
          if (!matchesWhere(record, where)) continue;
          Object.assign(record, data, { updatedAt: now });
          count += 1;
        }
        return { count };
      }
    },
    courierPartner: {
      findUnique: async ({ where }: any) => where.id === state.courier.id ? state.courier : null
    },
    rateCard: {
      count: async ({ where }: any) => state.rateCards.filter((row) => matchesWhere(row, where)).length
    },
    courierServiceablePincode: {
      count: async ({ where }: any) => state.serviceablePincodes.filter((row) => matchesWhere(row, where)).length
    },
    courierGstinRecord: {
      findMany: async ({ where }: any) => sortByCreatedDesc(state.courierGstins.filter((row) => matchesWhere(row, where))),
      findFirst: async ({ where }: any) => sortByCreatedDesc(state.courierGstins.filter((row) => matchesWhere(row, where)))[0] || null,
      create: async ({ data }: any) => {
        const record = {
          id: `courier_gstin_${state.courierGstins.length + 1}`,
          legalName: null,
          tradeName: null,
          registrationStatus: null,
          registeredAddress: null,
          registeredPincode: null,
          verificationStatus: AccountGstinVerificationStatus.PENDING,
          verifiedAt: null,
          verifiedBy: null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          createdAt: new Date(now.getTime() + state.courierGstins.length),
          updatedAt: now,
          ...data
        };
        state.courierGstins.push(record);
        return { ...record };
      },
      update: async ({ where, data }: any) => {
        const record = state.courierGstins.find((row) => row.id === where.id);
        assert.ok(record);
        Object.assign(record, data, { updatedAt: now });
        return { ...record };
      }
    },
    courierOperationalLocation: {
      findMany: async ({ where }: any) => state.courierLocations.filter((row) => matchesWhere(row, where)).map(withCourierLinkedGstin),
      findFirst: async ({ where }: any) => {
        const record = state.courierLocations.find((row) => matchesWhere(row, where));
        return record ? withCourierLinkedGstin(record) : null;
      },
      create: async ({ data }: any) => {
        const record = {
          id: `courier_location_${state.courierLocations.length + 1}`,
          addressLine2: null,
          status: PickupPointStatus.PENDING,
          blockerReason: null,
          approvedAt: null,
          approvedBy: null,
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          createdAt: new Date(now.getTime() + state.courierLocations.length),
          updatedAt: now,
          ...data
        };
        state.courierLocations.push(record);
        return withCourierLinkedGstin(record);
      },
      update: async ({ where, data }: any) => {
        const record = state.courierLocations.find((row) => row.id === where.id);
        assert.ok(record);
        Object.assign(record, data, { updatedAt: now });
        return withCourierLinkedGstin(record);
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const record of state.courierLocations) {
          if (!matchesWhere(record, where)) continue;
          Object.assign(record, data, { updatedAt: now });
          count += 1;
        }
        return { count };
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const record = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(record);
        return record;
      }
    }
  };

  return { client: client as any, state };
}

const pickupInput = {
  label: "Mumbai warehouse",
  contactName: "QA Ops",
  phone: "9876543210",
  addressLine1: "QA Industrial Estate",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "560001"
};

describe("pickup-state GSTIN tax compliance", () => {
  it("links same-state seller pickup to a verified GSTIN while allowing pincode mismatch", async () => {
    const { client, state } = makeTaxClient();

    const gstin = await createMerchantGstinRecord({
      merchantId: "merchant_1",
      actorId: "admin_1",
      record: {
        gstin: "27aapfu0939f1zv",
        registeredState: "Maharashtra",
        registeredPincode: "400001"
      }
    }, client);
    await verifyMerchantGstinRecord({ merchantId: "merchant_1", gstinRecordId: gstin.id, actorId: "admin_1" }, client);

    const pickup = await createMerchantPickupPoint({
      merchantId: "merchant_1",
      actorId: "seller_1",
      pickup: pickupInput
    }, client);

    assert.equal(pickup.status, PickupPointStatus.PENDING);
    assert.equal(pickup.linkedGstinId, gstin.id);
    assert.equal(pickup.state, "MAHARASHTRA");
    assert.equal(pickup.pincode, "560001");
    assert.equal(state.auditLogs.some((log) => log.action === "MERCHANT_PICKUP_CREATED"), true);
  });

  it("sets REQUIRE_STATE_GSTIN for different-state seller pickup without verified GSTIN", async () => {
    const { client, state } = makeTaxClient();

    const pickup = await createMerchantPickupPoint({
      merchantId: "merchant_1",
      actorId: "seller_1",
      pickup: {
        ...pickupInput,
        state: "Karnataka"
      }
    }, client);

    assert.equal(pickup.status, PickupPointStatus.REQUIRE_STATE_GSTIN);
    assert.equal(pickup.linkedGstinId, null);
    assert.match(pickup.blockerReason || "", /verified GSTIN registered in the same state/);
    assert.equal(state.auditLogs.some((log) => log.action === "MERCHANT_PICKUP_STATE_GSTIN_MISMATCH"), true);
  });

  it("does not allow activation from an unverified seller GSTIN and blocks admin approval", async () => {
    const { client, state } = makeTaxClient();

    await createMerchantGstinRecord({
      merchantId: "merchant_1",
      actorId: "seller_1",
      record: {
        gstin: "29ABCDE1234F1Z5",
        registeredState: "Karnataka",
        registeredPincode: "560001"
      }
    }, client);

    const pickup = await createMerchantPickupPoint({
      merchantId: "merchant_1",
      actorId: "seller_1",
      pickup: {
        ...pickupInput,
        state: "Karnataka"
      }
    }, client);

    assert.equal(pickup.status, PickupPointStatus.REQUIRE_STATE_GSTIN);
    await assert.rejects(
      () => approveMerchantPickupPoint({
        merchantId: "merchant_1",
        pickupPointId: pickup.id,
        actorId: "admin_1"
      }, client),
      /PICKUP_STATE_GSTIN_REQUIRED/
    );
    assert.equal(state.auditLogs.some((log) => log.action === "MERCHANT_PICKUP_APPROVE_BLOCKED_STATE_GSTIN_MISMATCH"), true);
  });

  it("relinks blocked pickups when seller GSTIN is verified and re-blocks on GSTIN rejection", async () => {
    const { client } = makeTaxClient();

    const gstin = await createMerchantGstinRecord({
      merchantId: "merchant_1",
      actorId: "seller_1",
      record: {
        gstin: "29ABCDE1234F1Z5",
        registeredState: "Karnataka"
      }
    }, client);

    const blocked = await createMerchantPickupPoint({
      merchantId: "merchant_1",
      actorId: "seller_1",
      pickup: {
        ...pickupInput,
        state: "Karnataka"
      }
    }, client);

    assert.equal(blocked.status, PickupPointStatus.REQUIRE_STATE_GSTIN);

    await verifyMerchantGstinRecord({ merchantId: "merchant_1", gstinRecordId: gstin.id, actorId: "admin_1" }, client);
    const approvedReady = await approveMerchantPickupPoint({
      merchantId: "merchant_1",
      pickupPointId: blocked.id,
      actorId: "admin_1"
    }, client);

    assert.equal(approvedReady.status, PickupPointStatus.APPROVED);
    assert.equal(approvedReady.linkedGstinId, gstin.id);

    await rejectMerchantGstinRecord({
      merchantId: "merchant_1",
      gstinRecordId: gstin.id,
      actorId: "admin_1",
      reason: "QA rejection"
    }, client);

    await assert.rejects(
      () => approveMerchantPickupPoint({
        merchantId: "merchant_1",
        pickupPointId: blocked.id,
        actorId: "admin_1"
      }, client),
      /PICKUP_STATE_GSTIN_REQUIRED/
    );
  });

  it("requires matching-state verified GSTIN for courier operational locations", async () => {
    const { client, state } = makeTaxClient();

    const pendingGstin = await createCourierGstinRecord({
      courierId: "courier_1",
      actorId: "courier_user_1",
      record: {
        gstin: "27AAPFU0939F1ZV",
        registeredState: "Maharashtra",
        registeredPincode: "400001"
      }
    }, client);

    const blocked = await createCourierOperationalLocation({
      courierId: "courier_1",
      actorId: "courier_user_1",
      location: pickupInput
    }, client);

    assert.equal(blocked.status, PickupPointStatus.REQUIRE_STATE_GSTIN);
    assert.equal(blocked.linkedGstinId, null);

    await assert.rejects(
      () => updateCourierOperationalLocation({
        courierId: "courier_1",
        locationId: blocked.id,
        actorId: "admin_1",
        patch: { status: PickupPointStatus.APPROVED }
      }, client),
      /COURIER_LOCATION_STATE_GSTIN_REQUIRED/
    );

    await verifyCourierGstinRecord({ courierId: "courier_1", gstinRecordId: pendingGstin.id, actorId: "admin_1" }, client);

    const linked = await createCourierOperationalLocation({
      courierId: "courier_1",
      actorId: "courier_user_1",
      location: {
        ...pickupInput,
        label: "Mumbai linehaul",
        pincode: "411001"
      }
    }, client);

    assert.equal(linked.status, PickupPointStatus.PENDING_REVIEW);
    assert.equal(linked.linkedGstinId, pendingGstin.id);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_LOCATION_STATE_GSTIN_MISMATCH"), true);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_GSTIN_VERIFIED"), true);
  });

  it("allows multiple same-state courier offices under one verified GSTIN and requires a separate GSTIN for another state", async () => {
    const { client } = makeTaxClient();

    const maharashtraGstin = await createCourierGstinRecord({
      courierId: "courier_1",
      actorId: "admin_1",
      record: {
        gstin: "27AAPFU0939F1ZV",
        registeredState: "Maharashtra",
        legalName: "Northline Express"
      }
    }, client);
    await verifyCourierGstinRecord({ courierId: "courier_1", gstinRecordId: maharashtraGstin.id, actorId: "admin_1" }, client);

    const mumbaiOffice = await createCourierOperationalLocation({
      courierId: "courier_1",
      actorId: "admin_1",
      location: pickupInput
    }, client);
    const puneOffice = await createCourierOperationalLocation({
      courierId: "courier_1",
      actorId: "admin_1",
      location: {
        ...pickupInput,
        label: "Pune office",
        city: "Pune",
        pincode: "411001"
      }
    }, client);
    const bengaluruOffice = await createCourierOperationalLocation({
      courierId: "courier_1",
      actorId: "admin_1",
      location: {
        ...pickupInput,
        label: "Bengaluru office",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001"
      }
    }, client);

    assert.equal(mumbaiOffice.status, PickupPointStatus.PENDING_REVIEW);
    assert.equal(puneOffice.status, PickupPointStatus.PENDING_REVIEW);
    assert.equal(mumbaiOffice.linkedGstinId, maharashtraGstin.id);
    assert.equal(puneOffice.linkedGstinId, maharashtraGstin.id);
    assert.equal(bengaluruOffice.status, PickupPointStatus.REQUIRE_STATE_GSTIN);
    assert.equal(bengaluruOffice.linkedGstinId, null);

    const karnatakaGstin = await createCourierGstinRecord({
      courierId: "courier_1",
      actorId: "admin_1",
      record: {
        gstin: "29ABCDE1234F1Z5",
        registeredState: "Karnataka",
        legalName: "Northline Express"
      }
    }, client);
    await verifyCourierGstinRecord({ courierId: "courier_1", gstinRecordId: karnatakaGstin.id, actorId: "admin_1" }, client);

    const relinked = await updateCourierOperationalLocation({
      courierId: "courier_1",
      locationId: bengaluruOffice.id,
      actorId: "admin_1",
      patch: { status: PickupPointStatus.APPROVED }
    }, client);

    assert.equal(relinked.status, PickupPointStatus.APPROVED);
    assert.equal(relinked.linkedGstinId, karnatakaGstin.id);
  });

  it("puts inactive, cancelled, or suspended courier GSTINs on HOLD instead of verifying them", async () => {
    const { client, state } = makeTaxClient();

    const gstin = await createCourierGstinRecord({
      courierId: "courier_1",
      actorId: "admin_1",
      record: {
        gstin: "27AAPFU0939F1ZV",
        registeredState: "Maharashtra",
        legalName: "Northline Express",
        registrationStatus: "Suspended"
      }
    }, client);

    const held = await verifyCourierGstinRecord({ courierId: "courier_1", gstinRecordId: gstin.id, actorId: "admin_1" }, client);

    assert.equal(held.verificationStatus, AccountGstinVerificationStatus.HOLD);
    assert.match(held.rejectionReason || "", /inactive, cancelled, suspended/);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_GSTIN_REGISTRATION_STATUS_BLOCKED"), true);
  });

  it("puts courier GSTIN legal or trade name mismatches on HOLD", async () => {
    const { client, state } = makeTaxClient();

    const gstin = await createCourierGstinRecord({
      courierId: "courier_1",
      actorId: "admin_1",
      record: {
        gstin: "27AAPFU0939F1ZV",
        registeredState: "Maharashtra",
        legalName: "Unrelated Carrier Private Limited"
      }
    }, client);

    const held = await verifyCourierGstinRecord({ courierId: "courier_1", gstinRecordId: gstin.id, actorId: "admin_1" }, client);

    assert.equal(held.verificationStatus, AccountGstinVerificationStatus.HOLD);
    assert.match(held.rejectionReason || "", /legal\/trade name/);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_GSTIN_LEGAL_TRADE_NAME_MISMATCH_HOLD"), true);
  });

  it("reports courier activation readiness only after compliance and pilot setup are complete", async () => {
    const { client, state } = makeTaxClient();

    let readiness = await getCourierActivationReadiness("courier_1", client);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.issues.some((issue) => issue.code === "COURIER_VERIFIED_GSTIN_REQUIRED"), true);
    assert.equal(readiness.issues.some((issue) => issue.code === "COURIER_APPROVED_OPERATIONAL_OFFICE_REQUIRED"), true);
    assert.equal(readiness.issues.some((issue) => issue.code === "COURIER_RATE_CARD_REQUIRED"), true);
    assert.equal(readiness.issues.some((issue) => issue.code === "COURIER_SERVICEABLE_PINCODES_REQUIRED"), true);

    const gstin = await createCourierGstinRecord({
      courierId: "courier_1",
      actorId: "admin_1",
      record: {
        gstin: "27AAPFU0939F1ZV",
        registeredState: "Maharashtra",
        legalName: "Northline Express"
      }
    }, client);
    await verifyCourierGstinRecord({ courierId: "courier_1", gstinRecordId: gstin.id, actorId: "admin_1" }, client);
    const office = await createCourierOperationalLocation({
      courierId: "courier_1",
      actorId: "admin_1",
      location: pickupInput
    }, client);
    await updateCourierOperationalLocation({
      courierId: "courier_1",
      locationId: office.id,
      actorId: "admin_1",
      patch: { status: PickupPointStatus.APPROVED }
    }, client);
    state.rateCards.push({ id: "rate_1", courierId: "courier_1" });
    state.serviceablePincodes.push({ id: "pincode_1", courierId: "courier_1", active: true, pincode: "400001" });

    readiness = await getCourierActivationReadiness("courier_1", client);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.verifiedGstinCount, 1);
    assert.equal(readiness.approvedOfficeCount, 1);
    assert.equal(readiness.rateCardCount, 1);
    assert.equal(readiness.serviceablePincodeCount, 1);
  });

  it("blocks courier operational locations when courier has no base GSTIN", async () => {
    const { client, state } = makeTaxClient();
    state.courier.gstin = null as any;

    await assert.rejects(
      () => createCourierOperationalLocation({
        courierId: "courier_1",
        actorId: "courier_user_1",
        location: pickupInput
      }, client),
      /COURIER_GSTIN_REQUIRED/
    );
  });
});
