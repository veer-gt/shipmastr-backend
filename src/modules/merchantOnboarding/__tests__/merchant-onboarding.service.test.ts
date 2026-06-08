import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PlatformConnectionStatus, PlatformImportJobMode, PlatformImportSource, StorePlatform } from "@prisma/client";
import {
  completeMerchantStoreOnboarding,
  getMerchantStoreOnboardingState,
  markMerchantOnboardingReconciliationViewed,
  startMerchantOnboardingFirstFetch,
  testMerchantStoreConnection,
  updateMerchantStoreOnboardingState
} from "../merchant-onboarding.service.js";

function makeState(attrs: Record<string, unknown> = {}) {
  const now = new Date("2026-06-08T13:00:00.000Z");
  return {
    id: String(attrs.id || "state_1"),
    merchantId: String(attrs.merchantId || "merchant_1"),
    currentStep: String(attrs.currentStep || "WELCOME"),
    storeConnected: Boolean(attrs.storeConnected),
    credentialsReady: Boolean(attrs.credentialsReady),
    firstFetchCompleted: Boolean(attrs.firstFetchCompleted),
    reconciliationViewed: Boolean(attrs.reconciliationViewed),
    firstConversionCompleted: Boolean(attrs.firstConversionCompleted),
    shippingWorkspaceReady: Boolean(attrs.shippingWorkspaceReady),
    completedAt: (attrs.completedAt as Date | null | undefined) ?? null,
    createdAt: now,
    updatedAt: now
  };
}

function makeConnection(attrs: Record<string, unknown> = {}) {
  const now = new Date("2026-06-08T13:00:00.000Z");
  return {
    id: String(attrs.id || "conn_1"),
    merchantId: String(attrs.merchantId || "merchant_1"),
    platform: (attrs.platform as StorePlatform | undefined) ?? StorePlatform.SHOPIFY,
    storeName: String(attrs.storeName || "Demo Store"),
    storeUrl: String(attrs.storeUrl || "https://demo.myshopify.com"),
    status: (attrs.status as PlatformConnectionStatus | undefined) ?? PlatformConnectionStatus.ACTIVE,
    syncDirection: "IMPORT_ONLY",
    credentialsRef: attrs.credentialsRef ?? "platform-credential:cred_1",
    credentialsMeta: null,
    lastOrderImportAt: null,
    lastTrackingSyncAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    disabledAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function makeClient() {
  const state = {
    onboardingStates: [] as any[],
    connections: [
      makeConnection({ id: "conn_1", merchantId: "merchant_1" }),
      makeConnection({ id: "conn_2", merchantId: "merchant_2", storeName: "Other Store" })
    ],
    orders: [] as any[],
    shipments: [] as any[]
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => (
    Object.entries(where).every(([key, value]) => row[key] === value)
  );

  const client = {
    merchantOnboardingState: {
      findUnique: async ({ where }: any) => state.onboardingStates.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: any) => {
        const row = makeState({
          id: `state_${state.onboardingStates.length + 1}`,
          ...data
        });
        state.onboardingStates.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.onboardingStates.find((item) => matches(item, where));
        assert.ok(row, "onboarding state should exist before update");
        Object.assign(row, data, { updatedAt: new Date("2026-06-08T13:00:00.000Z") });
        return row;
      }
    },
    platformConnection: {
      findFirst: async ({ where }: any) => state.connections.find((row) => matches(row, where)) ?? null
    }
  };

  return { client: client as any, state };
}

describe("Phase 29 merchant store onboarding foundation", () => {
  it("creates and returns merchant-scoped onboarding state", async () => {
    const { client, state } = makeClient();

    const first = await getMerchantStoreOnboardingState("merchant_1", client);
    const second = await getMerchantStoreOnboardingState("merchant_2", client);

    assert.equal(first.merchant_id, "merchant_1");
    assert.equal(second.merchant_id, "merchant_2");
    assert.equal(state.onboardingStates.length, 2);
    assert.equal(first.current_step, "CONNECT_STORE");
  });

  it("updates milestones and derives safe next steps", async () => {
    const { client } = makeClient();
    await getMerchantStoreOnboardingState("merchant_1", client);

    const updated = await updateMerchantStoreOnboardingState("merchant_1", {
      storeConnected: true,
      credentialsReady: true,
      firstFetchCompleted: true
    }, client);
    const viewed = await markMerchantOnboardingReconciliationViewed("merchant_1", client);

    assert.equal(updated.current_step, "REVIEW_RECONCILIATION");
    assert.equal(viewed.current_step, "CONVERT_ELIGIBLE");
    assert.equal(viewed.safety.creates_awb, false);
    assert.equal(viewed.safety.updates_store, false);
  });

  it("tests connection readiness without platform writes", async () => {
    const { client } = makeClient();
    let readinessCalls = 0;

    const result = await testMerchantStoreConnection("merchant_1", { connectionId: "conn_1" }, client, {
      testReadiness: async () => {
        readinessCalls += 1;
        return {
          connection_id: "conn_1",
          platform: "SHOPIFY",
          status: "READY",
          ready: true,
          message: "Credential is ready.",
          credential: null,
          vault: { provider: "LOCAL_MOCK" },
          actions: {}
        } as any;
      }
    });

    assert.equal(readinessCalls, 1);
    assert.equal(result.state.credentials_ready, true);
    assert.equal(result.state.current_step, "FETCH_ORDERS");
    assert.equal(JSON.stringify(result), JSON.stringify(result).replace(/secret|token|encryptedValue|secretRef/gi, ""));
  });

  it("starts the first fetch as a manual read-only import job only", async () => {
    const { client, state } = makeClient();
    let createdInput: any = null;
    let runJobId = "";

    const result = await startMerchantOnboardingFirstFetch("merchant_1", { connectionId: "conn_1", limit: 12 }, client, {
      createImportJob: async (_merchantId, input) => {
        createdInput = input;
        return { job: { job_id: "job_1", mode: input.mode, status: "QUEUED" }, items: [] } as any;
      },
      runImportJob: async (_merchantId, jobId) => {
        runJobId = jobId;
        return { job: { job_id: jobId, mode: "READ_ONLY_FETCH_PLACEHOLDER", status: "COMPLETED" }, items: [] } as any;
      }
    });

    assert.equal(createdInput.mode, PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER);
    assert.equal(createdInput.source, PlatformImportSource.POLLING_PLACEHOLDER);
    assert.deepEqual(createdInput.orders, []);
    assert.equal(createdInput.readOptions.limit, 12);
    assert.equal(runJobId, "job_1");
    assert.equal(result.state.first_fetch_completed, true);
    assert.equal(state.orders.length, 0);
    assert.equal(state.shipments.length, 0);
  });

  it("requires minimum milestones before completion", async () => {
    const { client } = makeClient();
    await assert.rejects(
      () => completeMerchantStoreOnboarding("merchant_1", client),
      /MERCHANT_ONBOARDING_MILESTONES_INCOMPLETE/
    );

    await updateMerchantStoreOnboardingState("merchant_1", {
      storeConnected: true,
      credentialsReady: true,
      firstFetchCompleted: true,
      reconciliationViewed: true,
      firstConversionCompleted: true
    }, client);
    const completed = await completeMerchantStoreOnboarding("merchant_1", client);

    assert.equal(completed.current_step, "COMPLETE");
    assert.equal(completed.shipping_workspace_ready, true);
  });

  it("does not add platform writes, courier calls, labels, AWB, or schedulers", () => {
    const source = readFileSync("src/modules/merchantOnboarding/merchant-onboarding.service.ts", "utf8");
    assert.doesNotMatch(source, /createLabel|getLabel|manifestOrder|getRates|webhook registration|setInterval|cron|sendMail|nodemailer|fulfillment|tracking sync/i);
  });
});
