import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type { Request } from "express";
import { HttpError } from "../../lib/httpError.js";
import {
  createWeightProofRouteContext,
  serializeFinalizeWeightProofRouteResult,
  serializeInitWeightProofRouteResult
} from "./shipping-network.routes.js";
import { listShippingShipments } from "./shipping-list.service.js";
import {
  calculateChargeableWeightGrams,
  calculateVolumetricWeightGrams,
  finalizeWeightProofCapture,
  initWeightProofCapture,
  uploadWeightProofImage,
  validateWeightProofAwbNumber
} from "./shipping-weight-proof.service.js";
import {
  assertWeightProofStorageEnabled,
  buildOfficialGcsWriteSignedUrlConfig,
  buildGcsXmlPathStyleObjectPath,
  buildWeightGuardDiagnosticObjectKey,
  buildWeightProofObjectKey,
  createWeightProofStorageRuntime,
  getGcsSignedUrlObjectPathDiagnostics,
  getWeightProofObjectKeyPrefix,
  getWeightProofObjectKeyDiagnostics,
  GcsWeightProofStorageAdapter,
  InMemoryWeightProofStorageAdapter,
  R2WeightProofStorageAdapter,
  resolveGcsWeightProofStorageConfig,
  resolveR2WeightProofStorageConfig
} from "./shipping-weight-proof-storage.js";
import { serializeWeightProofSellerSafe } from "./shipping-weight-proof.serializer.js";

const require = createRequire(import.meta.url);
const putHeadSelfTestScript: any = require("../../../scripts/weight-guard-gcs-put-head-self-test.cjs");
const backendMediatedSelfTestScript: any = require("../../../scripts/weight-guard-backend-mediated-upload-self-test.cjs");

function makeClient() {
  const shipments: any[] = [];
  const sessions: any[] = [];
  const proofs: any[] = [];
  const client = {
    shipment: {
      findMany: async ({ where }: any = {}) => shipments
        .filter((shipment) => {
          if (where?.id && shipment.id !== where.id) return false;
          if (where?.sellerId && shipment.sellerId !== where.sellerId) return false;
          if (where?.awbNumber && shipment.awbNumber !== where.awbNumber) return false;
          if (where?.status && shipment.status !== where.status) return false;
          return true;
        })
        .sort((left, right) => {
          const rightTime = right.createdAt instanceof Date ? right.createdAt.getTime() : 0;
          const leftTime = left.createdAt instanceof Date ? left.createdAt.getTime() : 0;
          return rightTime - leftTime;
        }),
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

function makeVisibleShipment(overrides: Record<string, unknown> = {}) {
  return {
    id: "shipment_visible_1",
    sellerId: "seller_123",
    externalOrderId: "order_visible_1",
    orderId: "order_visible_1",
    status: "manifested",
    segment: "b2c",
    paymentMode: "prepaid",
    pickupLocationId: "pickup_1",
    codAmountPaise: 0,
    declaredValuePaise: 10000,
    deadWeightKg: 1,
    lengthCm: 22,
    breadthCm: 18,
    heightCm: 12,
    volumetricDivisor: 5000,
    volumetricWeightKg: 0.95,
    chargeableWeightKg: 1,
    awbNumber: "AWB_VISIBLE_1",
    serviceLevel: "smart",
    metadata: {
      buyer: {
        name: "Test Buyer",
        phone: "9999999999",
        address: {
          pincode: "400001",
          city: "Mumbai",
          state: "MH"
        }
      },
      invoice: {
        invoice_amount: 100
      },
      phase6: {}
    },
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    updatedAt: new Date("2026-06-22T10:00:00.000Z"),
    ...overrides
  };
}

function makeContext(client: any, storage: any = new InMemoryWeightProofStorageAdapter(), options: {
  headObjectRetryDelaysMs?: number[];
  maxImageBytes?: number;
  uploadMode?: "DIRECT_SIGNED_URL" | "BACKEND_MEDIATED";
} = {}) {
  return {
    merchantId: "seller_123",
    storage,
    client,
    now: () => new Date("2026-06-22T10:00:00.000Z"),
    idFactory: () => "capture_123",
    ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
    ...(options.uploadMode === undefined ? {} : { uploadMode: options.uploadMode }),
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
  getFiles?: (options: any) => Promise<[any[]]>;
  getSignedUrl?: (config: any) => Promise<[string]>;
  getMetadata?: () => Promise<[any]>;
  metadataRequest?: (input: any) => Promise<{ ok: boolean; status: number; metadata?: any }>;
  mediaUploadRequest?: (input: any) => Promise<{ ok: boolean; status: number; metadata?: any }>;
  save?: (data: Buffer | Uint8Array, options: any) => Promise<unknown>;
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
    accessTokenProvider: options.accessTokenProvider ?? (async () => "test-access-token"),
    authClient: options.authClient,
    diagnostics: options.diagnostics,
    iamSignBlobRequest: options.iamSignBlobRequest,
    metadataRequest: async (input: any) => {
      calls.push({
        method: "getMetadata",
        objectKey: input.objectKey,
        hasUrl: Boolean(input.url),
        hasAccessToken: Boolean(input.accessToken)
      });
      if (options.metadataRequest) return options.metadataRequest(input);
      if (options.getMetadata) {
        try {
          const [metadata] = await options.getMetadata();
          return {
            ok: true,
            status: 200,
            metadata: {
              name: input.objectKey,
              ...metadata
            }
          };
        } catch (error) {
          const candidate = error as { code?: string | number };
          if (candidate.code === 404 || candidate.code === "404") {
            return { ok: false, status: 404, metadata: null };
          }
          throw error;
        }
      }
      return {
        ok: true,
        status: 200,
        metadata: {
          name: input.objectKey,
          size: "2048",
          contentType: "image/jpeg",
          updated: "2026-06-22T10:05:00.000Z"
        }
      };
    },
    mediaUploadRequest: async (input: any) => {
      calls.push({
        method: "mediaUpload",
        hasUrl: Boolean(input.url),
        hasAccessToken: Boolean(input.accessToken),
        contentType: input.contentType,
        sizeBytes: input.sizeBytes
      });
      if (options.mediaUploadRequest) return options.mediaUploadRequest(input);
      return {
        ok: true,
        status: 200,
        metadata: {
          name: String(new URL(input.url).searchParams.get("name") ?? ""),
          size: String(input.sizeBytes),
          contentType: input.contentType,
          updated: "2026-06-22T10:06:00.000Z"
        }
      };
    },
    runtimeSigner: options.runtimeSigner,
    serviceAccountEmailResolver: options.serviceAccountEmailResolver,
    bucketClient: {
      getFiles: async (config: any) => {
        calls.push({ method: "getFiles", config });
        if (options.getFiles) return options.getFiles(config);
        return [[]];
      },
      file: (objectKey: string) => ({
        getSignedUrl: async (config: any) => {
          calls.push({ method: "getSignedUrl", objectKey, config });
          if (options.getSignedUrl) return options.getSignedUrl(config);
          return [`https://signed.example/gcs-${config.action}`];
        },
        save: async (data: Buffer | Uint8Array, config: any) => {
          calls.push({ method: "save", objectKey, size: data.byteLength, config });
          if (options.save) return options.save(data, config);
          return undefined;
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
    assert.match(result.upload && "uploadUrl" in result.upload ? result.upload.uploadUrl : "", /^mock:\/\/weight-proof-put\//);
  });

  it("initializes a backend-mediated capture session without signed upload details", async () => {
    const client = makeClient();
    const result = await initWeightProofCapture({
      awbNumber: "AWB_123",
      contentType: "image/png",
      expectedByteSize: 1024
    }, makeContext(client, new InMemoryWeightProofStorageAdapter(), { uploadMode: "BACKEND_MEDIATED" }));

    assert.equal(result.created, true);
    assert.equal(result.upload?.uploadMode, "BACKEND_MEDIATED");
    assert.equal(result.upload?.method, "POST");
    assert.equal(result.upload && "uploadEndpoint" in result.upload ? result.upload.uploadEndpoint : "", "/api/v1/shipping/weight-proofs/upload");
    assert.equal(result.upload && "uploadUrl" in result.upload ? result.upload.uploadUrl : undefined, undefined);
    assert.deepEqual(result.upload?.headers, {});
    assert.doesNotMatch(JSON.stringify(result.upload), /signed|uploadUrl|objectKey|imageObjectKey|storage[.]googleapis|private-weight-proofs/i);
  });

  it("initializes proof capture for a shipment visible in the seller shipment list", async () => {
    const client = makeClient();
    client.__state.shipments.push(makeVisibleShipment());
    const listed = await listShippingShipments("seller_123", { page: 1, per_page: 20 }, client as any);
    const row = listed.shipments.find((shipment) => shipment.awb === "AWB_VISIBLE_1");

    assert.ok(row);
    assert.equal(row.shipment_id, "shipment_visible_1");

    const result = await initWeightProofCapture({
      awbNumber: row.awb ?? "",
      shipmentId: row.shipment_id,
      contentType: "image/png",
      expectedByteSize: 1024
    }, makeContext(client, new InMemoryWeightProofStorageAdapter(), { uploadMode: "BACKEND_MEDIATED" }));
    const routeResponse: any = serializeInitWeightProofRouteResult(result);

    assert.equal(result.created, true);
    assert.equal(client.__state.sessions[0].shipmentId, "shipment_visible_1");
    assert.equal(routeResponse.uploadMode, "BACKEND_MEDIATED");
    assert.equal(routeResponse.uploadEndpoint, "/api/v1/shipping/weight-proofs/upload");
    assert.equal(Object.prototype.hasOwnProperty.call(routeResponse, "uploadUrl"), false);
    assert.doesNotMatch(JSON.stringify(routeResponse), /weight-proofs\/seller_123|imageObjectKey|image_object_key|uploadUrl|private-weight-proofs|storage[.]googleapis|signed/i);
  });

  it("resolves an AWB-backed seller fixture when the optional UI shipment identifier is not primary", async () => {
    const client = makeClient();
    client.__state.shipments.push(makeVisibleShipment({
      id: "wg_stage_ui_fixture_primary_id",
      externalOrderId: "wg_stage_ui_fixture_display_id",
      awbNumber: "WGSTAGEUI003"
    }));
    const listed = await listShippingShipments("seller_123", { page: 1, per_page: 20, search: "WGSTAGEUI003" }, client as any);

    assert.equal(listed.shipments.length, 1);
    assert.equal(listed.shipments[0]?.awb, "WGSTAGEUI003");

    const result = await initWeightProofCapture({
      awbNumber: "WGSTAGEUI003",
      shipmentId: "wg_stage_ui_fixture_display_id",
      contentType: "image/png",
      expectedByteSize: 1024
    }, makeContext(client, new InMemoryWeightProofStorageAdapter(), { uploadMode: "BACKEND_MEDIATED" }));

    assert.equal(result.created, true);
    assert.equal(client.__state.sessions[0].shipmentId, "wg_stage_ui_fixture_primary_id");
    assert.equal(result.upload?.uploadMode, "BACKEND_MEDIATED");
    assert.equal(result.upload && "uploadEndpoint" in result.upload ? result.upload.uploadEndpoint : "", "/api/v1/shipping/weight-proofs/upload");
    assert.doesNotMatch(JSON.stringify(result), /uploadUrl|imageObjectKey|image_object_key|private-weight-proofs|storage[.]googleapis|signed/i);
  });

  it("rejects proof init for not-owned or genuinely missing shipments", async () => {
    const client = makeClient();
    client.__state.shipments.push(makeVisibleShipment({
      id: "shipment_other_seller",
      sellerId: "seller_other",
      awbNumber: "AWB_OTHER_SELLER"
    }));

    await assert.rejects(() => initWeightProofCapture({
      awbNumber: "AWB_OTHER_SELLER",
      shipmentId: "shipment_other_seller"
    }, makeContext(client)), /SHIPMENT_NOT_FOUND/);

    await assert.rejects(() => initWeightProofCapture({
      awbNumber: "AWB_MISSING",
      shipmentId: "shipment_missing"
    }, makeContext(client)), /SHIPMENT_NOT_FOUND/);
  });

  it("rejects proof init when seller-owned shipment ID and AWB point to different shipments", async () => {
    const client = makeClient();
    client.__state.shipments.push(makeVisibleShipment({
      id: "shipment_one",
      awbNumber: "AWB_ONE"
    }));
    client.__state.shipments.push(makeVisibleShipment({
      id: "shipment_two",
      awbNumber: "AWB_TWO"
    }));

    await assert.rejects(() => initWeightProofCapture({
      awbNumber: "AWB_TWO",
      shipmentId: "shipment_one"
    }, makeContext(client)), /WEIGHT_PROOF_AWB_SHIPMENT_MISMATCH/);
  });

  it("uploads proof images through the backend and then finalizes", async () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const context = makeContext(client, storage, { uploadMode: "BACKEND_MEDIATED" });
    await initWeightProofCapture({ awbNumber: "AWB_123", contentType: "image/png" }, context);

    const upload = await uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("safe-test-image"),
        contentType: "image/png",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }
    }, context);

    assert.equal(upload.uploadVerified, true);
    assert.equal(upload.proofStatus, "UPLOAD_VERIFIED");
    assert.equal(upload.nextAction, "FINALIZE");

    const finalized = await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context);

    assert.equal(finalized.finalized, true);
    assert.equal(finalized.proof.proof_status, "captured");
  });

  it("rejects backend upload attempts outside the owning seller scope", async () => {
    const client = makeClient();
    const context = makeContext(client, new InMemoryWeightProofStorageAdapter(), { uploadMode: "BACKEND_MEDIATED" });
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    await assert.rejects(() => uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("safe-test-image"),
        contentType: "image/jpeg",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }
    }, { ...context, merchantId: "seller_other" }), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      assert.equal(error.message, "WEIGHT_GUARD_UPLOAD_FORBIDDEN");
      return true;
    });
  });

  it("validates backend upload file type and size safely", async () => {
    const client = makeClient();
    const context = makeContext(client, new InMemoryWeightProofStorageAdapter(), {
      uploadMode: "BACKEND_MEDIATED",
      maxImageBytes: 4
    });
    await initWeightProofCapture({ awbNumber: "AWB_123", contentType: "image/jpeg" }, context);

    await assert.rejects(() => uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("safe"),
        contentType: "application/pdf",
        sizeBytes: 4
      }
    }, context), /WEIGHT_GUARD_UNSUPPORTED_IMAGE_TYPE/);

    await assert.rejects(() => uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("too-large"),
        contentType: "image/jpeg",
        sizeBytes: 9
      }
    }, context), /WEIGHT_GUARD_UPLOAD_TOO_LARGE/);
  });

  it("keeps backend upload responses seller-safe", async () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const context = makeContext(client, storage, { uploadMode: "BACKEND_MEDIATED" });
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    const upload = await uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("safe-test-image"),
        contentType: "image/jpeg",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }
    }, context);

    const text = JSON.stringify(upload);
    assert.doesNotMatch(text, /weight-proofs\/seller_123|imageObjectKey|image_object_key|objectKey|private-weight-proofs|storage[.]googleapis|signed/i);
  });

  it("guards the backend-mediated staging self-test runner behind explicit approval", () => {
    assert.throws(() => backendMediatedSelfTestScript.assertSelfTestSafety({
      APP_ENV: "staging",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://redacted@cloudsql/staging",
      JWT_SECRET: "test-jwt-secret",
      WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
      WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
      SHIPMASTR_STAGING_API_BASE_URL: "https://shipmastr-api-staging-jscfc5kumq-el.a.run.app"
    }), /approval/i);

    assert.doesNotThrow(() => backendMediatedSelfTestScript.assertSelfTestSafety({
      APP_ENV: "staging",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://redacted@cloudsql/staging",
      JWT_SECRET: "test-jwt-secret",
      WEIGHT_GUARD_BACKEND_UPLOAD_SELF_TEST: backendMediatedSelfTestScript.APPROVAL_FLAG,
      WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
      WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
      SHIPMASTR_STAGING_API_BASE_URL: "https://shipmastr-api-staging-jscfc5kumq-el.a.run.app"
    }));
  });

  it("redacts backend-mediated self-test errors and output", () => {
    const redacted = backendMediatedSelfTestScript.redactText(
      "Bearer token123 imageObjectKey=weight-proofs/seller/2026/06/AWB/session.jpg https://storage.googleapis.com/private-bucket/object?X-Goog-Signature=unsafe DATABASE_URL=postgresql://secret",
      {
        DATABASE_URL: "postgresql://secret",
        JWT_SECRET: "jwt-secret",
        WEIGHT_GUARD_GCS_BUCKET: "private-bucket",
        WEIGHT_GUARD_GCS_PROJECT_ID: "shipmastr-core-prod"
      }
    );
    assert.doesNotMatch(redacted, /token123|weight-proofs\/seller|storage[.]googleapis|private-bucket|postgresql:\/\/secret|X-Goog-Signature/i);

    const output = backendMediatedSelfTestScript.buildSafeOutput({
      authenticatedSellerContext: true,
      testAwb: "WGSTAGEUI999",
      uploadMode: "BACKEND_MEDIATED",
      uploadEndpointPresent: true,
      uploadVerified: true,
      finalizeSucceeded: true,
      getProofSellerSafe: true,
      directSignedUploadUsed: false,
      gcsWriteHappened: true,
      dbMutationScope: "staging_test_session_only"
    });
    assert.doesNotMatch(JSON.stringify(output), /Bearer|Authorization|imageObjectKey|objectKey|bucket|storage[.]googleapis|signedUrl|signed_url|X-Goog|private_key/i);
  });

  it("runs the backend-mediated self-test flow through authenticated API calls without leaking internals", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ method: string; url: string; hasAuthorization: boolean }> = [];
    const makeEnvelope = (data: unknown, status = 200) => new Response(JSON.stringify({
      success: true,
      message: "ok",
      data,
      error: null
    }), {
      status,
      headers: { "Content-Type": "application/json" }
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      calls.push({
        method,
        url,
        hasAuthorization: Boolean((init?.headers as Record<string, string> | undefined)?.Authorization)
      });
      if (url.endsWith("/v1/shipping/weight-proofs/init")) {
        return makeEnvelope({
          status: "CAPTURE_SESSION_CREATED",
          captureSessionId: "capture_self_test",
          awbNumber: "WGSTAGEUI999",
          uploadMode: "BACKEND_MEDIATED",
          uploadEndpoint: "/api/v1/shipping/weight-proofs/upload",
          requiredHeaders: {}
        }, 201);
      }
      if (url.endsWith("/v1/shipping/weight-proofs/upload")) {
        return makeEnvelope({
          status: "UPLOAD_VERIFIED",
          uploadVerified: true,
          proofStatus: "UPLOAD_VERIFIED",
          nextAction: "FINALIZE"
        }, 201);
      }
      if (url.endsWith("/v1/shipping/weight-proofs/finalize")) {
        return makeEnvelope({
          status: "PROOF_LOGGED",
          awbNumber: "WGSTAGEUI999",
          declaredWeightGrams: 1240,
          volumetricWeightGrams: 950,
          chargeableWeightGrams: 1240,
          proofStatus: "READY_FOR_DISPUTE"
        }, 201);
      }
      if (url.endsWith("/v1/shipping/weight-proofs/WGSTAGEUI999")) {
        return makeEnvelope({
          status: "available",
          proof_status: "captured",
          awb_number: "WGSTAGEUI999",
          declared_weight_grams: 1240
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const writes: string[] = [];
      const output = await backendMediatedSelfTestScript.runBackendMediatedUploadSelfTest({
        source: {
          APP_ENV: "staging",
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://redacted@cloudsql/staging",
          JWT_SECRET: "test-jwt-secret",
          WEIGHT_GUARD_BACKEND_UPLOAD_SELF_TEST: backendMediatedSelfTestScript.APPROVAL_FLAG,
          WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
          WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
          SHIPMASTR_STAGING_API_BASE_URL: "https://shipmastr-api-staging-jscfc5kumq-el.a.run.app"
        },
        prisma: { $disconnect: async () => undefined },
        fixture: {
          id: "wg_stage_backend_mediated_shipment_wgstageui999",
          sellerId: "wg_stage_backend_mediated_merchant",
          awbNumber: "WGSTAGEUI999"
        },
        token: "redacted-test-token",
        write: (text: string) => writes.push(text),
        throwOnFailure: true
      });

      assert.equal(output.errorCategory, null);
      assert.equal(output.authenticatedSellerContext, true);
      assert.equal(output.uploadMode, "BACKEND_MEDIATED");
      assert.equal(output.uploadEndpointPresent, true);
      assert.equal(output.uploadVerified, true);
      assert.equal(output.finalizeSucceeded, true);
      assert.equal(output.getProofSellerSafe, true);
      assert.equal(output.directSignedUploadUsed, false);
      assert.equal(calls.length, 4);
      assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "POST", "GET"]);
      assert.ok(calls.every((call) => call.hasAuthorization));
      assert.doesNotMatch(writes.join("\n"), /redacted-test-token|Authorization|Bearer|imageObjectKey|objectKey|bucket|storage[.]googleapis|signedUrl|signed_url|X-Goog|weight-proofs\//i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps backend-mediated self-test upload 503 categories safe and specific", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/shipping/weight-proofs/init")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            status: "CAPTURE_SESSION_CREATED",
            captureSessionId: "capture_self_test",
            awbNumber: "WGSTAGEUI999",
            uploadMode: "BACKEND_MEDIATED",
            uploadEndpoint: "/api/v1/shipping/weight-proofs/upload",
            requiredHeaders: {}
          }
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/v1/shipping/weight-proofs/upload")) {
        return new Response(JSON.stringify({
          error: "BACKEND_UPLOAD_METADATA_VERIFY_FAILED",
          details: {
            category: "BACKEND_UPLOAD_METADATA_VERIFY_FAILED",
            objectKeyPresent: true,
            objectKeyHash: "f".repeat(16),
            objectKeyPrefixCategory: "weight-proofs"
          }
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const writes: string[] = [];
      const output = await backendMediatedSelfTestScript.runBackendMediatedUploadSelfTest({
        source: {
          APP_ENV: "staging",
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://redacted@cloudsql/staging",
          JWT_SECRET: "test-jwt-secret",
          WEIGHT_GUARD_BACKEND_UPLOAD_SELF_TEST: backendMediatedSelfTestScript.APPROVAL_FLAG,
          WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
          WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
          SHIPMASTR_STAGING_API_BASE_URL: "https://shipmastr-api-staging-jscfc5kumq-el.a.run.app"
        },
        prisma: { $disconnect: async () => undefined },
        fixture: {
          id: "wg_stage_backend_mediated_shipment_wgstageui999",
          sellerId: "wg_stage_backend_mediated_merchant",
          awbNumber: "WGSTAGEUI999"
        },
        token: "redacted-test-token",
        write: (text: string) => writes.push(text)
      });

      assert.equal(output.errorCategory, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
      assert.doesNotMatch(writes.join("\n"), /redacted-test-token|Authorization|Bearer|imageObjectKey|objectKey|bucket|storage[.]googleapis|signedUrl|signed_url|X-Goog|weight-proofs\//i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails backend upload safely when storage put fails", async () => {
    const client = makeClient();
    const storage = {
      createPresignedPutUrl: async () => ({
        uploadUrl: "mock://weight-proof-put/backend-upload",
        method: "PUT" as const,
        headers: { "content-type": "image/jpeg" },
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      }),
      putObject: async () => {
        throw new HttpError(503, "BACKEND_UPLOAD_STORAGE_PUT_FAILED");
      },
      headObject: async () => ({ exists: true }),
      createPresignedGetUrl: async () => ({
        downloadUrl: "mock://weight-proof-get/backend-upload",
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      })
    };
    const context = makeContext(client, storage, { uploadMode: "BACKEND_MEDIATED" });
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    await assert.rejects(() => uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("safe-test-image"),
        contentType: "image/jpeg",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }
    }, context), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "BACKEND_UPLOAD_STORAGE_PUT_FAILED");
      assert.equal((error as any).details?.category, "BACKEND_UPLOAD_STORAGE_PUT_FAILED");
      const text = JSON.stringify(error);
      assert.doesNotMatch(text, /weight-proofs\/seller_123|imageObjectKey|image_object_key|private-weight-proofs|storage[.]googleapis|signed/i);
      return true;
    });
  });

  it("fails backend upload safely when metadata verification does not confirm the object", async () => {
    const client = makeClient();
    const storage = {
      createPresignedPutUrl: async () => ({
        uploadUrl: "mock://weight-proof-put/backend-upload",
        method: "PUT" as const,
        headers: { "content-type": "image/jpeg" },
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      }),
      putObject: async () => ({ exists: false }),
      headObject: async () => ({ exists: true }),
      createPresignedGetUrl: async () => ({
        downloadUrl: "mock://weight-proof-get/backend-upload",
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      })
    };
    const context = makeContext(client, storage, { uploadMode: "BACKEND_MEDIATED" });
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);

    await assert.rejects(() => uploadWeightProofImage({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      file: {
        buffer: Buffer.from("safe-test-image"),
        contentType: "image/jpeg",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }
    }, context), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
      assert.equal((error as any).details?.category, "BACKEND_UPLOAD_METADATA_VERIFY_FAILED");
      const text = JSON.stringify(error);
      assert.doesNotMatch(text, /weight-proofs\/seller_123|imageObjectKey|image_object_key|private-weight-proofs|storage[.]googleapis|signed/i);
      return true;
    });
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
    }, context), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.message, "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED");
      assert.equal((error as any).details?.category, "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED");
      assert.equal((error as any).details?.objectKeyPrefixCategory, "weight-proofs");
      assert.equal((error as any).details?.objectKeyPresent, true);
      assert.match(String((error as any).details?.objectKeyHash), /^[a-f0-9]{16}$/);
      const text = JSON.stringify(error);
      assert.doesNotMatch(text, /weight-proofs\/seller_123|imageObjectKey|image_object_key/i);
      return true;
    });
  });

  it("finalize verifies the exact session image object key", async () => {
    const client = makeClient();
    let headObjectKey = "";
    const storage = {
      createPresignedPutUrl: async () => ({
        uploadUrl: "mock://weight-proof-put/session-key",
        method: "PUT" as const,
        headers: { "content-type": "image/jpeg" },
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      }),
      headObject: async ({ objectKey }: any) => {
        headObjectKey = objectKey;
        return {
          exists: true,
          contentLength: 2048,
          contentType: "image/jpeg",
          updatedAt: new Date("2026-06-22T10:05:00.000Z")
        };
      },
      createPresignedGetUrl: async () => ({
        downloadUrl: "mock://weight-proof-get/session-key",
        expiresAt: new Date("2026-06-22T10:15:00.000Z")
      })
    };
    const context = makeContext(client, storage);
    await initWeightProofCapture({ awbNumber: "AWB_123" }, context);
    const sessionKey = client.__state.sessions[0].imageObjectKey;

    await finalizeWeightProofCapture({
      captureSessionId: "capture_123",
      awbNumber: "AWB_123",
      declaredWeightGrams: 1000,
      dimensions: { lengthCm: 10, widthCm: 20, heightCm: 30 }
    }, context);

    assert.equal(headObjectKey, sessionKey);
    assert.equal(getWeightProofObjectKeyDiagnostics(headObjectKey).objectKeyHash, getWeightProofObjectKeyDiagnostics(sessionKey).objectKeyHash);
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
      assert.equal((error as any).details?.category, "WEIGHT_GUARD_UPLOAD_NOT_VERIFIED");
      assert.equal((error as any).details?.objectKeyPrefixCategory, "weight-proofs");
      assert.match(String((error as any).details?.objectKeyHash), /^[a-f0-9]{16}$/);
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
    const rootRoutes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /shippingNetworkRouter\.post\("\/weight-proofs\/init"/);
    assert.match(routes, /shippingNetworkRouter\.post\("\/weight-proofs\/upload"/);
    assert.match(routes, /shippingNetworkRouter\.post\("\/weight-proofs\/finalize"/);
    assert.match(routes, /shippingNetworkRouter\.get\("\/weight-proofs\/:awbNumber"/);
    assert.match(rootRoutes, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\)/);
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
    assert.equal(context.maxImageBytes, 1024);
    assert.equal(context.uploadMode, "DIRECT_SIGNED_URL");
  });

  it("uses backend-mediated route context for GCS storage", () => {
    const client = makeClient();
    const storage = new InMemoryWeightProofStorageAdapter();
    const request = {
      auth: { merchantId: "seller_auth_scope" },
      app: {
        locals: {
          weightProofStorageRuntime: {
            enabled: true,
            provider: "gcs",
            storage,
            uploadTtlMs: 600000,
            signedGetTtlMs: 300000,
            maxImageBytes: 1024
          },
          weightProofClient: client
        }
      }
    } as unknown as Request;

    const context = createWeightProofRouteContext(request);
    assert.equal(context.uploadMode, "BACKEND_MEDIATED");
    assert.equal(context.maxImageBytes, 1024);
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
    const routeResponse: any = serializeInitWeightProofRouteResult(result);

    assert.equal(routeResponse.status, "CAPTURE_SESSION_CREATED");
    assert.equal(routeResponse.captureSessionId, "route_capture");
    assert.equal(Object.prototype.hasOwnProperty.call(routeResponse, "objectKey"), false);
    assert.match(String(routeResponse.uploadUrl), /^mock:\/\/weight-proof-put\//);
    assert.deepEqual(routeResponse.requiredHeaders, { "Content-Type": "image/png" });
    assert.doesNotMatch(JSON.stringify(routeResponse), /weight-proofs\/seller_123|imageObjectKey|image_object_key/i);
  });

  it("serializes backend-mediated route init without signed upload URL fields", async () => {
    const client = makeClient();
    const result = await initWeightProofCapture({
      awbNumber: "AWB_ROUTE",
      contentType: "image/png",
      expectedByteSize: 100
    }, makeContext(client, new InMemoryWeightProofStorageAdapter(), { uploadMode: "BACKEND_MEDIATED" }));
    const routeResponse: any = serializeInitWeightProofRouteResult(result);
    const text = JSON.stringify(routeResponse);

    assert.equal(routeResponse.status, "CAPTURE_SESSION_CREATED");
    assert.equal(routeResponse.uploadMode, "BACKEND_MEDIATED");
    assert.equal(routeResponse.uploadEndpoint, "/api/v1/shipping/weight-proofs/upload");
    assert.equal(Object.prototype.hasOwnProperty.call(routeResponse, "uploadUrl"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(routeResponse, "expiresAt"), false);
    assert.deepEqual(routeResponse.requiredHeaders, {});
    assert.doesNotMatch(text, /weight-proofs\/seller_123|imageObjectKey|image_object_key|uploadUrl|upload_url|private-weight-proofs|storage[.]googleapis|signed/i);
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
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + 600000);

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/png",
      expectedByteSize: 1024,
      expiresAt
    });

    assert.equal(result.uploadUrl, "https://signed.example/gcs-write");
    assert.equal(result.method, "PUT");
    assert.deepEqual(result.headers, { "content-type": "image/png" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].objectKey, r2ObjectKey);
    assert.equal(calls[0].config.version, "v4");
    assert.equal(calls[0].config.action, "write");
    assert.equal(calls[0].config.contentType, "image/png");
    assert.equal(typeof calls[0].config.expires, "number");
    assert.ok(calls[0].config.expires >= issuedAt + 600000);
    assert.ok(calls[0].config.expires <= expiresAt.getTime() + 1000);
    assert.deepEqual(Object.keys(calls[0].config).sort(), ["action", "contentType", "expires", "version"]);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].config, "extensionHeaders"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].config, "queryParams"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].config, "signingServiceAccount"), false);
  });

  it("builds official GCS write signed URL config with safe timestamp shape", () => {
    const nowMs = Date.parse("2026-06-22T10:00:00.000Z");
    const result = buildOfficialGcsWriteSignedUrlConfig({
      expiresAt: new Date(nowMs + 600000),
      contentType: "image/jpeg",
      nowMs
    });

    assert.deepEqual(result.config, {
      version: "v4",
      action: "write",
      expires: nowMs + 600000,
      contentType: "image/jpeg"
    });
    assert.deepEqual(result.diagnostics, {
      expiresFormat: "timestamp_ms",
      ttlSeconds: 600,
      contentTypePresent: true,
      officialConfigShapeValid: true,
      hasUnsupportedOfficialSignedUrlOptions: false
    });
  });

  it("canonicalizes GCS XML object paths per segment without encoding slash separators", () => {
    const diagnosticKey = buildWeightGuardDiagnosticObjectKey({
      diagnosticId: "put_head_1780000000000",
      contentType: "image/png"
    });

    const encodedPath = buildGcsXmlPathStyleObjectPath(diagnosticKey);

    assert.equal(encodedPath, "weight-guard-diagnostics/put_head_1780000000000.png");
    assert.doesNotMatch(encodedPath, /%2F/i);
    assert.throws(
      () => buildGcsXmlPathStyleObjectPath("weight-guard-diagnostics/../put_head_1780000000000.png"),
      /WEIGHT_GUARD_DIAGNOSTIC_OBJECT_KEY_INVALID/
    );
  });

  it("detects whole-key GCS path encoding as an object identity mismatch without leaking keys", () => {
    const rawObjectKey = "weight-guard-diagnostics/put_head_1780000000000.png";
    const good = getGcsSignedUrlObjectPathDiagnostics({
      rawObjectKey,
      bucketName: "private-weight-proofs",
      signedUrl: "https://signed.example/private-weight-proofs/weight-guard-diagnostics/put_head_1780000000000.png?X-Goog-Signature=unsafe"
    });
    const bad = getGcsSignedUrlObjectPathDiagnostics({
      rawObjectKey,
      bucketName: "private-weight-proofs",
      signedUrl: "https://signed.example/private-weight-proofs/weight-guard-diagnostics%2Fput_head_1780000000000.png?X-Goog-Signature=unsafe"
    });

    assert.equal(good.sameObjectKeyHash, true);
    assert.equal(good.signedPathHasEncodedSlash, false);
    assert.equal(bad.sameObjectKeyHash, false);
    assert.equal(bad.signedPathHasEncodedSlash, true);
    assert.notEqual(bad.rawKeyHash, bad.signedPathKeyHash);
    const text = JSON.stringify({ good, bad });
    assert.doesNotMatch(text, /weight-guard-diagnostics\/|private-weight-proofs|X-Goog-Signature|https?:\/\//i);
  });

  it("allows a narrow diagnostic GCS object prefix for PUT and HEAD self-tests", async () => {
    const diagnosticKey = buildWeightGuardDiagnosticObjectKey({
      diagnosticId: "put_head_1780000000000",
      contentType: "image/png"
    });
    const { adapter, calls } = makeGcsAdapter({
      getMetadata: async () => [{
        size: "68",
        contentType: "image/png",
        updated: "2026-06-22T10:06:00.000Z"
      }]
    });

    await adapter.createPresignedPutUrl({
      objectKey: diagnosticKey,
      contentType: "image/png",
      expectedByteSize: 68,
      expiresAt: new Date("2026-06-22T10:10:00.000Z")
    });
    const head = await adapter.headObject({ objectKey: diagnosticKey });
    const diagnostics = getWeightProofObjectKeyDiagnostics(diagnosticKey);

    assert.equal(head.exists, true);
    assert.equal(calls[0].objectKey, diagnosticKey);
    assert.equal(calls[1].objectKey, diagnosticKey);
    assert.equal(diagnostics.objectKeyPrefixCategory, "weight-guard-diagnostics");
    assert.match(String(diagnostics.objectKeyHash), /^[a-f0-9]{16}$/);
  });

  it("runs the GCS PUT+HEAD self-test without leaking signed URLs or object keys", async () => {
    const writes: string[] = [];
    const objectKeys: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, "PUT");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["Content-Type"], "application/octet-stream");
      assert.equal(Object.prototype.hasOwnProperty.call(headers, "Authorization"), false);
      return { status: 200 } as Response;
    }) as typeof fetch;
    try {
      const output = await putHeadSelfTestScript.runPutHeadSelfTest({
        source: {
          WEIGHT_GUARD_GCS_PUT_HEAD_SELF_TEST: putHeadSelfTestScript.APPROVAL_FLAG,
          WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
          WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
          WEIGHT_GUARD_GCS_BUCKET: "private-weight-proofs",
          WEIGHT_GUARD_GCS_PROJECT_ID: "shipmastr-core-prod",
          APP_ENV: "staging"
        },
        storageModule: {
          buildWeightGuardDiagnosticObjectKey,
          buildOfficialGcsWriteSignedUrlConfig,
          buildGcsXmlPathStyleObjectPath,
          getGcsSignedUrlObjectPathDiagnostics,
          getWeightProofObjectKeyPrefix,
          getWeightProofObjectKeyDiagnostics,
          resolveGcsWeightProofStorageConfig
        },
        adapter: {
          createPresignedPutUrl: async (input: any) => {
            objectKeys.push(input.objectKey);
            return {
              uploadUrl: `https://storage.googleapis.com/private-weight-proofs/${input.objectKey}?X-Goog-Signature=unsafe`,
              method: "PUT" as const,
              headers: {
                "content-type": "application/octet-stream"
              },
              expiresAt: input.expiresAt
            };
          },
          headObject: async (input: any) => {
            objectKeys.push(input.objectKey);
            if (input.objectKey !== objectKeys[0]) return { exists: false };
            return {
              exists: true,
              contentLength: 68,
              contentType: "image/png",
              updatedAt: new Date("2026-06-22T10:06:00.000Z")
            };
          },
          listObjectKeyDiagnosticsByPrefix: async (input: any) => {
            assert.equal(input.prefix, "weight-guard-diagnostics/");
            const objectKey = objectKeys[0];
            return [getWeightProofObjectKeyDiagnostics(objectKey)];
          }
        },
        now: new Date("2026-06-22T10:06:00.000Z"),
        metadataEmailResolver: async () => "metadata-runner@example.iam.gserviceaccount.com",
        write: (line: string) => writes.push(line)
      });

      assert.equal(output.signedUrlGenerated, true);
      assert.equal(output.putStatus, 200);
      assert.equal(output.putOk, true);
      assert.equal(output.xGoogGenerationPresent, false);
      assert.equal(output.xGoogHashPresent, false);
      assert.equal(output.xGoogStoredContentLengthPresent, false);
      assert.equal(output.contentLengthResponseHeaderPresent, false);
      assert.equal(output.headVerified, true);
      assert.equal(output.metadataVerified, true);
      assert.equal(output.listFoundMatchingHash, true);
      assert.equal(output.sameObjectKeyHash, true);
      assert.equal(output.requiredHeadersUsed, true);
      assert.equal(output.expiresFormat, "timestamp_ms");
      assert.equal(output.ttlSeconds, 600);
      assert.equal(output.contentTypePresent, true);
      assert.equal(output.officialConfigShapeValid, true);
      assert.equal(output.hasUnsupportedOfficialSignedUrlOptions, false);
      assert.equal(output.errorCategory, "PUT_200_WITHOUT_GCS_OBJECT_GENERATION");
      assert.equal(output.classification, "PUT_200_WITHOUT_GCS_OBJECT_GENERATION");
      assert.equal(output.metadataCandidateResults.some((candidate: any) => candidate.candidateName === "raw" && candidate.metadataFound), true);
      assert.equal(output.metadataCandidateResults.every((candidate: any) => /^[a-f0-9]{16}$/.test(String(candidate.candidateHash))), true);
      assert.ok(objectKeys.length >= 3);
      assert.equal(objectKeys[0], objectKeys[1]);
      const text = writes.join("\n");
      assert.doesNotMatch(text, /signed\.example|weight-guard-diagnostics\/|weight-proofs\/|private-weight-proofs|shipmastr-core-prod|X-Goog-Signature/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps PUT+HEAD diagnostics safe when metadata verification fails but prefix listing finds the hash", async () => {
    const writes: string[] = [];
    const objectKeys: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, "PUT");
      return { status: 200 } as Response;
    }) as typeof fetch;
    try {
      const output = await putHeadSelfTestScript.runPutHeadSelfTest({
        source: {
          WEIGHT_GUARD_GCS_PUT_HEAD_SELF_TEST: putHeadSelfTestScript.APPROVAL_FLAG,
          WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
          WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
          WEIGHT_GUARD_GCS_BUCKET: "private-weight-proofs",
          WEIGHT_GUARD_GCS_PROJECT_ID: "shipmastr-core-prod",
          APP_ENV: "staging"
        },
        storageModule: {
          buildWeightGuardDiagnosticObjectKey,
          buildOfficialGcsWriteSignedUrlConfig,
          buildGcsXmlPathStyleObjectPath,
          getGcsSignedUrlObjectPathDiagnostics,
          getWeightProofObjectKeyPrefix,
          getWeightProofObjectKeyDiagnostics,
          resolveGcsWeightProofStorageConfig
        },
        adapter: {
          createPresignedPutUrl: async (input: any) => {
            objectKeys.push(input.objectKey);
            return {
              uploadUrl: `https://storage.googleapis.com/private-weight-proofs/${input.objectKey}?X-Goog-Signature=unsafe`,
              method: "PUT" as const,
              headers: {
                "content-type": "application/octet-stream"
              },
              expiresAt: input.expiresAt
            };
          },
          headObject: async (input: any) => {
            objectKeys.push(input.objectKey);
            throw new Error("metadata unavailable for private object");
          },
          listObjectKeyDiagnosticsByPrefix: async () => [
            getWeightProofObjectKeyDiagnostics(objectKeys[0])
          ]
        },
        now: new Date("2026-06-22T10:06:00.000Z"),
        metadataEmailResolver: async () => "metadata-runner@example.iam.gserviceaccount.com",
        write: (line: string) => writes.push(line)
      });

      assert.equal(output.signedUrlGenerated, true);
      assert.equal(output.putOk, true);
      assert.equal(output.headVerified, false);
      assert.equal(output.metadataVerified, false);
      assert.equal(output.listFoundMatchingHash, true);
      assert.equal(output.sameObjectKeyHash, true);
      assert.equal(output.classification, "PUT_200_WITHOUT_GCS_OBJECT_GENERATION");
      assert.equal(output.expiresFormat, "timestamp_ms");
      assert.equal(output.contentTypePresent, true);
      assert.equal(output.officialConfigShapeValid, true);
      assert.equal(output.hasUnsupportedOfficialSignedUrlOptions, false);
      assert.ok(objectKeys.length >= 4);
      const text = writes.join("\n");
      assert.doesNotMatch(text, /signed\.example|weight-guard-diagnostics\/|weight-proofs\/|private-weight-proofs|shipmastr-core-prod|X-Goog-Signature/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records safe GCS PUT response headers and hash-only metadata candidates", async () => {
    const writes: string[] = [];
    const objectKeys: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, "PUT");
      return {
        status: 200,
        headers: new Headers({
          "x-goog-generation": "1780000000000000",
          "x-goog-hash": "crc32c=abc",
          "x-goog-stored-content-length": "68",
          "content-length": "0"
        })
      } as Response;
    }) as typeof fetch;
    try {
      const output = await putHeadSelfTestScript.runPutHeadSelfTest({
        source: {
          WEIGHT_GUARD_GCS_PUT_HEAD_SELF_TEST: putHeadSelfTestScript.APPROVAL_FLAG,
          WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
          WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
          WEIGHT_GUARD_GCS_BUCKET: "private-weight-proofs",
          WEIGHT_GUARD_GCS_PROJECT_ID: "shipmastr-core-prod",
          APP_ENV: "staging"
        },
        storageModule: {
          buildWeightGuardDiagnosticObjectKey,
          buildOfficialGcsWriteSignedUrlConfig,
          buildGcsXmlPathStyleObjectPath,
          getGcsSignedUrlObjectPathDiagnostics,
          getWeightProofObjectKeyPrefix,
          getWeightProofObjectKeyDiagnostics,
          resolveGcsWeightProofStorageConfig
        },
        adapter: {
          createPresignedPutUrl: async (input: any) => {
            objectKeys.push(input.objectKey);
            return {
              uploadUrl: `https://storage.googleapis.com/private-weight-proofs/${input.objectKey}?X-Goog-Signature=unsafe`,
              method: "PUT" as const,
              headers: {
                "content-type": "application/octet-stream"
              },
              expiresAt: input.expiresAt
            };
          },
          headObject: async (input: any) => {
            objectKeys.push(input.objectKey);
            return { exists: input.objectKey === objectKeys[0] };
          },
          listObjectKeyDiagnosticsByPrefix: async () => []
        },
        now: new Date("2026-06-22T10:06:00.000Z"),
        metadataEmailResolver: async () => "metadata-runner@example.iam.gserviceaccount.com",
        write: (line: string) => writes.push(line)
      });

      assert.equal(output.xGoogGenerationPresent, true);
      assert.equal(output.xGoogHashPresent, true);
      assert.equal(output.xGoogStoredContentLengthPresent, true);
      assert.equal(output.contentLengthResponseHeaderPresent, true);
      assert.equal(output.classification, "GCS_OBJECT_KEY_VARIANT_IDENTIFIED");
      assert.equal(output.errorCategory, "none");
      assert.equal(output.expiresFormat, "timestamp_ms");
      assert.equal(output.contentTypePresent, true);
      assert.equal(output.officialConfigShapeValid, true);
      assert.equal(output.hasUnsupportedOfficialSignedUrlOptions, false);
      assert.equal(output.metadataCandidateResults.some((candidate: any) => candidate.candidateName === "raw" && candidate.metadataFound), true);
      assert.equal(output.metadataCandidateResults.every((candidate: any) => Object.prototype.hasOwnProperty.call(candidate, "candidateHash")), true);
      const text = writes.join("\n");
      assert.doesNotMatch(text, /1780000000000000|crc32c=abc|signed\.example|weight-guard-diagnostics\/|weight-proofs\/|private-weight-proofs|shipmastr-core-prod|X-Goog-Signature/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("classifies official GCS signed URL failure without leaking signer or object details", async () => {
    const writes: string[] = [];
    const output = await putHeadSelfTestScript.runPutHeadSelfTest({
      source: {
        WEIGHT_GUARD_GCS_PUT_HEAD_SELF_TEST: putHeadSelfTestScript.APPROVAL_FLAG,
        WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
        WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
        WEIGHT_GUARD_GCS_BUCKET: "private-weight-proofs",
        WEIGHT_GUARD_GCS_PROJECT_ID: "shipmastr-core-prod",
        WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT: "shipmastr-runner@example.iam.gserviceaccount.com",
        APP_ENV: "staging"
      },
      storageModule: {
        buildWeightGuardDiagnosticObjectKey,
        buildOfficialGcsWriteSignedUrlConfig,
        buildGcsXmlPathStyleObjectPath,
        getGcsSignedUrlObjectPathDiagnostics,
        getWeightProofObjectKeyPrefix,
        getWeightProofObjectKeyDiagnostics,
        resolveGcsWeightProofStorageConfig
      },
      adapter: {
        createPresignedPutUrl: async () => {
          throw Object.assign(
            new Error("iam.serviceAccounts.signBlob denied for shipmastr-runner@example.iam.gserviceaccount.com on https://storage.googleapis.com/private-weight-proofs/weight-guard-diagnostics/put_head_1780000000000.png?X-Goog-Signature=unsafe"),
            { code: 403 }
          );
        },
        headObject: async () => ({ exists: false }),
        listObjectKeyDiagnosticsByPrefix: async () => []
      },
      now: new Date("2026-06-22T10:06:00.000Z"),
      metadataEmailResolver: async () => "metadata-runner@example.iam.gserviceaccount.com",
      write: (line: string) => writes.push(line)
    });

    assert.equal(output.signedUrlGenerated, false);
    assert.equal(output.putOk, false);
    assert.equal(output.errorCategory, "IAM_SIGN_BLOB_DENIED");
    assert.equal(output.classification, "IAM_SIGN_BLOB_DENIED");
    assert.equal(output.errorCode, "403");
    assert.equal(output.hasMessage, true);
    assert.equal(output.hasStack, false);
    assert.equal(output.signerConfigured, true);
    assert.equal(output.explicitSignerConfigured, true);
    assert.equal(output.adcAvailable, true);
    assert.equal(output.signBlobLikelyAllowed, false);
    assert.equal(output.storageCreateLikelyAllowed, "unknown");
    assert.equal(output.storageGetLikelyAllowed, "unknown");
    assert.match(String(output.runtimeServiceAccountHash), /^[a-f0-9]{16}$/);
    assert.match(String(output.explicitSigningServiceAccountHash), /^[a-f0-9]{16}$/);
    assert.equal(output.sameSignerHash, false);
    assert.equal(output.signerEmailPresent, true);
    assert.equal(output.metadataEmailNeeded, false);
    assert.equal(output.expiresFormat, "timestamp_ms");
    assert.equal(output.ttlSeconds, 600);
    assert.equal(output.contentTypePresent, true);
    assert.equal(output.officialConfigShapeValid, true);
    assert.equal(output.hasUnsupportedOfficialSignedUrlOptions, false);
    const text = writes.join("\n");
    assert.doesNotMatch(text, /shipmastr-runner@example|metadata-runner@example|private-weight-proofs|shipmastr-core-prod|storage[.]googleapis[.]com|weight-guard-diagnostics\/|X-Goog-Signature|https?:\/\//i);
  });

  it("maps official GCS signing failures into specific safe categories", () => {
    assert.equal(
      putHeadSelfTestScript.classifyOfficialGetSignedUrlFailure(
        { sanitizedMessage: "iamcredentials.googleapis.com API has not been used in project and is disabled" },
        null
      ),
      "SERVICE_ACCOUNT_CREDENTIALS_API_DISABLED"
    );
    assert.equal(
      putHeadSelfTestScript.classifyOfficialGetSignedUrlFailure(null, new Error("client_email missing; service account email unavailable")),
      "SIGNER_EMAIL_UNAVAILABLE"
    );
    assert.equal(
      putHeadSelfTestScript.classifyOfficialGetSignedUrlFailure(null, new Error("private_key missing: cannot sign data")),
      "NO_PRIVATE_KEY_OR_SIGNER"
    );
    assert.equal(
      putHeadSelfTestScript.classifyOfficialGetSignedUrlFailure(null, new Error("storage.objects.create permission denied")),
      "STORAGE_OBJECT_CREATE_PERMISSION_MISSING"
    );
    assert.equal(
      putHeadSelfTestScript.classifyOfficialGetSignedUrlFailure(null, new Error("invalid expires config for getSignedUrl action")),
      "OFFICIAL_GET_SIGNED_URL_CONFIG_INVALID"
    );
  });

  it("uses official GCS getSignedUrl for PUT even when an explicit signer is configured", async () => {
    const runtimeSignCalls: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter, calls } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "metadata-runner@example.iam.gserviceaccount.com";
      },
      getSignedUrl: async () => ["https://signed.example/official-put"],
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
      "content-type": "image/png"
    });
    assert.equal(result.uploadUrl, "https://signed.example/official-put");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "getSignedUrl");
    assert.equal(calls[0].objectKey, r2ObjectKey);
    assert.equal(calls[0].config.version, "v4");
    assert.equal(calls[0].config.action, "write");
    assert.equal(typeof calls[0].config.expires, "number");
    assert.ok(calls[0].config.expires >= result.expiresAt.getTime());
    assert.ok(calls[0].config.expires <= result.expiresAt.getTime() + 1000);
    assert.equal(calls[0].config.contentType, "image/png");
    assert.deepEqual(Object.keys(calls[0].config).sort(), ["action", "contentType", "expires", "version"]);
    assert.equal(metadataEmailCalls, 0);
    assert.equal(runtimeSignCalls.length, 0);
  });

  it("does not fall back to runtime signing for GCS signed PUT when official signing fails", async () => {
    const diagnostics: any[] = [];
    const runtimeSignCalls: any[] = [];
    const signBlobCalls: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter } = makeGcsAdapter({
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      getSignedUrl: async () => {
        throw new Error("library signer unavailable");
      },
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "shipmastr-runner@example.iam.gserviceaccount.com";
      },
      authClient: {
        getCredentials: async () => ({}),
        getAccessToken: async () => ({ token: "local-adc-token" })
      },
      runtimeSigner: async (input) => {
        runtimeSignCalls.push(input);
        return fakeBase64Signature("should-not-sign-put");
      },
      iamSignBlobRequest: async (request) => {
        signBlobCalls.push(request);
        return { signedBlob: fakeBase64Signature("signed-by-metadata-email") };
      }
    });

    await assert.rejects(
      () => adapter.createPresignedPutUrl({
        objectKey: r2ObjectKey,
        contentType: "image/png",
        expectedByteSize: 100,
        expiresAt: new Date(Date.now() + 600000)
      }),
      (error) => error instanceof HttpError && error.message === "WEIGHT_GUARD_GCS_SIGNED_URL_FAILED"
    );

    assert.equal(metadataEmailCalls, 0);
    assert.equal(runtimeSignCalls.length, 0);
    assert.equal(signBlobCalls.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].operation, "signed_put");
    assert.equal(diagnostics[0].category, "GCS_SIGNING_FAILED");
    assert.equal(diagnostics[0].expiresFormat, "timestamp_ms");
    assert.equal(diagnostics[0].contentTypePresent, true);
    assert.equal(diagnostics[0].officialConfigShapeValid, true);
    assert.equal(diagnostics[0].hasUnsupportedOfficialSignedUrlOptions, false);
  });

  it("does not call IAM signBlob for GCS signed PUT URLs", async () => {
    const signBlobCalls: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter, calls } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "metadata-runner@example.iam.gserviceaccount.com";
      },
      getSignedUrl: async () => ["https://signed.example/official-put"],
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
    assert.equal(signBlobCalls.length, 0);
    assert.equal(result.uploadUrl, "https://signed.example/official-put");
    assert.deepEqual(result.headers, {
      "content-type": "image/jpeg"
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "getSignedUrl");
    assert.equal(calls[0].objectKey, r2ObjectKey);
    assert.deepEqual(Object.keys(calls[0].config).sort(), ["action", "contentType", "expires", "version"]);
  });

  it("ignores invalid runtime signer config for official GCS signed PUT URLs", async () => {
    const diagnostics: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter, calls } = makeGcsAdapter({
      signingServiceAccount: "not-an-email",
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return "metadata-runner@example.iam.gserviceaccount.com";
      },
      getSignedUrl: async () => ["https://signed.example/official-put"],
      accessTokenProvider: async () => "adc-runtime-token",
      iamSignBlobRequest: async () => ({ signedBlob: fakeBase64Signature("should-not-sign") })
    });

    const result = await adapter.createPresignedPutUrl({
      objectKey: r2ObjectKey,
      contentType: "image/jpeg",
      expectedByteSize: 100,
      expiresAt: new Date(Date.now() + 600000)
    });

    assert.equal(metadataEmailCalls, 0);
    assert.equal(diagnostics.length, 0);
    assert.equal(result.uploadUrl, "https://signed.example/official-put");
    assert.equal(calls[0].objectKey, r2ObjectKey);
  });

  it("maps GCS signed URL failure with safe diagnostics only", async () => {
    const diagnostics: any[] = [];
    const gcsHost = ["storage", "googleapis", "com"].join(".");
    let runtimeSignCalls = 0;
    const { adapter } = makeGcsAdapter({
      signingServiceAccount: "shipmastr-runner@example.iam.gserviceaccount.com",
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      getSignedUrl: async () => {
        throw Object.assign(new Error(`permission denied for https://${gcsHost}/${r2ObjectKey} imageObjectKey=${r2ObjectKey} in private-weight-proofs`), {
          name: "SigningError",
          code: 403
        });
      },
      runtimeSigner: async () => {
        runtimeSignCalls += 1;
        return fakeBase64Signature("should-not-sign-put");
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
    assert.equal(diagnostics[0].expiresFormat, "timestamp_ms");
    assert.equal(diagnostics[0].ttlSeconds, 600);
    assert.equal(diagnostics[0].contentTypePresent, true);
    assert.equal(diagnostics[0].officialConfigShapeValid, true);
    assert.equal(diagnostics[0].hasUnsupportedOfficialSignedUrlOptions, false);
    assert.equal(runtimeSignCalls, 0);
    const text = JSON.stringify(diagnostics[0]);
    assert.match(text, /object-key-redacted/);
    assert.doesNotMatch(text, /private-weight-proofs|shipmastr-core-prod|shipmastr-runner@example|storage[.]googleapis[.]com|weight-proofs\/seller_123|X-Goog-Signature|signed\.example/i);
  });

  it("fails GCS init signing safely when official GCS signing fails", async () => {
    const diagnostics: any[] = [];
    let metadataEmailCalls = 0;
    const { adapter } = makeGcsAdapter({
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      getSignedUrl: async () => {
        throw new Error("library signer unavailable");
      },
      serviceAccountEmailResolver: async () => {
        metadataEmailCalls += 1;
        return null;
      },
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
    assert.equal(diagnostics[0].expiresFormat, "timestamp_ms");
    assert.equal(diagnostics[0].contentTypePresent, true);
    assert.equal(diagnostics[0].officialConfigShapeValid, true);
    assert.equal(diagnostics[0].hasUnsupportedOfficialSignedUrlOptions, false);
    assert.equal(metadataEmailCalls, 0);
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

  it("uses authenticated GCS metadata lookup without public object HEAD", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("public HEAD should not be used for private proof metadata");
    }) as typeof fetch;
    try {
      const { adapter, calls } = makeGcsAdapter({
        getMetadata: async () => [{
          size: "68",
          contentType: "image/png",
          updated: "2026-06-22T10:06:00.000Z"
        }]
      });

      const object = await adapter.headObject({ objectKey: r2ObjectKey });

      assert.equal(object.exists, true);
      assert.equal(fetchCalls, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "getMetadata");
      assert.equal(calls[0].objectKey, r2ObjectKey);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lists diagnostic object hashes by prefix without exposing object keys", async () => {
    const diagnosticKey = buildWeightGuardDiagnosticObjectKey({
      diagnosticId: "put_head_1780000000000",
      contentType: "image/png"
    });
    const { adapter, calls } = makeGcsAdapter({
      getFiles: async () => [[{ name: diagnosticKey }]]
    });

    const listed = await adapter.listObjectKeyDiagnosticsByPrefix({
      prefix: "weight-guard-diagnostics/",
      maxResults: 20
    });

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.objectKeyPrefixCategory, "weight-guard-diagnostics");
    assert.match(String(listed[0]?.objectKeyHash), /^[a-f0-9]{16}$/);
    assert.equal(calls[0].method, "getFiles");
    const text = JSON.stringify(listed);
    assert.doesNotMatch(text, /weight-guard-diagnostics\/|put_head_|private-weight-proofs|storage[.]googleapis[.]com/i);
  });

  it("handles GCS missing objects and metadata failures without leaking config", async () => {
    const missing = makeGcsAdapter({
      getMetadata: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      }
    });
    assert.deepEqual(await missing.adapter.headObject({ objectKey: r2ObjectKey }), { exists: false });

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

  it("classifies GCS backend-mediated put and metadata failures without leaking config", async () => {
    const success = makeGcsAdapter({
      accessTokenProvider: async () => "test-access-token",
      getMetadata: async () => [{
        size: "15",
        contentType: "image/jpeg",
        updated: "2026-06-22T10:06:00.000Z"
      }]
    });
    const uploaded = await success.adapter.putObject({
      objectKey: r2ObjectKey,
      body: Buffer.from("safe-test-image"),
      contentType: "image/jpeg",
      sizeBytes: Buffer.byteLength("safe-test-image")
    });
    assert.equal(uploaded.exists, true);
    assert.deepEqual(success.calls.map((call) => call.method), ["mediaUpload"]);

    const putFailed = makeGcsAdapter({
      accessTokenProvider: async () => "test-access-token",
      mediaUploadRequest: async () => ({ ok: false, status: 403 })
    });
    await assert.rejects(
      () => putFailed.adapter.putObject({
        objectKey: r2ObjectKey,
        body: Buffer.from("safe-test-image"),
        contentType: "image/jpeg",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }),
      (error) => error instanceof HttpError && error.message === "BACKEND_UPLOAD_STORAGE_PUT_FAILED"
    );

    const metadataFailed = makeGcsAdapter({
      accessTokenProvider: async () => "test-access-token",
      mediaUploadRequest: async () => ({ ok: true, status: 200, metadata: null }),
      getMetadata: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      }
    });
    await assert.rejects(
      () => metadataFailed.adapter.putObject({
        objectKey: r2ObjectKey,
        body: Buffer.from("safe-test-image"),
        contentType: "image/jpeg",
        sizeBytes: Buffer.byteLength("safe-test-image")
      }),
      (error) => error instanceof HttpError && error.message === "BACKEND_UPLOAD_METADATA_VERIFY_FAILED"
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
