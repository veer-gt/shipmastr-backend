import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Request } from "express";
import { HttpError } from "../../lib/httpError.js";
import {
  createWeightProofRouteContext,
  serializeFinalizeWeightProofRouteResult,
  serializeInitWeightProofRouteResult
} from "./shipping-network.routes.js";
import {
  calculateChargeableWeightGrams,
  calculateVolumetricWeightGrams,
  finalizeWeightProofCapture,
  initWeightProofCapture,
  validateWeightProofAwbNumber
} from "./shipping-weight-proof.service.js";
import {
  assertWeightProofStorageEnabled,
  buildWeightProofObjectKey,
  createWeightProofStorageRuntime,
  InMemoryWeightProofStorageAdapter
} from "./shipping-weight-proof-storage.js";
import { serializeWeightProofSellerSafe } from "./shipping-weight-proof.serializer.js";

function makeClient() {
  const shipments: any[] = [];
  const sessions: any[] = [];
  const proofs: any[] = [];
  const client = {
    shipment: {
      findFirst: async ({ where }: any) => shipments.find((shipment) => {
        if (where.id && shipment.id !== where.id) return false;
        if (where.sellerId && shipment.sellerId !== where.sellerId) return false;
        if (where.awbNumber && shipment.awbNumber !== where.awbNumber) return false;
        return true;
      }) ?? null
    },
    shippingWeightProofCaptureSession: {
      findFirst: async ({ where }: any) => {
        const rows = sessions.filter((session) => {
          if (where.id && session.id !== where.id) return false;
          if (where.merchantId && session.merchantId !== where.merchantId) return false;
          if (where.awbNumber && session.awbNumber !== where.awbNumber) return false;
          if (where.status && session.status !== where.status) return false;
          if (where.expiresAt?.gt && !(session.expiresAt > where.expiresAt.gt)) return false;
          return true;
        });
        return rows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
      },
      create: async ({ data }: any) => {
        const row = {
          ...data,
          finalizedAt: data.finalizedAt ?? null,
          createdAt: data.createdAt ?? new Date("2026-06-22T10:00:00.000Z"),
          updatedAt: data.updatedAt ?? new Date("2026-06-22T10:00:00.000Z")
        };
        sessions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = sessions.find((session) => session.id === where.id);
        if (!row) throw new Error("session not found");
        Object.assign(row, data, { updatedAt: new Date("2026-06-22T10:05:00.000Z") });
        return row;
      }
    },
    shippingWeightProof: {
      findFirst: async ({ where }: any) => proofs.find((proof) => {
        if (where.id && proof.id !== where.id) return false;
        if (where.captureSessionId && proof.captureSessionId !== where.captureSessionId) return false;
        if (where.merchantId && proof.merchantId !== where.merchantId) return false;
        if (where.awbNumber && proof.awbNumber !== where.awbNumber) return false;
        return true;
      }) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: `proof-${proofs.length + 1}`,
          ...data,
          createdAt: data.createdAt ?? new Date("2026-06-22T10:05:00.000Z")
        };
        proofs.push(row);
        return row;
      }
    },
    $transaction: async (operation: any) => operation(client),
    __state: { shipments, sessions, proofs }
  };
  return client;
}

function makeContext(client: any, storage = new InMemoryWeightProofStorageAdapter()) {
  return {
    merchantId: "seller_123",
    storage,
    client,
    now: () => new Date("2026-06-22T10:00:00.000Z"),
    idFactory: () => "capture_123"
  };
}

describe("shipping weight proof foundation", () => {
  it("calculates volumetric and chargeable weight in grams", () => {
    assert.equal(calculateVolumetricWeightGrams(10, 20, 30), 1200);
    assert.equal(calculateChargeableWeightGrams(900, 1200), 1200);
    assert.equal(calculateChargeableWeightGrams(1500, 1200), 1500);
  });

  it("treats zero dimensions as zero volumetric weight", () => {
    assert.equal(calculateVolumetricWeightGrams(0, 20, 30), 0);
  });

  it("rejects invalid and path-like AWBs", () => {
    assert.throws(() => validateWeightProofAwbNumber("AWB 123"), /WEIGHT_PROOF_AWB_INVALID/);
    assert.throws(() => validateWeightProofAwbNumber("../AWB123"), /WEIGHT_PROOF_AWB_INVALID/);
    assert.throws(() => validateWeightProofAwbNumber("AWB/123"), /WEIGHT_PROOF_AWB_INVALID/);
  });

  it("builds deterministic sanitized object keys", () => {
    const key = buildWeightProofObjectKey({
      sellerOrMerchantId: "seller_123",
      awbNumber: "AWB_123",
      captureSessionId: "capture_123",
      capturedAt: new Date("2026-06-22T10:00:00.000Z")
    });
    assert.equal(key, "weight-proofs/seller_123/2026/06/AWB_123/capture_123.jpg");
    assert.throws(() => buildWeightProofObjectKey({
      sellerOrMerchantId: "seller_123",
      awbNumber: "AWB/123",
      captureSessionId: "capture_123",
      capturedAt: new Date("2026-06-22T10:00:00.000Z")
    }), /AWB_NUMBER_INVALID/);
  });

  it("keeps seller-safe serialization free of storage URLs and object keys", () => {
    const serialized = serializeWeightProofSellerSafe({
      id: "proof_1",
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      volumetricWeightGrams: 1200,
      chargeableWeightGrams: 1200,
      lengthCm: 10,
      widthCm: 20,
      heightCm: 30,
      capturedAt: new Date("2026-06-22T10:05:00.000Z"),
      createdAt: new Date("2026-06-22T10:05:00.000Z")
    });
    const text = JSON.stringify(serialized);
    assert.doesNotMatch(text, /imageObjectKey|image_object_key|signed|downloadUrl|download_url|r2\.dev/i);
    assert.equal(serialized.capture_session_id, "capture_123");
  });

  it("initializes a capture session with mock storage", async () => {
    const client = makeClient();
    const result = await initWeightProofCapture({
      awbNumber: "AWB_123",
      contentType: "image/jpeg",
      expectedByteSize: 1024
    }, makeContext(client));

    assert.equal(result.created, true);
    assert.equal(result.capture?.capture_session_id, "capture_123");
    assert.equal(result.upload?.method, "PUT");
    assert.match(result.upload?.uploadUrl ?? "", /^mock:\/\/weight-proof-put\//);
  });

  it("rejects finalize when the uploaded object is missing", async () => {
    const client = makeClient();
    const context = makeContext(client);
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    await assert.rejects(() => finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context), /WEIGHT_PROOF_OBJECT_NOT_FOUND/);
  });

  it("finalizes proof when the mock object exists", async () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const context = makeContext(client, storage);
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);
    storage.putObject({
      objectKey: "weight-proofs/seller_123/2026/06/AWB_123/capture_123.jpg",
      contentLength: 2048,
      contentType: "image/jpeg"
    });

    const result = await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context);

    assert.equal(result.finalized, true);
    assert.equal(result.idempotent, false);
    assert.equal(result.proof.chargeable_weight_grams, 1200);
    assert.equal(client.__state.sessions[0].status, "FINALIZED");
  });

  it("rejects invalid weights and dimensions", async () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const context = makeContext(client, storage);
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);
    storage.putObject({ objectKey: "weight-proofs/seller_123/2026/06/AWB_123/capture_123.jpg" });

    await assert.rejects(() => finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 0,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context), /WEIGHT_PROOF_DECLARED_WEIGHT_INVALID/);

    await assert.rejects(() => finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: -1, widthCm: 20, heightCm: 30 }
    }, context), /WEIGHT_PROOF_DIMENSIONS_INVALID/);
  });

  it("returns finalized proof idempotently", async () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const context = makeContext(client, storage);
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);
    storage.putObject({ objectKey: "weight-proofs/seller_123/2026/06/AWB_123/capture_123.jpg" });
    await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context);

    const second = await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context);

    assert.equal(second.finalized, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.proof.capture_session_id, "capture_123");
  });

  it("wires authenticated shipping routes for proof capture", () => {
    const routes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    assert.match(routes, /shippingNetworkRouter\.post\("\/weight-proofs\/init"/);
    assert.match(routes, /shippingNetworkRouter\.post\("\/weight-proofs\/finalize"/);
    assert.match(routes, /shippingNetworkRouter\.get\("\/weight-proofs\/:awbNumber"/);
  });

  it("builds route service context from authenticated merchant scope", () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const request = {
      auth: { merchantId: "seller_auth_scope" },
      app: {
        locals: {
          weightProofStorageRuntime: {
            enabled: true,
            provider: "mock",
            storage,
            uploadTtlMs: 600000,
            maxImageBytes: 1024
          },
          weightProofClient: client,
          weightProofNow: () => new Date("2026-06-22T10:00:00.000Z"),
          weightProofIdFactory: () => "route_capture"
        }
      }
    } as unknown as Request;

    const context = createWeightProofRouteContext(request);
    assert.equal(context.merchantId, "seller_auth_scope");
    assert.equal(context.storage, storage);
    assert.equal(context.client, client);
    assert.equal(context.uploadTtlMs, 600000);
  });

  it("returns a safe disabled storage error before live route work", () => {
    const runtime = createWeightProofStorageRuntime({
      WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "false",
      WEIGHT_GUARD_STORAGE_PROVIDER: "mock"
    });
    assert.equal(runtime.enabled, false);
    assert.throws(
      () => assertWeightProofStorageEnabled(runtime),
      (error) => error instanceof HttpError && error.message === "WEIGHT_PROOF_STORAGE_DISABLED"
    );
  });

  it("supports the mock route storage path without external calls", async () => {
    const client = makeClient();
    const runtime = createWeightProofStorageRuntime({
      WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
      WEIGHT_GUARD_STORAGE_PROVIDER: "mock",
      WEIGHT_GUARD_UPLOAD_TTL_SECONDS: "600",
      WEIGHT_GUARD_MAX_IMAGE_BYTES: "1024"
    });
    const request = {
      auth: { merchantId: "seller_123" },
      app: {
        locals: {
          weightProofStorageRuntime: runtime,
          weightProofClient: client,
          weightProofNow: () => new Date("2026-06-22T10:00:00.000Z"),
          weightProofIdFactory: () => "route_capture"
        }
      }
    } as unknown as Request;

    const result = await initWeightProofCapture({
      awbNumber: "AWB_ROUTE",
      contentType: "image/png",
      expectedByteSize: 100
    }, createWeightProofRouteContext(request));
    const routeResponse = serializeInitWeightProofRouteResult(result);

    assert.equal(routeResponse.status, "CAPTURE_SESSION_CREATED");
    assert.equal(routeResponse.captureSessionId, "route_capture");
    assert.equal(routeResponse.objectKey, "weight-proofs/seller_123/2026/06/AWB_ROUTE/route_capture.png");
    assert.match(String(routeResponse.uploadUrl), /^mock:\/\/weight-proof-put\//);
    assert.deepEqual(routeResponse.requiredHeaders, { "Content-Type": "image/png" });
  });

  it("finalizes through route shape without exposing storage fields", async () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const context = makeContext(client, storage);
    await initWeightProofCapture({ awbNumber: "AWB_ROUTE" }, context);
    storage.putObject({ objectKey: "weight-proofs/seller_123/2026/06/AWB_ROUTE/capture_123.jpg" });

    const result = await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      declaredWeightGrams: 1240,
      dimensions: { lengthCm: 22, widthCm: 18, heightCm: 12 }
    }, context);
    const routeResponse = serializeFinalizeWeightProofRouteResult(result);
    const text = JSON.stringify(routeResponse);

    assert.equal(routeResponse.status, "PROOF_LOGGED");
    assert.equal(routeResponse.awbNumber, "AWB_ROUTE");
    assert.equal(routeResponse.declaredWeightGrams, 1240);
    assert.equal(routeResponse.volumetricWeightGrams, 950);
    assert.equal(routeResponse.chargeableWeightGrams, 1240);
    assert.equal(routeResponse.proofStatus, "READY_FOR_DISPUTE");
    assert.doesNotMatch(text, /imageObjectKey|image_object_key|signed|downloadUrl|download_url|r2\.dev/i);
  });
});
