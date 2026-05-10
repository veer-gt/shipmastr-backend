import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CourierPartnerApplicationStatus } from "@prisma/client";
import {
  convertCourierPartnerApplication,
  createCourierPartnerApplication,
  listCourierPartnerApplications
} from "./courier-partner-application.service.js";

const now = new Date("2026-05-10T09:00:00.000Z");

function makeApplicationClient() {
  const state = {
    applications: [] as any[],
    auditLogs: [] as any[]
  };

  const client = {
    courierPartnerApplication: {
      create: async ({ data }: any) => {
        const application = {
          id: `cpa_${state.applications.length + 1}`,
          website: null,
          notes: null,
          convertedCourierId: null,
          reviewedAt: null,
          reviewedBy: null,
          createdAt: new Date(now.getTime() + state.applications.length),
          updatedAt: now,
          ...data
        };
        state.applications.push(application);
        return { ...application };
      },
      findMany: async () => [...state.applications].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findUnique: async ({ where }: any) => state.applications.find((application) => application.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const application = state.applications.find((record) => record.id === where.id);
        assert.ok(application);
        Object.assign(application, data, { updatedAt: now });
        return { ...application };
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const auditLog = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(auditLog);
        return auditLog;
      }
    }
  };

  return { client: client as any, state };
}

const validApplication = {
  companyName: "  Pilot Courier Network  ",
  contactName: "  Ops Owner  ",
  phone: " 9876543210 ",
  email: " OPS@PILOTCOURIER.EXAMPLE ",
  website: "",
  gstin: "27aapfu0939f1zv",
  registeredState: " Maharashtra ",
  registeredCity: " Mumbai ",
  operationalStates: ["Maharashtra", " Gujarat ", "Maharashtra"],
  serviceablePincodesEstimate: " 12000+ ",
  codSupported: true,
  apiAvailable: false,
  notes: " Pilot manual booking first "
};

describe("courier partner applications", () => {
  it("stores a public application as pending review and audits without contact details", async () => {
    const { client, state } = makeApplicationClient();

    const result = await createCourierPartnerApplication(validApplication, client);

    assert.deepEqual(result, {
      ok: true,
      applicationId: "cpa_1",
      status: CourierPartnerApplicationStatus.PENDING_REVIEW
    });
    assert.equal(state.applications[0]?.email, "ops@pilotcourier.example");
    assert.equal(state.applications[0]?.gstin, "27AAPFU0939F1ZV");
    assert.deepEqual(state.applications[0]?.operationalStates, ["Maharashtra", "Gujarat"]);
    assert.equal(state.applications[0]?.status, CourierPartnerApplicationStatus.PENDING_REVIEW);
    assert.equal(state.auditLogs[0]?.action, "COURIER_PARTNER_APPLICATION_RECEIVED");
    assert.equal(state.auditLogs[0]?.metadata?.applicationId, "cpa_1");
    assert.equal(state.auditLogs[0]?.metadata?.email, undefined);
    assert.equal(state.auditLogs[0]?.metadata?.phone, undefined);
    assert.equal(state.auditLogs[0]?.metadata?.gstin, undefined);
  });

  it("rejects invalid GSTIN values locally", async () => {
    const { client } = makeApplicationClient();

    await assert.rejects(
      () => createCourierPartnerApplication({ ...validApplication, gstin: "bad-gstin" }, client),
      /INVALID_GSTIN/
    );
  });

  it("lists pending applications for admin review", async () => {
    const { client } = makeApplicationClient();
    await createCourierPartnerApplication(validApplication, client);

    const result = await listCourierPartnerApplications(client);

    assert.equal(result.applications.length, 1);
    assert.equal(result.applications[0]?.companyName, "Pilot Courier Network");
    assert.equal(result.applications[0]?.status, CourierPartnerApplicationStatus.PENDING_REVIEW);
  });

  it("converts an application into a courier partner draft without returning invite links", async () => {
    const { client, state } = makeApplicationClient();
    await createCourierPartnerApplication(validApplication, client);
    const createPartnerCalls: any[] = [];

    const result = await convertCourierPartnerApplication({
      applicationId: "cpa_1",
      actorId: "admin_1"
    }, client, {
      createPartner: async (input: any) => {
        createPartnerCalls.push(input);
        return {
          partner: {
            id: "courier_1",
            name: input.name,
            code: input.code,
            gstin: input.gstin,
            active: true,
            apiMode: "manual",
            onboardingStatus: "DRAFT",
            contactEmail: input.contactEmail
          },
          invite: {
            ok: true,
            inviteLink: "https://shipmastr.com/courier/login?token=secret-reset-token"
          }
        } as any;
      }
    });

    assert.equal(createPartnerCalls[0]?.contactEmail, "ops@pilotcourier.example");
    assert.equal(createPartnerCalls[0]?.gstin, "27AAPFU0939F1ZV");
    assert.equal(result.application.status, CourierPartnerApplicationStatus.CONVERTED);
    assert.equal(result.application.convertedCourierId, "courier_1");
    assert.equal(result.partner.id, "courier_1");
    assert.equal((result as any).invite, undefined);
    assert.equal(state.auditLogs.at(-1)?.action, "COURIER_PARTNER_APPLICATION_CONVERTED");
  });
});
