import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AddressGeocodeStatus } from "@prisma/client";
import { addressFingerprint } from "./address-fingerprint.js";
import { markAddressForGeocoding, processAddressGeocodeTask } from "./address-geocoding.service.js";

const originalEnabled = process.env.GOOGLE_PICKUP_GEOCODING_ENABLED;
const originalKey = process.env.GOOGLE_GEOCODING_API_KEY;
const originalSoftCap = process.env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP;
const originalHardCap = process.env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP;

const address = {
  addressLine1: "12 Test Market Road",
  addressLine2: "",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "400001",
  country: "IN",
  googlePlaceId: "place_test_1"
};

function resetEnv() {
  if (originalEnabled === undefined) delete process.env.GOOGLE_PICKUP_GEOCODING_ENABLED;
  else process.env.GOOGLE_PICKUP_GEOCODING_ENABLED = originalEnabled;
  if (originalKey === undefined) delete process.env.GOOGLE_GEOCODING_API_KEY;
  else process.env.GOOGLE_GEOCODING_API_KEY = originalKey;
  if (originalSoftCap === undefined) delete process.env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP;
  else process.env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP = originalSoftCap;
  if (originalHardCap === undefined) delete process.env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP;
  else process.env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP = originalHardCap;
}

function setEnabled() {
  process.env.GOOGLE_PICKUP_GEOCODING_ENABLED = "true";
  process.env.GOOGLE_GEOCODING_API_KEY = "test-key-not-real";
  process.env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP = "5000";
  process.env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP = "7000";
}

function makeClient() {
  const state = {
    warehouses: [{
      id: "warehouse_1",
      merchantId: "merchant_1",
      name: "Primary Warehouse",
      contactName: "Ops",
      phone: "9999999999",
      ...address,
      googleGeocodePlaceId: address.googlePlaceId,
      geocodeStatus: AddressGeocodeStatus.SKIPPED,
      addressFingerprint: null,
      latitude: null,
      longitude: null
    }] as any[],
    tasks: [] as any[],
    counters: [] as any[]
  };

  const client = {
    merchantWarehouse: {
      findFirst: async ({ where }: any) => state.warehouses.find((row) => row.id === where.id) || null,
      update: async ({ where, data }: any) => {
        const row = state.warehouses.find((item) => item.id === where.id);
        assert.ok(row);
        Object.assign(row, data);
        return { ...row };
      }
    },
    merchantPickupPoint: {
      findFirst: async () => null,
      update: async () => null
    },
    addressGeocodeTask: {
      findUnique: async ({ where }: any) => state.tasks.find((row) => row.id === where.id) || null,
      upsert: async ({ where, create, update }: any) => {
        const existing = state.tasks.find((row) => (
          row.entityType === where.entityType_entityId_addressFingerprint.entityType &&
          row.entityId === where.entityType_entityId_addressFingerprint.entityId &&
          row.addressFingerprint === where.entityType_entityId_addressFingerprint.addressFingerprint
        ));
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: `task_${state.tasks.length + 1}`, attempts: 0, ...create };
        state.tasks.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = state.tasks.find((item) => item.id === where.id);
        assert.ok(row);
        Object.assign(row, {
          ...data,
          attempts: typeof data.attempts?.increment === "number" ? row.attempts + data.attempts.increment : data.attempts ?? row.attempts
        });
        return { ...row };
      }
    },
    googleMapsUsageCounter: {
      upsert: async ({ where, create, update }: any) => {
        const key = where.service_yearMonth;
        const row = state.counters.find((item) => item.service === key.service && item.yearMonth === key.yearMonth);
        if (row) {
          row.count += update.count.increment;
          row.softLimit = update.softLimit;
          row.hardLimit = update.hardLimit;
          return { ...row };
        }
        state.counters.push({ id: `counter_${state.counters.length + 1}`, ...create });
        return { ...state.counters[state.counters.length - 1] };
      }
    }
  };

  return { state, client: client as any };
}

function makeLogSink() {
  const events: string[] = [];
  const payloads: any[] = [];
  return {
    events,
    payloads,
    log: {
      info: (payload: any, message: string) => {
        events.push(message);
        payloads.push(payload);
      },
      warn: (payload: any, message: string) => {
        events.push(message);
        payloads.push(payload);
      }
    }
  };
}

function noopDispatch() {
  return async () => ({ status: "created" });
}

describe("address geocoding service", () => {
  it("marks an address pending and stores successful geocode metadata", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });

    assert.equal(marked.status, AddressGeocodeStatus.PENDING);
    assert.equal(state.tasks.length, 1);

    const processed = await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => ({
        status: "GEOCODED",
        latitude: 19.076,
        longitude: 72.8777,
        googleGeocodePlaceId: "geocode_place_1",
        googleFormattedAddress: "Mumbai, Maharashtra, India",
        geocodeLocationType: "ROOFTOP",
        geocodePartialMatch: false,
        geocodeErrorCode: null
      })
    });

    assert.equal(processed.status, AddressGeocodeStatus.GEOCODED);
    assert.equal(state.warehouses[0].geocodeStatus, AddressGeocodeStatus.GEOCODED);
    assert.equal(state.warehouses[0].latitude, 19.076);
    resetEnv();
  });

  it("stores low-confidence status for partial matches", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => ({
        status: "LOW_CONFIDENCE",
        latitude: 19,
        longitude: 72,
        geocodePartialMatch: true,
        geocodeLocationType: "APPROXIMATE",
        geocodeErrorCode: "GOOGLE_GEOCODE_LOW_CONFIDENCE"
      })
    });
    assert.equal(state.warehouses[0].geocodeStatus, AddressGeocodeStatus.LOW_CONFIDENCE);
    assert.equal(state.warehouses[0].geocodeErrorCode, "GOOGLE_GEOCODE_LOW_CONFIDENCE");
    resetEnv();
  });

  it("stores failed geocode status without throwing", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => ({
        status: "FAILED",
        geocodeErrorCode: "GOOGLE_GEOCODE_ZERO_RESULTS"
      })
    });
    assert.equal(state.warehouses[0].geocodeStatus, AddressGeocodeStatus.FAILED);
    assert.equal(state.warehouses[0].geocodeErrorCode, "GOOGLE_GEOCODE_ZERO_RESULTS");
    resetEnv();
  });

  it("skips when fingerprint is unchanged", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const fingerprint = addressFingerprint(address);
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address,
      previousAddressFingerprint: fingerprint
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    assert.equal(marked.status, AddressGeocodeStatus.SKIPPED);
    assert.equal(state.tasks.length, 0);
    resetEnv();
  });

  it("marks skipped when feature flag is disabled", async () => {
    resetEnv();
    process.env.GOOGLE_PICKUP_GEOCODING_ENABLED = "false";
    process.env.GOOGLE_GEOCODING_API_KEY = "test-key-not-real";
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    assert.equal(marked.status, AddressGeocodeStatus.SKIPPED);
    assert.equal(state.warehouses[0].geocodeErrorCode, "GOOGLE_GEOCODING_DISABLED");
    resetEnv();
  });

  it("does not geocode after hard quota guard blocks the call", async () => {
    resetEnv();
    setEnabled();
    process.env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP = "0";
    process.env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP = "0";
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    let called = false;
    const processed = await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => {
        called = true;
        return { status: "GEOCODED" };
      }
    });
    assert.equal(called, false);
    assert.equal(processed.status, AddressGeocodeStatus.SKIPPED);
    assert.equal(state.warehouses[0].geocodeErrorCode, "GOOGLE_GEOCODE_QUOTA_HARD_LIMIT");
    resetEnv();
  });

  it("does not geocode when the soft quota cap is reached", async () => {
    resetEnv();
    setEnabled();
    process.env.GOOGLE_GEOCODING_MONTHLY_SOFT_CAP = "1";
    process.env.GOOGLE_GEOCODING_MONTHLY_HARD_CAP = "10";
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    let called = false;
    const processed = await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => {
        called = true;
        return { status: "GEOCODED" };
      }
    });
    assert.equal(called, false);
    assert.equal(processed.status, AddressGeocodeStatus.SKIPPED);
    assert.equal(state.warehouses[0].geocodeErrorCode, "GOOGLE_GEOCODE_QUOTA_SOFT_LIMIT");
    resetEnv();
  });

  it("enqueues a dispatchable address geocode task after address save", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const enqueued: string[] = [];
    const { events, payloads, log } = makeLogSink();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, {
      enqueueAddressGeocodeTask: async (taskId) => {
        enqueued.push(taskId);
        return { status: "created" };
      },
      log
    });

    assert.equal(marked.status, AddressGeocodeStatus.PENDING);
    assert.equal(marked.dispatch?.ok, true);
    assert.equal(marked.dispatch?.status, "created");
    assert.deepEqual(enqueued, ["task_1"]);
    assert.deepEqual(events, [
      "address_geocode_task_enqueue_attempted",
      "address_geocode_task_enqueued"
    ]);
    assert.equal(payloads[0]?.addressGeocode?.taskId, "task_1");
    assert.equal(payloads[1]?.addressGeocode?.status, "created");
    assert.equal(state.tasks.length, 1);
    resetEnv();
  });

  it("keeps address save pending when address geocode enqueue fails", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const { events, payloads, log } = makeLogSink();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, {
      enqueueAddressGeocodeTask: async () => {
        throw new Error("CLOUD_TASKS_ENQUEUE_FAILED");
      },
      log
    });

    assert.equal(marked.status, AddressGeocodeStatus.PENDING);
    assert.equal(marked.dispatch?.ok, false);
    assert.equal(marked.dispatch?.status, "enqueue_failed");
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].status, AddressGeocodeStatus.PENDING);
    assert.deepEqual(events, [
      "address_geocode_task_enqueue_attempted",
      "address_geocode_task_enqueue_failed"
    ]);
    assert.equal(payloads[1]?.addressGeocode?.error, "CLOUD_TASKS_ENQUEUE_FAILED");
    resetEnv();
  });

  it("does not enqueue or geocode again when the address fingerprint is unchanged", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const fingerprint = addressFingerprint(address);
    let enqueued = false;
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address,
      previousAddressFingerprint: fingerprint
    }, client, {
      enqueueAddressGeocodeTask: async () => {
        enqueued = true;
        return { status: "created" };
      }
    });

    assert.equal(marked.status, AddressGeocodeStatus.SKIPPED);
    assert.equal(enqueued, false);
    assert.equal(state.tasks.length, 0);
    resetEnv();
  });

  it("processes an existing pending task without courier payment or messaging side effects", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });

    const forbiddenSideEffects = {
      courier: false,
      payment: false,
      email: false,
      shipment: false
    };
    const processed = await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => ({
        status: "LOW_CONFIDENCE",
        latitude: 19,
        longitude: 72,
        geocodePartialMatch: true,
        geocodeLocationType: "APPROXIMATE",
        geocodeErrorCode: "GOOGLE_GEOCODE_LOW_CONFIDENCE"
      })
    });

    assert.equal(processed.status, AddressGeocodeStatus.LOW_CONFIDENCE);
    assert.equal(state.tasks[0].attempts, 1);
    assert.deepEqual(forbiddenSideEffects, {
      courier: false,
      payment: false,
      email: false,
      shipment: false
    });
    resetEnv();
  });

  it("does not call Google again for an already completed task", async () => {
    resetEnv();
    setEnabled();
    const { state, client } = makeClient();
    const marked = await markAddressForGeocoding({
      entityType: "MERCHANT_WAREHOUSE",
      entityId: "warehouse_1",
      merchantId: "merchant_1",
      address
    }, client, { enqueueAddressGeocodeTask: noopDispatch() });
    state.tasks[0].status = AddressGeocodeStatus.GEOCODED;
    let called = false;
    const processed = await processAddressGeocodeTask(marked.taskId!, client, {
      geocode: async () => {
        called = true;
        return { status: "GEOCODED" };
      }
    });

    assert.equal(called, false);
    assert.equal(processed.status, "already_processed");
    assert.equal(processed.taskStatus, AddressGeocodeStatus.GEOCODED);
    resetEnv();
  });

  it("does not expose the server geocoding key in frontend source", () => {
    const merchantPage = readFileSync("../seller-panel/src/pages/MerchantSetupCrudPage.jsx", "utf8");
    const loader = readFileSync("../seller-panel/src/utils/googleMapsLoader.js", "utf8");
    const autocomplete = readFileSync("../seller-panel/src/components/GoogleAddressAutocomplete.jsx", "utf8");
    const frontendSource = [merchantPage, loader, autocomplete].join("\n");
    assert.doesNotMatch(frontendSource, /GOOGLE_GEOCODING_API_KEY/);
    assert.doesNotMatch(frontendSource, /maps\/api\/geocode/i);
    assert.doesNotMatch(frontendSource, /PlaceDetails|getDetails|nearbySearch|textSearch|DirectionsService|DistanceMatrixService|AddressValidation/i);
  });
});
