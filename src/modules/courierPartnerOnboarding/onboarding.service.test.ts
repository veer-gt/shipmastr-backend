import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccountGstinVerificationStatus,
  CourierPartnerOnboardingStatus,
  CourierSandboxVerificationStatus,
  PickupPointStatus
} from "@prisma/client";
import {
  decryptSecretValue,
  redactSecrets,
  SANDBOX_VERIFICATION_ITEMS,
  saveCourierOnboardingDraft,
  setAdminCourierPartnerStatus,
  submitCourierOnboarding,
  reopenAdminCourierPartner,
  updateCourierSandboxVerificationItem
} from "./onboarding.service.js";

const now = new Date("2026-05-09T10:00:00.000Z");

function makeOnboardingClient() {
  const state = {
    courier: {
      id: "courier_1",
      name: "Northline Express",
      code: "NLE",
      gstin: null as string | null,
      serviceCodeType: "SAC",
      serviceCode: "996812",
      serviceDescription: "Courier services",
      gstRate: 18,
      active: true,
      apiMode: "manual",
      bookingMode: "manual",
      supportsCOD: true,
      supportsPrepaid: true,
      supportsPickup: true,
      trackingUrlTemplate: null,
      createdAt: now,
      updatedAt: now
    },
    courierUsers: [{
      id: "courier_user_1",
      courierId: "courier_1",
      name: "Courier Ops",
      email: "ops@northline.example",
      active: true,
      lastLoginAt: null,
      createdAt: now
    }],
    onboarding: {
      id: "onboarding_1",
      courierId: "courier_1",
      status: CourierPartnerOnboardingStatus.DRAFT,
      companyLegal: {},
      commercial: {},
      serviceability: {},
      codRemittance: {},
      api: {},
      webhookSecurity: {},
      escalation: {},
      changeRequest: null,
      submittedAt: null,
      reviewedAt: null,
      createdAt: now,
      updatedAt: now
    } as any,
    credentials: [] as any[],
    secrets: [] as any[],
    verificationItems: [] as any[],
    courierGstins: [] as any[],
    courierLocations: [] as any[],
    rateCards: [] as any[],
    serviceablePincodes: [] as any[],
    audits: [] as any[],
    auditLogs: [] as any[]
  };

  const withIncludes = () => ({
    ...state.onboarding,
    courier: {
      ...state.courier,
      users: state.courierUsers
    },
    credentials: state.credentials,
    audits: [...state.audits].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  });

  const client = {
    $transaction: async (callback: any) => callback(client),
    courierPartnerOnboarding: {
      findUnique: async ({ where }: any) => {
        if (where.courierId === state.onboarding.courierId || where.id === state.onboarding.id) {
          return withIncludes();
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        const matches = where?.OR?.some((entry: any) => (
          entry.id === state.onboarding.id ||
          entry.courierId === state.onboarding.courierId
        ));
        return matches ? withIncludes() : null;
      },
      update: async ({ where, data }: any) => {
        assert.equal(where.id, state.onboarding.id);
        state.onboarding = {
          ...state.onboarding,
          ...data,
          updatedAt: now
        };
        return state.onboarding;
      }
    },
    courierPartner: {
      findUnique: async ({ where }: any) => (
        where.id === state.courier.id ? {
          ...state.courier,
          onboarding: state.onboarding
        } : null
      ),
      update: async ({ where, data }: any) => {
        assert.equal(where.id, state.courier.id);
        state.courier = {
          ...state.courier,
          ...data,
          updatedAt: now
        };
        return state.courier;
      }
    },
    rateCard: {
      count: async ({ where }: any) => state.rateCards.filter((row) => row.courierId === where.courierId).length
    },
    courierServiceablePincode: {
      count: async ({ where }: any) => state.serviceablePincodes.filter((row) => (
        row.courierId === where.courierId &&
        (where.active === undefined || row.active === where.active)
      )).length
    },
    courierGstinRecord: {
      findMany: async ({ where }: any) => (
        state.courierGstins.filter((record) => record.courierId === where.courierId)
      )
    },
    courierOperationalLocation: {
      findMany: async ({ where }: any) => (
        state.courierLocations
          .filter((location) => location.courierId === where.courierId)
          .map((location) => ({
            ...location,
            linkedGstin: location.linkedGstinId
              ? state.courierGstins.find((record) => record.id === location.linkedGstinId) || null
              : null
          }))
      )
    },
    courierSandboxVerificationChecklistItem: {
      findMany: async ({ where }: any) => (
        state.verificationItems
          .filter((item) => item.courierId === where.courierId)
          .map((item) => ({ ...item }))
      ),
      findFirst: async ({ where }: any) => (
        state.verificationItems.find((item) => (
          item.courierId === where.courierId &&
          item.itemKey === where.itemKey
        )) || null
      ),
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const item of data) {
          const exists = state.verificationItems.some((existing) => (
            existing.courierId === item.courierId &&
            existing.itemKey === item.itemKey
          ));
          if (exists) continue;
          state.verificationItems.push({
            id: `verification_${state.verificationItems.length + 1}`,
            owner: null,
            notes: null,
            evidenceUrl: null,
            verifiedAt: null,
            verifiedBy: null,
            createdAt: now,
            updatedAt: now,
            ...item
          });
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const key = where.courierId_itemKey;
        const item = state.verificationItems.find((entry) => (
          entry.courierId === key.courierId &&
          entry.itemKey === key.itemKey
        ));
        assert.ok(item);
        Object.assign(item, data, { updatedAt: now });
        return { ...item };
      }
    },
    courierPartnerSecret: {
      create: async ({ data }: any) => {
        const secret = { id: `secret_${state.secrets.length + 1}`, createdAt: now, updatedAt: now, ...data };
        state.secrets.push(secret);
        return secret;
      }
    },
    courierPartnerCredential: {
      upsert: async ({ where, create, update }: any) => {
        const key = where.onboardingId_environment_fieldKey;
        const existing = state.credentials.find((credential) => (
          credential.onboardingId === key.onboardingId &&
          credential.environment === key.environment &&
          credential.fieldKey === key.fieldKey
        ));

        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }

        const credential = { id: `credential_${state.credentials.length + 1}`, updatedAt: now, ...create };
        state.credentials.push(credential);
        return credential;
      }
    },
    courierPartnerOnboardingAudit: {
      create: async ({ data }: any) => {
        const audit = { id: `audit_${state.audits.length + 1}`, createdAt: now, ...data };
        state.audits.push(audit);
        return audit;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `global_audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("courier partner onboarding service", () => {
  it("stores credential values encrypted and returns only masked references", async () => {
    const { client, state } = makeOnboardingClient();

    const result = await saveCourierOnboardingDraft({
      courierId: "courier_1",
      actorId: "courier_user_1",
      patch: {
        api: {
          sandboxBaseUrl: "https://sandbox.courier.example",
          token: "raw-token-in-wrong-place"
        },
        credentials: {
          sandbox: {
            apiKey: "sandbox-api-key-123456",
            clientSecret: "client-secret-abcdef"
          }
        }
      }
    }, client);

    assert.equal(state.secrets.length, 2);
    assert.equal(decryptSecretValue(state.secrets[0]!), "sandbox-api-key-123456");
    assert.equal(result.credentials[0]!.maskedValue, "****3456");
    assert.equal(JSON.stringify(result).includes("sandbox-api-key-123456"), false);
    assert.equal(JSON.stringify(result).includes("client-secret-abcdef"), false);
    assert.equal((result.api as any).token, "[redacted]");
    assert.equal(state.audits[0]?.action, "COURIER_PARTNER_ONBOARDING_UPDATED");
  });

  it("rejects blank courier GSTIN during draft save", async () => {
    const { client, state } = makeOnboardingClient();

    await assert.rejects(
      () => saveCourierOnboardingDraft({
        courierId: "courier_1",
        actorId: "courier_user_1",
        patch: {
          companyLegal: {
            companyName: "Northline Express",
            gstNumber: ""
          }
        }
      }, client),
      /GSTIN_REQUIRED/
    );

    assert.equal(state.courier.gstin, null);
  });

  it("normalizes lowercase courier GSTIN and stores default SAC/GST classification during draft save", async () => {
    const { client, state } = makeOnboardingClient();

    const normalized = await saveCourierOnboardingDraft({
      courierId: "courier_1",
      actorId: "courier_user_1",
      patch: {
        companyLegal: {
          companyName: "Northline Express",
          gstNumber: "27aapfu0939f1zv"
        }
      }
    }, client);

    assert.equal(normalized.courier.gstin, "27AAPFU0939F1ZV");
    assert.equal(state.courier.gstin, "27AAPFU0939F1ZV");
    assert.equal((normalized.companyLegal as any).gstNumber, "27AAPFU0939F1ZV");
    assert.equal((normalized.companyLegal as any).gstin, "27AAPFU0939F1ZV");
    assert.equal(normalized.courier.serviceCodeType, "SAC");
    assert.equal(normalized.courier.serviceCode, "996812");
    assert.equal(normalized.courier.serviceDescription, "Courier services");
    assert.equal(normalized.courier.gstRate, 18);
    assert.equal((normalized.companyLegal as any).serviceCodeType, "SAC");
    assert.equal((normalized.companyLegal as any).serviceCode, "996812");
    assert.equal((normalized.companyLegal as any).serviceDescription, "Courier services");
    assert.equal((normalized.companyLegal as any).gstRate, 18);
  });

  it("stores selected related courier SAC classification during draft save", async () => {
    const { client, state } = makeOnboardingClient();

    const normalized = await saveCourierOnboardingDraft({
      courierId: "courier_1",
      actorId: "courier_user_1",
      patch: {
        companyLegal: {
          companyName: "Northline Express",
          gstNumber: "27AAPFU0939F1ZV",
          serviceCode: "996813"
        }
      }
    }, client);

    assert.equal(state.courier.serviceCodeType, "SAC");
    assert.equal(state.courier.serviceCode, "996813");
    assert.equal(state.courier.serviceDescription, "Local delivery services");
    assert.equal(state.courier.gstRate, 18);
    assert.equal(normalized.courier.serviceCode, "996813");
    assert.equal((normalized.companyLegal as any).serviceDescription, "Local delivery services");
  });

  it("rejects invalid courier GSTIN when provided", async () => {
    const { client } = makeOnboardingClient();

    await assert.rejects(
      () => saveCourierOnboardingDraft({
        courierId: "courier_1",
        actorId: "courier_user_1",
        patch: { companyLegal: { gstNumber: "invalid-gstin" } }
      }, client),
      /INVALID_GSTIN/
    );
  });

  it("rejects invalid courier service code when provided", async () => {
    const { client } = makeOnboardingClient();

    await assert.rejects(
      () => saveCourierOnboardingDraft({
        courierId: "courier_1",
        actorId: "courier_user_1",
        patch: { companyLegal: { gstNumber: "27AAPFU0939F1ZV", serviceCode: "999999" } }
      }, client),
      /COURIER_SERVICE_CODE_INVALID/
    );
  });

  it("rejects submit when courier GSTIN is missing", async () => {
    const { client } = makeOnboardingClient();

    await assert.rejects(
      () => submitCourierOnboarding({
        courierId: "courier_1",
        actorId: "courier_user_1"
      }, client),
      /GSTIN_REQUIRED/
    );
  });

  it("submits once and keeps submitted forms read-only until admin reopens", async () => {
    const { client, state } = makeOnboardingClient();
    state.courier.gstin = "27AAPFU0939F1ZV";

    await submitCourierOnboarding({
      courierId: "courier_1",
      actorId: "courier_user_1"
    }, client);

    assert.equal(state.onboarding.status, CourierPartnerOnboardingStatus.SUBMITTED);
    await assert.rejects(
      () => saveCourierOnboardingDraft({
        courierId: "courier_1",
        actorId: "courier_user_1",
        patch: { companyLegal: { companyName: "Blocked edit" } }
      }, client),
      /COURIER_ONBOARDING_READ_ONLY/
    );
  });

  it("audits approve, block, and reopen status changes", async () => {
    const { client, state } = makeOnboardingClient();
    state.courier.gstin = "27AAPFU0939F1ZV";

    await submitCourierOnboarding({
      courierId: "courier_1",
      actorId: "courier_user_1"
    }, client);
    await setAdminCourierPartnerStatus({
      courierIdOrOnboardingId: "courier_1",
      actorId: "admin_1",
      status: CourierPartnerOnboardingStatus.SANDBOX_TESTING,
      note: "Sandbox credentials ready for verification."
    }, client);
    await setAdminCourierPartnerStatus({
      courierIdOrOnboardingId: "courier_1",
      actorId: "admin_1",
      status: CourierPartnerOnboardingStatus.BLOCKED,
      note: "Missing documents."
    }, client);
    await reopenAdminCourierPartner({
      courierIdOrOnboardingId: "courier_1",
      actorId: "admin_1",
      reason: "Upload corrected commercial details."
    }, client);

    assert.equal(state.onboarding.status, CourierPartnerOnboardingStatus.REOPENED);
    assert.equal(state.courier.active, true);
    assert.deepEqual(state.audits.map((audit) => audit.action), [
      "COURIER_PARTNER_ONBOARDING_SUBMITTED",
      "COURIER_PARTNER_ONBOARDING_APPROVED",
      "COURIER_PARTNER_ONBOARDING_BLOCKED",
      "COURIER_PARTNER_ONBOARDING_REOPENED"
    ]);
    assert.equal(state.auditLogs.length, 4);
  });

  it("updates sandbox verification checklist items with redacted audit metadata", async () => {
    const { client, state } = makeOnboardingClient();

    const result = await updateCourierSandboxVerificationItem({
      courierIdOrOnboardingId: "courier_1",
      itemKey: "sandbox_credentials_verified",
      actorId: "admin_1",
      patch: {
        status: CourierSandboxVerificationStatus.PASSED,
        owner: "QA Ops",
        notes: "api_key=super-secret-token was checked in sandbox",
        evidenceUrl: "https://evidence.example/sandbox-check"
      }
    }, client);

    const item = state.verificationItems.find((entry) => entry.itemKey === "sandbox_credentials_verified");
    assert.equal(state.verificationItems.length, SANDBOX_VERIFICATION_ITEMS.length);
    assert.equal(item?.status, CourierSandboxVerificationStatus.PASSED);
    assert.equal(item?.verifiedBy, "admin_1");
    assert.ok(item?.verifiedAt);
    assert.equal(JSON.stringify(result).includes("super-secret-token"), false);
    assert.equal(JSON.stringify(state.audits).includes("super-secret-token"), false);
    assert.equal(state.audits.at(-1)?.action, "COURIER_SANDBOX_VERIFICATION_ITEM_UPDATED");
  });

  it("keeps API mode manual until sandbox and courier GSTIN office activation checks pass", async () => {
    const { client, state } = makeOnboardingClient();
    state.courier.gstin = "27AAPFU0939F1ZV";

    await assert.rejects(
      () => setAdminCourierPartnerStatus({
        courierIdOrOnboardingId: "courier_1",
        actorId: "admin_1",
        status: CourierPartnerOnboardingStatus.LIVE,
        note: "Enable API mode."
      }, client),
      /COURIER_SANDBOX_VERIFICATION_INCOMPLETE/
    );
    assert.equal(state.courier.apiMode, "manual");

    for (const item of SANDBOX_VERIFICATION_ITEMS) {
      await updateCourierSandboxVerificationItem({
        courierIdOrOnboardingId: "courier_1",
        itemKey: item.itemKey,
        actorId: "admin_1",
        patch: { status: CourierSandboxVerificationStatus.PASSED }
      }, client);
    }

    await assert.rejects(
      () => setAdminCourierPartnerStatus({
        courierIdOrOnboardingId: "courier_1",
        actorId: "admin_1",
        status: CourierPartnerOnboardingStatus.LIVE,
        note: "Checklist complete."
      }, client),
      /COURIER_VERIFIED_GSTIN_REQUIRED/
    );
    assert.equal(state.courier.apiMode, "manual");
    assert.equal(state.audits.some((audit) => audit.action === "COURIER_PARTNER_ACTIVATION_BLOCKED_TAX_COMPLIANCE"), true);

    state.courierGstins.push({
      id: "courier_gstin_1",
      courierId: "courier_1",
      gstin: "27AAPFU0939F1ZV",
      legalName: "Northline Express",
      tradeName: null,
      registrationStatus: "Active",
      registeredAddress: null,
      registeredState: "MAHARASHTRA",
      registeredPincode: "400001",
      source: "ADMIN",
      verificationStatus: AccountGstinVerificationStatus.VERIFIED,
      verifiedAt: now,
      verifiedBy: "admin_1",
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now
    });
    state.courierLocations.push({
      id: "courier_location_1",
      courierId: "courier_1",
      linkedGstinId: "courier_gstin_1",
      label: "Mumbai office",
      contactName: "Courier Ops",
      phone: "9876543210",
      email: "ops@northline.example",
      addressLine1: "QA Industrial Estate",
      addressLine2: null,
      city: "Mumbai",
      state: "MAHARASHTRA",
      pincode: "400001",
      status: PickupPointStatus.APPROVED,
      isDefault: true,
      blockerReason: null,
      approvedAt: now,
      approvedBy: "admin_1",
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now
    });
    state.rateCards.push({ id: "rate_1", courierId: "courier_1" });
    state.serviceablePincodes.push({ id: "pincode_1", courierId: "courier_1", pincode: "400001", active: true });

    await setAdminCourierPartnerStatus({
      courierIdOrOnboardingId: "courier_1",
      actorId: "admin_1",
      status: CourierPartnerOnboardingStatus.LIVE,
      note: "Checklist complete."
    }, client);

    assert.equal(state.courier.apiMode, "live");
    assert.equal(state.courier.active, true);
  });

  it("redacts obvious secret material in arbitrary audit metadata", () => {
    const redacted = redactSecrets({
      nested: {
        webhookSecret: "do-not-keep",
        notes: "api_key=abc123 should disappear"
      }
    });

    assert.equal(JSON.stringify(redacted).includes("do-not-keep"), false);
    assert.equal(JSON.stringify(redacted).includes("abc123"), false);
  });
});
