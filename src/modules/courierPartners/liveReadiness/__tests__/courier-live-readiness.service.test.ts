import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCourierProviderCredential,
  getCourierLiveReadinessSnapshot,
  listCourierLiveProviders,
  revokeCourierProviderCredential,
  testCourierProviderCredential
} from "../courier-live-readiness.service.js";
import { serializeCourierCredential } from "../courier-live-readiness.serializer.js";

function makeClient() {
  const state = {
    credentials: [] as any[],
    probes: [] as any[],
    livePilotMerchant: { merchantId: "merchant_1", status: "ENABLED" },
    capabilities: [
      { merchantId: "merchant_1", capability: "LIVE_COURIER_RATES", status: "ENABLED" },
      { merchantId: "merchant_1", capability: "LIVE_AWB_LABEL", status: "ENABLED" }
    ]
  };
  let credentialSeq = 0;
  let probeSeq = 0;
  const now = () => new Date("2026-06-11T10:00:00.000Z");
  const client = {
    livePilotMerchant: {
      findUnique: async ({ where }: any) => state.livePilotMerchant.merchantId === where.merchantId ? state.livePilotMerchant : null
    },
    livePilotCapability: {
      findMany: async ({ where }: any) => state.capabilities.filter((capability) => capability.merchantId === where.merchantId)
    },
    courierProviderCredential: {
      create: async ({ data }: any) => {
        const record = {
          id: `credential_${++credentialSeq}`,
          merchantId: data.merchantId ?? null,
          providerKey: data.providerKey,
          mode: data.mode,
          status: data.status,
          credentialRef: data.credentialRef ?? null,
          requiredFields: data.requiredFields ?? null,
          safeMeta: data.safeMeta ?? null,
          lastTestedAt: null,
          lastTestStatus: null,
          lastTestSummary: null,
          createdAt: now(),
          updatedAt: now()
        };
        state.credentials.push(record);
        return record;
      },
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = [...state.credentials];
        if (where?.providerKey) rows = rows.filter((row) => row.providerKey === where.providerKey);
        if (where?.mode) rows = rows.filter((row) => row.mode === where.mode);
        if (where?.status) rows = rows.filter((row) => row.status === where.status);
        if (where?.credentialRef?.not === null) rows = rows.filter((row) => row.credentialRef !== null);
        if (where?.lastTestStatus) rows = rows.filter((row) => row.lastTestStatus === where.lastTestStatus);
        if (where?.lastTestedAt?.not === null) rows = rows.filter((row) => row.lastTestedAt !== null);
        if (where?.OR) {
          const merchantIds = where.OR.map((item: any) => item.merchantId);
          rows = rows.filter((row) => merchantIds.includes(row.merchantId));
        }
        if (orderBy?.updatedAt === "desc") rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        if (orderBy?.lastTestedAt === "desc") rows.sort((a, b) => (b.lastTestedAt?.getTime() ?? 0) - (a.lastTestedAt?.getTime() ?? 0));
        return take ? rows.slice(0, take) : rows;
      },
      findFirst: async ({ where }: any) => {
        const rows = await client.courierProviderCredential.findMany({ where });
        return rows.find((row: any) => !where.id || row.id === where.id) ?? null;
      },
      update: async ({ where, data }: any) => {
        const record = state.credentials.find((row) => row.id === where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data, { updatedAt: now() });
        return record;
      }
    },
    courierProviderReadinessProbe: {
      create: async ({ data }: any) => {
        const record = {
          id: `probe_${++probeSeq}`,
          credentialId: data.credentialId ?? null,
          merchantId: data.merchantId ?? null,
          providerKey: data.providerKey,
          probeType: data.probeType,
          mode: data.mode,
          status: data.status,
          safeSummary: data.safeSummary ?? null,
          warnings: data.warnings ?? [],
          errors: data.errors ?? [],
          testedAt: now(),
          createdAt: now()
        };
        state.probes.push(record);
        return record;
      },
      findMany: async ({ where }: any) => state.probes.filter((probe) => probe.credentialId === where.credentialId)
    }
  } as any;
  return { client, state };
}

describe("multi-provider courier live readiness foundation", () => {
  it("lists supported providers and required fields without values", async () => {
    const result = await listCourierLiveProviders();
    assert.deepEqual(result.providers.map((provider) => provider.provider_key), ["BIGSHIP", "SHIPMOZO", "SHIPROCKET"]);
    assert.match(JSON.stringify(result), /clientId|publicKey|email/);
    assert.doesNotMatch(JSON.stringify(result), /secret-value|credentialRef|rawHeaders|rawResponse/);
  });

  it("stores credentialRef only and never serializes secret-like metadata", async () => {
    const { client } = makeClient();
    const result = await createCourierProviderCredential("merchant_1", "SHIPROCKET", {
      mode: "LIVE",
      credential_ref: "vault:shiprocket/live/merchant_1",
      required_fields_present: ["email", "password"],
      safe_meta: {
        credentialHash: "unsafe",
        rawHeaders: "unsafe",
        label: "pilot"
      }
    }, client);

    const json = JSON.stringify(result);
    assert.equal(result.credential.credential_ref_configured, true);
    assert.doesNotMatch(json, /vault:shiprocket|credentialHash|rawHeaders|password-value|secret/i);
  });

  it("reports missing credentials and test-not-run blockers", async () => {
    const { client } = makeClient();
    const result = await createCourierProviderCredential("merchant_1", "SHIPMOZO", {
      mode: "LIVE",
      required_fields_present: ["publicKey", "privateKey"]
    }, client);
    assert.equal(result.credential.status, "MISSING_CREDENTIALS");
    assert.ok(result.credential.blockers.includes("LIVE_PROVIDER_CREDENTIALS_MISSING"));
    assert.ok(result.credential.blockers.includes("LIVE_PROVIDER_TEST_NOT_RUN"));
  });

  it("rejects destructive readiness probes", async () => {
    const { client } = makeClient();
    const created = await createCourierProviderCredential("merchant_1", "BIGSHIP", {
      mode: "LIVE",
      credential_ref: "vault:bigship/live/merchant_1",
      required_fields_present: ["clientId", "clientSecret", "accessKey"]
    }, client);
    await assert.rejects(
      () => testCourierProviderCredential("merchant_1", "BIGSHIP", created.credential.credential_id, {
        probe_type: "CREATE_AWB" as any
      }, client),
      /COURIER_PROVIDER_DESTRUCTIVE_PROBE_REJECTED/
    );
  });

  it("marks a successful non-destructive probe ACTIVE and live-ready", async () => {
    const { client } = makeClient();
    const created = await createCourierProviderCredential("merchant_1", "BIGSHIP", {
      mode: "LIVE",
      credential_ref: "vault:bigship/live/merchant_1",
      required_fields_present: ["clientId", "clientSecret", "accessKey"]
    }, client);
    const tested = await testCourierProviderCredential("merchant_1", "BIGSHIP", created.credential.credential_id, {
      probe_type: "RATE_SERVICEABILITY"
    }, client);
    assert.equal(tested.credential.status, "ACTIVE");
    assert.equal(tested.credential.live_ready, true);
    assert.equal(tested.probe.status, "PASS");
    assert.doesNotMatch(JSON.stringify(tested), /rawPayload|rawHeaders|credentialHash|secretHash|createLabel|getLabel|manifestOrder/i);
  });

  it("marks failed probes FAILED without raw provider output", async () => {
    const { client } = makeClient();
    const created = await createCourierProviderCredential("merchant_1", "SHIPROCKET", {
      mode: "LIVE",
      credential_ref: "vault:shiprocket/live/merchant_1",
      required_fields_present: ["email", "password"]
    }, client);
    const tested = await testCourierProviderCredential("merchant_1", "SHIPROCKET", created.credential.credential_id, {
      probe_type: "PINCODE_SERVICEABILITY",
      safe_context: { force_fail: true }
    }, client);
    assert.equal(tested.credential.status, "FAILED");
    assert.equal(tested.credential.live_ready, false);
    assert.doesNotMatch(JSON.stringify(tested), /rawPayload|rawHeaders|Authorization|Bearer|password-value/i);
  });

  it("revokes credentials and prevents live-ready state", async () => {
    const { client } = makeClient();
    const created = await createCourierProviderCredential("merchant_1", "SHIPMOZO", {
      mode: "LIVE",
      credential_ref: "vault:shipmozo/live/merchant_1",
      required_fields_present: ["publicKey", "privateKey"]
    }, client);
    const revoked = await revokeCourierProviderCredential("merchant_1", "SHIPMOZO", created.credential.credential_id, client);
    assert.equal(revoked.credential.status, "REVOKED");
    assert.equal(revoked.credential.live_ready, false);
  });

  it("summarizes provider readiness and clears when one provider is ACTIVE", async () => {
    const { client } = makeClient();
    const empty = await getCourierLiveReadinessSnapshot("merchant_1", client);
    assert.equal(empty.has_active_provider, false);
    assert.ok(empty.blockers.includes("LIVE_PROVIDER_CREDENTIALS_MISSING"));

    const created = await createCourierProviderCredential("merchant_1", "BIGSHIP", {
      mode: "LIVE",
      credential_ref: "vault:bigship/live/merchant_1",
      required_fields_present: ["clientId", "clientSecret", "accessKey"]
    }, client);
    await testCourierProviderCredential("merchant_1", "BIGSHIP", created.credential.credential_id, {
      probe_type: "PINCODE_SERVICEABILITY"
    }, client);

    const ready = await getCourierLiveReadinessSnapshot("merchant_1", client);
    assert.equal(ready.has_active_provider, true);
    assert.equal(ready.active_provider_count, 1);
  });

  it("enforces merchant scope for credential access", async () => {
    const { client } = makeClient();
    await assert.rejects(
      () => createCourierProviderCredential("merchant_1", "BIGSHIP", {
        merchant_id: "merchant_2",
        mode: "DRY_RUN",
        credential_ref: "vault:bigship/live/merchant_2",
        required_fields_present: ["clientId", "clientSecret", "accessKey"]
      }, client),
      /COURIER_PROVIDER_CREDENTIAL_SCOPE_MISMATCH/
    );
  });

  it("serializer hides refs, hashes, raw payloads, and secret-like values", () => {
    const serialized = serializeCourierCredential({
      id: "credential_1",
      merchantId: "merchant_1",
      providerKey: "SHIPROCKET",
      mode: "LIVE",
      status: "ACTIVE",
      credentialRef: "vault:shiprocket/live/merchant_1",
      requiredFields: ["email", "password"],
      safeMeta: {
        required_fields_present: ["email", "password"],
        rawPayload: { unsafe: true },
        credentialHash: "hash",
        public_note: "safe"
      },
      lastTestedAt: new Date("2026-06-11T10:00:00.000Z"),
      lastTestStatus: "PASS",
      lastTestSummary: {
        rawResponse: { unsafe: true },
        non_destructive: true
      },
      createdAt: new Date("2026-06-11T10:00:00.000Z"),
      updatedAt: new Date("2026-06-11T10:00:00.000Z")
    } as any);
    const json = JSON.stringify(serialized);
    assert.doesNotMatch(json, /vault:shiprocket|rawPayload|rawResponse|credentialHash|secretHash|password-value|Authorization|Bearer/i);
  });
});
