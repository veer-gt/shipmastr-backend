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
  GcsWeightProofStorageAdapter,
  InMemoryWeightProofStorageAdapter,
  R2WeightProofStorageAdapter,
  resolveGcsWeightProofStorageConfig,
  resolveR2WeightProofStorageConfig
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

function makeContext(client: any, storage: any = new InMemoryWeightProofStorageAdapter(), options: { headObjectRetryDelaysMs?: number[] } = {}) {
  return {
    merchantId: "seller_123",
    storage,
    client,
    now: () => new Date("2026-06-22T10:00:00.000Z"),
    idFactory: () => "capture_123",
    headObjectRetryDelaysMs: options.headObjectRetryDelaysMs ?? []
  };
}

function makeR2Adapter(options: {
  send?: (command: any) => Promise<any>;
  presigner?: (client: any, command: any, options: { expiresIn: number }) => Promise<string>;
  maxImageBytes?: number;
} = {}) {
  return new R2WeightProofStorageAdapter({
    bucket: "private-weight-proofs",
    endpoint: "https://account.example.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: "test",
    secretAccessKey: "test",
    signedGetTtlMs: 300000,
    maxImageBytes: options.maxImageBytes ?? 10 * 1024 * 1024,
    client: {
      send: options.send ?? (async () => ({}))
    } as any,
    presigner: options.presigner as any
  });
}

const r2ObjectKey = "weight-proofs/seller_123/2026/06/AWB_123/capture_123.jpg";

function makeGcsAdapter(options: {
  accessTokenProvider?: () => Promise<string | { token?: string | null } | null>;
  authClient?: any;
  diagnostics?: (diagnostic: any) => void;
  getSignedUrl?: (config: any) => Promise<[string]>;
  getMetadata?: () => Promise<[any]>;
  iamSignBlobRequest?: (input: any) => Promise<any>;
  maxImageBytes?: number;
  runtimeSigner?: (input: any) => Promise<string>;
  serviceAccountEmailResolver?: () => Promise<string | null | undefined>;
  signingServiceAccount?: string;
} = {}) {
  const calls: any[] = [];
  const adapter = new GcsWeightProofStorageAdapter({
    bucket: "private-weight-proofs",
    projectId: "shipmastr-core-prod",
    signingServiceAccount: options.signingServiceAccount,
    signedGetTtlMs: 300000,
    maxImageBytes: options.maxImageBytes ?? 10 * 1024 * 1024,
    accessTokenProvider: options.accessTokenProvider,
    authClient: options.authClient,
    diagnostics: options.diagnostics,
    iamSignBlobRequest: options.iamSignBlobRequest,
    runtimeSigner: options.runtimeSigner,
    serviceAccountEmailResolver: options.serviceAccountEmailResolver,
    bucketClient: {
      file: (objectKey: string) => ({
        getSignedUrl: async (config: any) => {
          calls.push({ method: "getSignedUrl", objectKey, config });
          if (options.getSignedUrl) return options.getSignedUrl(config);
          return [`https://signed.example/gcs-${config.action}`];
        },
        getMetadata: async () => {
          calls.push({ method: "getMetadata", objectKey });
          if (options.getMetadata) return options.getMetadata();
          return [{
            size: "2048",
            contentType: "image/jpeg",
            updated: "2026-06-22T10:05:00.000Z"
          }];
        }
      })
    }
  });
  return { adapter, calls };
}

function fakeBase64Signature(value = "shipmastr-runtime-signature") {
  return Buffer.from(value, "utf8").toString("base64");
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
    }, context), /WEIGHT_GUARD_OBJECT_NOT_FOUND/);
  });

  it("retries object verification briefly before finalizing", async () => {
    const client = makeClient();
    let headCalls = 0;
    const storage = {
      createPresignedPutUrl: async () => ({
        uploadUrl: "mock://weight-proof-put/retry",
        method: "PUT" as const,
        headers: { "content-type": "image/jpeg" },
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      }),
      headObject: async () => {
        headCalls += 1;
        if (headCalls < 3) return { exists: false };
        return {
          exists: true,
          contentLength: 2048,
          contentType: "image/jpeg",
          updatedAt: new Date("2026-06-22T10:05:00.000Z")
        };
      },
      createPresignedGetUrl: async () => ({
        downloadUrl: "mock://weight-proof-get/retry",
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      })
    };
    const context = makeContext(client, storage, { headObjectRetryDelaysMs: [0, 0] });
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    const result = await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context);

    assert.equal(headCalls, 3);
    assert.equal(result.finalized, true);
    assert.equal(result.proof.proof_status, "captured");
  });

  it("maps object head failures to a safe upload verification category", async () => {
    const client = makeClient();
    const storage = {
      createPresignedPutUrl: async () => ({
        uploadUrl: "mock://weight-proof-put/head-failure",
        method: "PUT" as const,
        headers: { "content-type": "image/jpeg" },
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      }),
      headObject: async () => {
        throw new HttpError(503, "WEIGHT_GUARD_OBJECT_HEAD_FAILED", {
          imageObjectKey: r2ObjectKey,
          bucket: "private-weight-proofs",
          signedUrl: "https://signed.example/unsafe"
        });
      },
      createPresignedGetUrl: async () => ({
        downloadUrl: "mock://weight-proof-get/head-failure",
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      })
    };
    const context = makeContext(client, storage, { headObjectRetryDelaysMs: [0] });
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    await assert.rejects(() => finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED");
      const text = JSON.stringify(error);
      assert.doesNotMatch(text, /weight-proofs\/seller_123|imageObjectKey|image_object_key|private-weight-proofs|signed\.example/i);
      return true;
    });
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
            signedGetTtlMs: 300000,
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
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_STORAGE_DISABLED"
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
    assert.equal(Object.prototype.hasOwnProperty.call(routeResponse, "objectKey"), false);
    assert.match(String(routeResponse.uploadUrl), /^mock:\/\/weight-proof-put\//);
    assert.deepEqual(routeResponse.requiredHeaders, { "Content-Type": "image/png" });
    assert.doesNotMatch(JSON.stringify(routeResponse), /weight-proofs\/seller_123|imageObjectKey|image_object_key/i);
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

  it("rejects missing R2 storage configuration safely", () => {
    assert.throws(
      () => createWeightProofStorageRuntime({
        WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
        WEIGHT_GUARD_STORAGE_PROVIDER: "r2"
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_STORAGE_MISCONFIGURED"
    );
  });

  it("builds the R2 S3 endpoint from account id without public developer URLs", () => {
    const config = resolveR2WeightProofStorageConfig({
      WEIGHT_GUARD_R2_ACCOUNT_ID: "shipmastr-account",
      WEIGHT_GUARD_R2_ACCESS_KEY_ID: "test",
      WEIGHT_GUARD_R2_SECRET_ACCESS_KEY: "test",
      WEIGHT_GUARD_R2_BUCKET: "private-weight-proofs"
    });

    assert.equal(config.endpoint, "https://shipmastr-account.r2.cloudflarestorage.com");
    assert.doesNotMatch(config.endpoint, /r2\.dev/i);
    assert.equal(config.region, "auto");
  });

  it("rejects public R2 developer endpoints as storage config", () => {
    assert.throws(
      () => resolveR2WeightProofStorageConfig({
        WEIGHT_GUARD_R2_ENDPOINT: ["https://pub-example.r2", "dev"].join("."),
        WEIGHT_GUARD_R2_ACCESS_KEY_ID: "test",
        WEIGHT_GUARD_R2_SECRET_ACCESS_KEY: "test",
        WEIGHT_GUARD_R2_BUCKET: "private-weight-proofs"
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_STORAGE_MISCONFIGURED"
    );
  });

  it("creates R2 presigned PUT URLs through an injected presigner only", async () => {
    const presignCalls: any[] = [];
    const adapter = makeR2Adapter({
      presigner: async (_client, command, options) => {
        presignCalls.push({ command, options });
        return "https://signed.example/put";
      }
    });

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/jpeg",
      expectedByteSize: 1024,
      expiresAt: new Date(Date.now() + 600000)
    });

    assert.equal(result.uploadUrl, "https://signed.example/put");
    assert.equal(result.method, "PUT");
    assert.deepEqual(result.headers, { "content-type": "image/jpeg" });
    assert.equal(presignCalls.length, 1);
    assert.equal(presignCalls[0].command.input.Bucket, "private-weight-proofs");
    assert.equal(presignCalls[0].command.input.Key, r2ObjectKey);
    assert.equal(presignCalls[0].command.input.ContentType, "image/jpeg");
    assert.equal(presignCalls[0].command.input.ContentLength, 1024);
    assert.equal(presignCalls[0].command.input.ACL, undefined);
    assert.ok(presignCalls[0].options.expiresIn > 0);
  });

  it("checks R2 object metadata through the injected client", async () => {
    const lastModified = new Date("2026-06-22T10:05:00.000Z");
    const adapter = makeR2Adapter({
      send: async (command) => {
        assert.equal(command.input.Bucket, "private-weight-proofs");
        assert.equal(command.input.Key, r2ObjectKey);
        return {
          ContentLength: 2048,
          ContentType: "image/png",
          LastModified: lastModified
        };
      }
    });

    const object = await adapter.headObject({ objectKey: r2ObjectKey });
    assert.equal(object.exists, true);
    assert.equal(object.contentLength, 2048);
    assert.equal(object.contentType, "image/png");
    assert.equal(object.updatedAt, lastModified);
  });

  it("handles R2 HeadObject not found and unsafe failures without leaking config", async () => {
    const missing = makeR2Adapter({
      send: async () => {
        throw Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 }
        });
      }
    });
    assert.deepEqual(await missing.headObject({ objectKey: r2ObjectKey }), { exists: false });

    const failed = makeR2Adapter({
      send: async () => {
        throw new Error("connection failed with internal details");
      }
    });
    await assert.rejects(
      () => failed.headObject({ objectKey: r2ObjectKey }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_OBJECT_HEAD_FAILED"
    );
  });

  it("keeps signed GET URLs internal to the storage adapter", async () => {
    const adapter = makeR2Adapter({
      presigner: async () => "https://signed.example/get"
    });

    const result = await adapter.createPresignedGetUrl({
      objectKey: r2ObjectKey,
      expiresAt: new Date(Date.now() + 300000)
    });
    assert.equal(result.downloadUrl, "https://signed.example/get");

    const sellerSafe = serializeWeightProofSellerSafe({
      id: "proof_1",
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      volumetricWeightGrams: 1200,
      chargeableWeightGrams: 1200,
      capturedAt: new Date("2026-06-22T10:05:00.000Z"),
      createdAt: new Date("2026-06-22T10:05:00.000Z")
    });
    assert.doesNotMatch(JSON.stringify(sellerSafe), /signed\.example|downloadUrl|download_url|imageObjectKey|image_object_key/i);
  });

  it("preserves R2 content type and max byte validation", async () => {
    let presignCalls = 0;
    const adapter = makeR2Adapter({
      maxImageBytes: 1024,
      presigner: async () => {
        presignCalls += 1;
        return "https://signed.example/put";
      }
    });

    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "application/pdf",
        expectedByteSize: 100,
        expiresAt: new Date(Date.now() + 600000)
      }),
      /WEIGHT_PROOF_CONTENT_TYPE_INVALID/
    );
    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "image/png",
        expectedByteSize: 2048,
        expiresAt: new Date(Date.now() + 600000)
      }),
      /WEIGHT_GUARD_IMAGE_TOO_LARGE/
    );
    assert.equal(presignCalls, 0);
  });

  it("rejects missing GCS bucket configuration safely", () => {
    assert.throws(
      () => createWeightProofStorageRuntime({
        WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
        WEIGHT_GUARD_STORAGE_PROVIDER: "gcs"
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_GCS_MISCONFIGURED"
    );
  });

  it("resolves GCS storage config with the Shipmastr staging project default", () => {
    const config = resolveGcsWeightProofStorageConfig({
      WEIGHT_GUARD_GCS_BUCKET: "private-weight-proofs",
      WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT: "shipmastr-runner@example.iam.gserviceaccount.com"
    });

    assert.equal(config.bucket, "private-weight-proofs");
    assert.equal(config.projectId, "shipmastr-core-prod");
    assert.equal(config.signingServiceAccount, "shipmastr-runner@example.iam.gserviceaccount.com");
    assert.equal(config.signedGetTtlMs, 300000);
    assert.equal(config.maxImageBytes, 10 * 1024 * 1024);
  });

  it("creates GCS signed PUT URLs through an injected bucket only", async () => {
    const { adapter, calls } = makeGcsAdapter();

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/png",
      expectedByteSize: 1024,
      expiresAt: new Date("2026-06-22T10:10:00.000Z")
    });

    assert.equal(result.uploadUrl, "https://signed.example/gcs-write");
    assert.equal(result.method, "PUT");
    assert.deepEqual(result.headers, { "content-type": "image/png" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].objectKey, r2ObjectKey);
    assert.deepEqual(calls[0].config, {
      version: "v4",
      action: "write",
      expires: new Date("2026-06-22T10:10:00.000Z"),
      contentType: "image/png"
    });
  });

  it("uses explicit signer directly for GCS signed PUT URLs without metadata email lookup", async () => {
    const runtimeSignCalls: any[] = [];
    const gcsHost = ["storage", "googleapis", "com"].join(".");
    let metadataEmailCalls = 0;
    const { adapter, calls } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "metadata-runner@example.iam.gserviceaccount.com";
      },
      getSignedUrl: async () => {
        throw new Error("GCS library signer should be bypassed when explicit signer is configured");
      },
      runtimeSigner: async (input) => {
        runtimeSignCalls.push(input);
        return fakeBase64Signature("signed-put");
      }
    });

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/png",
      expectedByteSize: 1024,
      expiresAt: new Date(Date.now() + 600000)
    });

    assert.equal(result.method, "PUT");
    assert.deepEqual(result.headers, {
      "content-type": "image/png",
      "x-goog-content-sha256": "UNSIGNED-PAYLOAD"
    });
    assert.equal(calls.length, 0);
    assert.equal(metadataEmailCalls, 0);
    assert.equal(runtimeSignCalls.length, 1);
    assert.equal(runtimeSignCalls[0].serviceAccountEmail, "shipmastr-runner@example.iam.gserviceaccount.com");
    assert.match(runtimeSignCalls[0].stringToSign, /^GOOG4-RSA-SHA256\n/);
    assert.match(result.uploadUrl, new RegExp(`^https://${gcsHost}/private-weight-proofs/weight-proofs/seller_123/`));
    assert.match(result.uploadUrl, /X-Goog-Algorithm=GOOG4-RSA-SHA256/);
    assert.match(result.uploadUrl, /X-Goog-Signature=7369676e65642d707574/);
  });

  it("infers the GCS signing service account through a runtime resolver when credentials omit it", async () => {
    const signBlobCalls: any[] = [];
    const { adapter } = makeGcsAdapter({
      getSignedUrl: async () => {
        throw new Error("library signer unavailable");
      },
      serviceAccountEmailResolver: async () => "shipmastr-runner@example.iam.gserviceaccount.com",
      authClient: {
        getCredentials: async () => ({}),
        getAccessToken: async () => ({ token: "local-adc-token" })
      },
      iamSignBlobRequest: async (request) => {
        signBlobCalls.push(request);
        return { signedBlob: fakeBase64Signature("signed-by-metadata-email") };
      }
    });

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/png",
      expectedByteSize: 100,
      expiresAt: new Date(Date.now() + 600000)
    });

    assert.equal(signBlobCalls.length, 1);
    assert.match(signBlobCalls[0].url, /projects\/-\/serviceAccounts\/shipmastr-runner%40example\.iam\.gserviceaccount\.com:signBlob/);
    assert.equal(signBlobCalls[0].accessToken, "local-adc-token");
    assert.equal(typeof signBlobCalls[0].payload, "string");
    assert.equal(result.headers["x-goog-content-sha256"], "UNSIGNED-PAYLOAD");
    assert.match(result.uploadUrl, /X-Goog-SignedHeaders=.*x-goog-content-sha256/);
  });

  it("uses the configured GCS signing service account through IAM signBlob with a token provider", async () => {
    const signBlobCalls: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "metadata-runner@example.iam.gserviceaccount.com";
      },
      getSignedUrl: async () => {
        throw new Error("GCS library signer should be bypassed when explicit signer is configured");
      },
      accessTokenProvider: async () => "adc-runtime-token",
      iamSignBlobRequest: async (request) => {
        signBlobCalls.push(request);
        return { signedBlob: fakeBase64Signature("signed-by-iam") };
      }
    });

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/jpeg",
      expectedByteSize: 100,
      expiresAt: new Date(Date.now() + 600000)
    });

    assert.equal(metadataEmailCalls, 0);
    assert.equal(signBlobCalls.length, 1);
    assert.match(signBlobCalls[0].url, /iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/shipmastr-runner%40example\.iam\.gserviceaccount\.com:signBlob/);
    assert.equal(signBlobCalls[0].accessToken, "adc-runtime-token");
    assert.equal(typeof signBlobCalls[0].payload, "string");
    assert.match(result.uploadUrl, /X-Goog-Signature=7369676e65642d62792d69616d/);
  });

  it("classifies invalid configured GCS signer without calling metadata email lookup", async () => {
    const diagnostics: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter } = makeGcsAdapter({
      signingServiceAccount: "not-an-email",
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "metadata-runner@example.iam.gserviceaccount.com";
      },
      accessTokenProvider: async () => "adc-runtime-token",
      iamSignBlobRequest: async () => ({ signedBlob: fakeBase64Signature("should-not-sign") })
    });

    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "image/jpeg",
        expectedByteSize: 100,
        expiresAt: new Date(Date.now() + 600000)
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_GCS_SIGNED_URL_FAILED"
    );

    assert.equal(metadataEmailCalls, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].category, "WEIGHT_GUARD_GCS_SIGNER_MISCONFIGURED");
  });

  it("maps GCS signed URL failure with safe diagnostics only", async () => {
    const diagnostics: any[] = [];
    const gcsHost = ["storage", "googleapis", "com"].join(".");
    const { adapter } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      getSignedUrl: async () => {
        throw new Error("library signer unavailable");
      },
      runtimeSigner: async () => {
        throw Object.assign(new Error(`permission denied for https://${gcsHost}/${r2ObjectKey} imageObjectKey=${r2ObjectKey} in private-weight-proofs`), {
          name: "SigningError",
          code: 403
        });
      }
    });

    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "image/png",
        expectedByteSize: 1024,
        expiresAt: new Date(Date.now() + 600000)
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_GCS_SIGNED_URL_FAILED"
    );

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].provider, "gcs");
    assert.equal(diagnostics[0].operation, "signed_put");
    assert.equal(diagnostics[0].category, "GCS_PERMISSION_DENIED");
    assert.equal(diagnostics[0].bucketConfigured, true);
    assert.equal(diagnostics[0].projectConfigured, true);
    const text = JSON.stringify(diagnostics[0]);
    assert.match(text, /object-key-redacted/);
    assert.doesNotMatch(text, /private-weight-proofs|shipmastr-core-prod|shipmastr-runner@example|storage[.]googleapis[.]com|weight-proofs\/seller_123|X-Goog-Signature|signed\.example/i);
  });

  it("fails GCS init signing safely when no service account identity can be resolved", async () => {
    const diagnostics: any[] = [];
    const { adapter } = makeGcsAdapter({
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      getSignedUrl: async () => {
        throw new Error("library signer unavailable");
      },
      serviceAccountEmailResolver: async () => null,
      authClient: {
        getCredentials: async () => ({})
      }
    });

    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "image/jpeg",
        expectedByteSize: 100,
        expiresAt: new Date(Date.now() + 600000)
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_GCS_SIGNED_URL_FAILED"
    );

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].category, "GCS_SIGNING_FAILED");
    const text = JSON.stringify(diagnostics[0]);
    assert.doesNotMatch(text, /weight-proofs\/seller_123|private-weight-proofs|storage[.]googleapis[.]com|X-Goog-Signature/i);
  });

  it("checks GCS object metadata through an injected bucket", async () => {
    const { adapter, calls } = makeGcsAdapter({
      getMetadata: async () => [{
        size: "4096",
        contentType: "image/png",
        updated: "2026-06-22T10:06:00.000Z"
      }]
    });

    const object = await adapter.headObject({ objectKey: r2ObjectKey });
    assert.equal(object.exists, true);
    assert.equal(object.contentLength, 4096);
    assert.equal(object.contentType, "image/png");
    assert.deepEqual(object.updatedAt, new Date("2026-06-22T10:06:00.000Z"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "getMetadata");
  });

  it("handles GCS missing objects and metadata failures without leaking config", async () => {
    const missing = makeGcsAdapter({
      getMetadata: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      }
    });
    await assert.rejects(
      () => missing.adapter.headObject({ objectKey: r2ObjectKey }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_GCS_OBJECT_NOT_FOUND"
    );

    const failed = makeGcsAdapter({
      getMetadata: async () => {
        throw new Error("internal storage details");
      }
    });
    await assert.rejects(
      () => failed.adapter.headObject({ objectKey: r2ObjectKey }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_OBJECT_HEAD_FAILED"
    );
  });

  it("keeps GCS signed GET URLs internal to the storage adapter", async () => {
    const { adapter } = makeGcsAdapter({
      getSignedUrl: async (config) => [`https://signed.example/gcs-${config.action}`]
    });

    const result = await adapter.createPresignedGetUrl({
      objectKey: r2ObjectKey,
      expiresAt: new Date("2026-06-22T10:10:00.000Z")
    });
    assert.equal(result.downloadUrl, "https://signed.example/gcs-read");

    const sellerSafe = serializeWeightProofSellerSafe({
      id: "proof_1",
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      volumetricWeightGrams: 1200,
      chargeableWeightGrams: 1200,
      capturedAt: new Date("2026-06-22T10:05:00.000Z"),
      createdAt: new Date("2026-06-22T10:05:00.000Z")
    });
    assert.doesNotMatch(JSON.stringify(sellerSafe), /signed\.example|downloadUrl|download_url|imageObjectKey|image_object_key/i);
  });

  it("falls back to runtime IAM signing for internal GCS signed GET URLs", async () => {
    const runtimeSignCalls: any[] = [];
    const { adapter } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      getSignedUrl: async () => {
        throw new Error("library signer unavailable");
      },
      runtimeSigner: async (input) => {
        runtimeSignCalls.push(input);
        return fakeBase64Signature("signed-get");
      }
    });

    const result = await adapter.createPresignedGetUrl({
      objectKey: r2ObjectKey,
      expiresAt: new Date(Date.now() + 300000)
    });

    assert.equal(runtimeSignCalls.length, 1);
    assert.match(result.downloadUrl, /X-Goog-Signature=7369676e65642d676574/);
    assert.doesNotMatch(JSON.stringify(serializeWeightProofSellerSafe({
      id: "proof_1",
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      volumetricWeightGrams: 1200,
      chargeableWeightGrams: 1200,
      capturedAt: new Date("2026-06-22T10:05:00.000Z"),
      createdAt: new Date("2026-06-22T10:05:00.000Z")
    })), /downloadUrl|download_url|imageObjectKey|image_object_key|X-Goog-Signature/i);
  });

  it("preserves GCS content type and max byte validation before signing", async () => {
    const { adapter, calls } = makeGcsAdapter({ maxImageBytes: 1024 });

    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "application/pdf",
        expectedByteSize: 100,
        expiresAt: new Date(Date.now() + 600000)
      }),
      /WEIGHT_PROOF_CONTENT_TYPE_INVALID/
    );
    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "image/png",
        expectedByteSize: 2048,
        expiresAt: new Date(Date.now() + 600000)
      }),
      /WEIGHT_GUARD_IMAGE_TOO_LARGE/
    );
    assert.equal(calls.length, 0);
  });
});
