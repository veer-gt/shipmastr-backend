import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  COURIER_DEVELOPER_CREDENTIAL_TYPES,
  authenticateInboundCourierSignature,
  getCourierDeveloperProfile,
  getAdminCourierDeveloperCredentials,
  ingestCourierApiEvent,
  issueCourierDeveloperCredentials,
  revokeCourierDeveloperCredentials,
  rotateCourierDeveloperApiKey,
  upsertCourierWebhookConfig
} from "./courier-developer.service.js";
import { encryptSecretValue, maskSecretValue } from "../courierPartnerOnboarding/onboarding.service.js";

const now = new Date("2026-05-10T15:00:00.000Z");

function makeClient() {
  const state = {
    couriers: [{
      id: "courier_1",
      name: "QA Courier",
      code: "QA",
      active: true,
      apiMode: "sandbox",
      bookingMode: "manual",
      rateCards: [{ id: "rate_1" }],
      serviceablePincodes: [{ id: "pin_1" }],
      gstinRecords: [{ id: "gstin_1", registeredState: "Maharashtra" }],
      operationalLocations: [{ id: "office_1", state: "Maharashtra", linkedGstinId: "gstin_1" }],
      sandboxVerificationChecklist: [],
      pilotChecklist: [],
      webhookConfigs: []
    }] as any[],
    credentials: [] as any[],
    secrets: [] as any[],
    webhookConfigs: [] as any[],
    shipments: [{
      id: "shipment_1",
      courierId: "courier_1",
      awbNumber: "QA-AWB-1",
      status: "pickup_scheduled",
      lastEvent: "",
      orderId: "order_1"
    }] as any[],
    courierEvents: [] as any[],
    apiEvents: [] as any[],
    ndr: [] as any[],
    rto: [] as any[],
    auditLogs: [] as any[]
  };

  const client: any = {
    $transaction: async (callback: any) => callback(client),
    courierPartner: {
      findUnique: async ({ where }: any) => {
        const courier = state.couriers.find((item) => item.id === where.id);
        if (!courier) return null;
        return {
          ...courier,
          webhookConfigs: state.webhookConfigs.filter((config) => config.courierId === courier.id)
        };
      }
    },
    courierDeveloperCredential: {
      findMany: async ({ where }: any) => state.credentials
        .filter((credential) => (
          (!where?.courierId || credential.courierId === where.courierId)
          && (!where?.environment || credential.environment === where.environment)
          && (!where?.credentialType || credential.credentialType === where.credentialType)
          && (!where?.status || credential.status === where.status)
        ))
        .map((credential) => ({
          ...credential,
          courier: state.couriers.find((courier) => courier.id === credential.courierId)
        })),
      findFirst: async ({ where }: any) => state.credentials.find((credential) => (
        credential.courierId === where.courierId
        && (!where.environment || credential.environment === where.environment)
        && credential.credentialType === where.credentialType
        && (!where.status || credential.status === where.status)
      )) || null,
      create: async ({ data }: any) => {
        const credential = {
          id: `credential_${state.credentials.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.credentials.push(credential);
        return credential;
      },
      update: async ({ where, data }: any) => {
        const credential = state.credentials.find((item) => item.id === where.id);
        Object.assign(credential, data, { updatedAt: now });
        return credential;
      }
    },
    courierPartnerSecret: {
      create: async ({ data }: any) => {
        const secret = { id: `secret_${state.secrets.length + 1}`, createdAt: now, updatedAt: now, ...data };
        state.secrets.push(secret);
        return secret;
      },
      findUnique: async ({ where }: any) => state.secrets.find((secret) => secret.secretRef === where.secretRef) || null
    },
    courierWebhookConfig: {
      findFirst: async ({ where }: any) => state.webhookConfigs.find((config) => config.courierId === where.courierId) || null,
      findMany: async ({ where }: any) => state.webhookConfigs.filter((config) => config.courierId === where.courierId),
      create: async ({ data }: any) => {
        const config = { id: `webhook_${state.webhookConfigs.length + 1}`, createdAt: now, updatedAt: now, ...data };
        state.webhookConfigs.push(config);
        return config;
      },
      update: async ({ where, data }: any) => {
        const config = state.webhookConfigs.find((item) => item.id === where.id);
        Object.assign(config, data, { updatedAt: now });
        return config;
      }
    },
    courierShipment: {
      findFirst: async ({ where }: any) => state.shipments.find((shipment) => (
        shipment.courierId === where.courierId
        && where.OR.some((condition: any) => condition.id === shipment.id || condition.awbNumber === shipment.awbNumber)
      )) || null,
      update: async ({ where, data }: any) => {
        const shipment = state.shipments.find((item) => item.id === where.id);
        Object.assign(shipment, {
          status: data.status,
          lastEvent: data.lastEvent
        });
        if (data.events?.create) {
          state.courierEvents.push({
            id: `courier_event_${state.courierEvents.length + 1}`,
            courierShipmentId: shipment.id,
            createdAt: now,
            ...data.events.create
          });
        }
        return shipment;
      }
    },
    courierApiEvent: {
      create: async ({ data }: any) => {
        const event = { id: `api_event_${state.apiEvents.length + 1}`, createdAt: now, ...data };
        state.apiEvents.push(event);
        return event;
      },
      findMany: async ({ where }: any) => state.apiEvents.filter((event) => event.courierId === where.courierId)
    },
    courierNdr: {
      upsert: async ({ where, update, create }: any) => {
        let record = state.ndr.find((item) => item.courierShipmentId === where.courierShipmentId);
        if (record) Object.assign(record, update);
        else {
          record = { id: `ndr_${state.ndr.length + 1}`, createdAt: now, updatedAt: now, ...create };
          state.ndr.push(record);
        }
        return record;
      }
    },
    courierRto: {
      upsert: async ({ where, update, create }: any) => {
        let record = state.rto.find((item) => item.courierShipmentId === where.courierShipmentId);
        if (record) Object.assign(record, update);
        else {
          record = { id: `rto_${state.rto.length + 1}`, createdAt: now, updatedAt: now, ...create };
          state.rto.push(record);
        }
        return record;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  const seedCredential = async (type: string, raw: string) => {
    const secretRef = `seed/${type}`;
    const credential = {
      id: `credential_${state.credentials.length + 1}`,
      courierId: "courier_1",
      environment: "sandbox",
      credentialType: type,
      maskedValue: maskSecretValue(raw),
      secretRef,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now
    };
    state.credentials.push(credential);
    state.secrets.push({
      id: `secret_${state.secrets.length + 1}`,
      courierId: "courier_1",
      secretRef,
      ...encryptSecretValue(raw),
      createdAt: now,
      updatedAt: now
    });
    return credential;
  };

  return { client, state, seedCredential };
}

describe("courier developer center service", () => {
  it("lets authorized admins issue sandbox credentials and keeps courier profile masked", async () => {
    const { client, state } = makeClient();

    const issued = await issueCourierDeveloperCredentials({
      courierId: "courier_1",
      actorId: "admin_1",
      actorRole: "MASTER_ADMIN"
    }, client);

    assert.equal(issued.status, "active");
    assert.match(issued.oneTimeSecrets.apiKey, /^smc_/);
    assert.match(issued.oneTimeSecrets.signingSecret, /^whsec_/);
    assert.match(issued.credentials.apiKey?.maskedValue || "", /^\*\*\*\*/);
    assert.match(issued.credentials.signingSecret?.maskedValue || "", /^\*\*\*\*/);
    assert.equal(JSON.stringify(state.auditLogs).includes(issued.oneTimeSecrets.apiKey), false);
    assert.equal(JSON.stringify(state.auditLogs).includes(issued.oneTimeSecrets.signingSecret), false);

    const profile = await getCourierDeveloperProfile({
      courierId: "courier_1",
      actorId: "courier_user_1"
    }, client);

    assert.equal(profile.courier.apiMode, "sandbox");
    assert.match(profile.credentials.apiKey?.maskedValue || "", /^\*\*\*\*/);
    assert.match(profile.credentials.signingSecret?.maskedValue || "", /^\*\*\*\*/);
    assert.equal(JSON.stringify(profile).includes("smc_"), false);
    assert.equal(JSON.stringify(profile).includes("whsec_"), false);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_DEVELOPER_CREDENTIALS_ISSUED"), true);
  });

  it("blocks non-admin credential issuance", async () => {
    const { client } = makeClient();

    await assert.rejects(
      () => issueCourierDeveloperCredentials({
        courierId: "courier_1",
        actorId: "ops_1",
        actorRole: "OPS_MANAGER"
      }, client),
      /COURIER_DEVELOPER_CREDENTIAL_ADMIN_ONLY/
    );
  });

  it("returns raw secrets only in issue and rotation responses", async () => {
    const { client } = makeClient();
    const issued = await issueCourierDeveloperCredentials({
      courierId: "courier_1",
      actorId: "admin_1",
      actorRole: "COURIER_MANAGER"
    }, client);

    const adminRead = await getAdminCourierDeveloperCredentials({ courierId: "courier_1" }, client);
    const profile = await getCourierDeveloperProfile({ courierId: "courier_1" }, client);

    assert.equal(JSON.stringify(adminRead).includes(issued.oneTimeSecrets.apiKey), false);
    assert.equal(JSON.stringify(adminRead).includes(issued.oneTimeSecrets.signingSecret), false);
    assert.equal(JSON.stringify(profile).includes(issued.oneTimeSecrets.apiKey), false);
    assert.equal(JSON.stringify(profile).includes(issued.oneTimeSecrets.signingSecret), false);
    assert.equal("oneTimeSecrets" in adminRead, false);
  });

  it("stores webhook config with a masked secret and audit metadata only", async () => {
    const { client, state } = makeClient();

    const result = await upsertCourierWebhookConfig({
      courierId: "courier_1",
      actorId: "courier_user_1",
      targetUrl: "https://courier.example/webhooks/shipmastr",
      active: true,
      events: ["shipment.tracking.updated"]
    }, client);

    assert.equal(result.config.targetUrl, "https://courier.example/webhooks/shipmastr");
    assert.match(result.config.maskedSecret, /^\*\*\*\*/);
    assert.equal(state.webhookConfigs[0]?.secret, result.config.maskedSecret);
    assert.equal(JSON.stringify(state.auditLogs).includes("whsec_"), false);
  });

  it("rejects inbound events with an invalid signature", async () => {
    const { client, seedCredential } = makeClient();
    await seedCredential(COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY, "smc_test_key");
    await seedCredential(COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET, "whsec_test_signing");

    const auth = await authenticateInboundCourierSignature({
      apiKey: "smc_test_key",
      signature: "sha256=bad",
      rawBody: Buffer.from(JSON.stringify({ status: "in_transit" }))
    }, client);

    assert.equal(auth.ok, false);
    assert.equal(auth.error, "INVALID_COURIER_SIGNATURE");
  });

  it("rotates API keys by replacing the active secret reference", async () => {
    const { client, state } = makeClient();
    const issued = await issueCourierDeveloperCredentials({
      courierId: "courier_1",
      actorId: "admin_1",
      actorRole: "MASTER_ADMIN"
    }, client);
    const oldApiKey = issued.oneTimeSecrets.apiKey;
    const oldSecretRef = state.credentials.find((credential) => credential.credentialType === COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY)?.secretRef;

    const rotated = await rotateCourierDeveloperApiKey({
      courierId: "courier_1",
      actorId: "admin_1",
      actorRole: "MASTER_ADMIN"
    }, client);
    const newSecretRef = state.credentials.find((credential) => credential.credentialType === COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY)?.secretRef;
    const rotatedApiKey = rotated.oneTimeSecrets.apiKey || "";

    assert.match(rotatedApiKey, /^smc_/);
    assert.notEqual(rotatedApiKey, oldApiKey);
    assert.notEqual(newSecretRef, oldSecretRef);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_DEVELOPER_API_KEY_ROTATED"), true);

    const rawBody = Buffer.from(JSON.stringify({ status: "in_transit" }));
    const signature = `sha256=${createHmac("sha256", issued.oneTimeSecrets.signingSecret).update(rawBody).digest("hex")}`;
    const oldAuth = await authenticateInboundCourierSignature({ apiKey: oldApiKey, signature, rawBody }, client);
    const newAuth = await authenticateInboundCourierSignature({ apiKey: rotatedApiKey, signature, rawBody }, client);

    assert.equal(oldAuth.ok, false);
    assert.equal(newAuth.ok, true);
  });

  it("revokes credentials and blocks signed inbound events", async () => {
    const { client, state } = makeClient();
    const issued = await issueCourierDeveloperCredentials({
      courierId: "courier_1",
      actorId: "admin_1",
      actorRole: "MASTER_ADMIN"
    }, client);
    const rawBody = Buffer.from(JSON.stringify({ status: "in_transit" }));
    const signature = `sha256=${createHmac("sha256", issued.oneTimeSecrets.signingSecret).update(rawBody).digest("hex")}`;

    const before = await authenticateInboundCourierSignature({ apiKey: issued.oneTimeSecrets.apiKey, signature, rawBody }, client);
    assert.equal(before.ok, true);

    const revoked = await revokeCourierDeveloperCredentials({
      courierId: "courier_1",
      actorId: "admin_1",
      actorRole: "MASTER_ADMIN"
    }, client);
    const after = await authenticateInboundCourierSignature({ apiKey: issued.oneTimeSecrets.apiKey, signature, rawBody }, client);

    assert.equal(revoked.status, "revoked");
    assert.equal(after.ok, false);
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_DEVELOPER_CREDENTIALS_REVOKED"), true);
  });

  it("accepts a signed tracking event and audits ingestion", async () => {
    const { client, state, seedCredential } = makeClient();
    await seedCredential(COURIER_DEVELOPER_CREDENTIAL_TYPES.API_KEY, "smc_test_key");
    await seedCredential(COURIER_DEVELOPER_CREDENTIAL_TYPES.SIGNING_SECRET, "whsec_test_signing");
    const rawBody = Buffer.from(JSON.stringify({ eventId: "evt_1", status: "in_transit", remarks: "Reached QA hub" }));
    const signature = `sha256=${createHmac("sha256", "whsec_test_signing").update(rawBody).digest("hex")}`;

    const auth = await authenticateInboundCourierSignature({
      apiKey: "smc_test_key",
      signature,
      rawBody
    }, client);
    assert.equal(auth.ok, true);

    const result = await ingestCourierApiEvent({
      courierId: auth.ok ? auth.courierId : "",
      shipmentId: "QA-AWB-1",
      eventType: "tracking",
      payload: { eventId: "evt_1", status: "in_transit", remarks: "Reached QA hub" }
    }, client);

    assert.equal(result.event.signatureValid, true);
    assert.equal(state.shipments[0]?.status, "in_transit");
    assert.equal(state.apiEvents[0]?.externalEventId, "evt_1");
    assert.equal(state.courierEvents[0]?.rawPayload.eventId, "evt_1");
    assert.equal(state.auditLogs.some((log) => log.action === "COURIER_API_EVENT_INGESTED"), true);
  });

  it("blocks developer profile for inactive couriers", async () => {
    const { client, state } = makeClient();
    state.couriers[0].active = false;

    await assert.rejects(
      () => getCourierDeveloperProfile({ courierId: "courier_1" }, client),
      /COURIER_DEVELOPER_ACCESS_DISABLED/
    );
  });
});
