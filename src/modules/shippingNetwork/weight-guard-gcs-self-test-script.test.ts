import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const script = require(path.join(process.cwd(), "scripts/weight-guard-gcs-signed-url-self-test.cjs"));

const approvedEnv = {
  APP_ENV: "staging",
  NODE_ENV: "production",
  WEIGHT_GUARD_GCS_SELF_TEST: script.APPROVAL_FLAG,
  WEIGHT_GUARD_PROOF_STORAGE_ENABLED: "true",
  WEIGHT_GUARD_STORAGE_PROVIDER: "gcs",
  WEIGHT_GUARD_GCS_BUCKET: "private-diagnostic-bucket",
  WEIGHT_GUARD_GCS_PROJECT_ID: "shipmastr-core-prod",
  WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT: "shipmastr-runner@example.iam.gserviceaccount.com",
  DATABASE_URL: "postgresql://diagnostic:secret@localhost:5432/shipmastr"
};

function makeStorageModule(options: {
  createPresignedPutUrl: (config: any) => Promise<any>;
}) {
  return {
    buildWeightProofObjectKey: () => "weight-proofs/diagnostic/2026/06/WGDIAG001/selftest_123.png",
    resolveGcsWeightProofStorageConfig: (source: any) => ({
      bucket: source.WEIGHT_GUARD_GCS_BUCKET,
      projectId: source.WEIGHT_GUARD_GCS_PROJECT_ID,
      signingServiceAccount: source.WEIGHT_GUARD_GCS_SIGNING_SERVICE_ACCOUNT,
      signedGetTtlMs: 300000,
      maxImageBytes: 10 * 1024 * 1024
    }),
    GcsWeightProofStorageAdapter: class {
      private readonly config: any;

      constructor(config: any) {
        this.config = config;
      }

      createPresignedPutUrl() {
        return options.createPresignedPutUrl(this.config);
      }
    }
  };
}

function assertNoSelfTestLeaks(value: unknown) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, /storage[.]googleapis[.]com/i);
  assert.doesNotMatch(text, /weight-proofs\/diagnostic/i);
  assert.doesNotMatch(text, /private-diagnostic-bucket/i);
  assert.doesNotMatch(text, /shipmastr-runner@example/i);
  assert.doesNotMatch(text, /postgresql:\/\//i);
  assert.doesNotMatch(text, /X-Goog-Signature/i);
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]+/i);
}

test("Weight Guard GCS self-test refuses without approval flag", () => {
  assert.throws(
    () => script.assertSelfTestSafety({
      ...approvedEnv,
      WEIGHT_GUARD_GCS_SELF_TEST: ""
    }),
    /approval flag is required/
  );
});

test("Weight Guard GCS self-test allows production Node env only with staging app env", () => {
  assert.doesNotThrow(() => script.assertSelfTestSafety(approvedEnv));
  assert.throws(
    () => script.assertSelfTestSafety({
      ...approvedEnv,
      APP_ENV: ""
    }),
    /production-like runtime/
  );
});

test("Weight Guard GCS self-test success output never prints signed URL or object key", async () => {
  const writes: string[] = [];
  const result = await script.runSelfTest({
    source: approvedEnv,
    now: new Date("2026-06-26T12:00:00.000Z"),
    write: (value: string) => writes.push(value),
    storageModule: makeStorageModule({
      createPresignedPutUrl: async () => ({
        uploadUrl: "https://storage.googleapis.com/private-diagnostic-bucket/weight-proofs/diagnostic/2026/06/WGDIAG001/selftest_123.png?X-Goog-Signature=secret",
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-goog-content-sha256": "UNSIGNED-PAYLOAD"
        },
        expiresAt: new Date("2026-06-26T12:10:00.000Z")
      })
    })
  });

  assert.equal(result.signedUrlGenerated, true);
  assert.equal(result.requiredHeadersPresent, true);
  assert.equal(result.errorCategory, "none");
  assert.equal(writes.length, 1);
  assertNoSelfTestLeaks(result);
  assertNoSelfTestLeaks(writes[0]);
});

test("Weight Guard GCS self-test failure output keeps safe category and redacts diagnostics", async () => {
  const writes: string[] = [];
  const result = await script.runSelfTest({
    source: approvedEnv,
    now: new Date("2026-06-26T12:00:00.000Z"),
    write: (value: string) => writes.push(value),
    storageModule: makeStorageModule({
      createPresignedPutUrl: async (config) => {
        config.diagnostics({
          category: "GCS_PERMISSION_DENIED",
          errorClass: "ForbiddenError",
          sanitizedMessage: "permission denied for https://storage.googleapis.com/private-diagnostic-bucket/weight-proofs/diagnostic/2026/06/WGDIAG001/selftest_123.png?X-Goog-Signature=secret using shipmastr-runner@example.iam.gserviceaccount.com token=abc",
          signingServiceAccountConfigured: true
        });
        throw new Error("signBlob denied for objectKey=weight-proofs/diagnostic/2026/06/WGDIAG001/selftest_123.png");
      }
    })
  });

  assert.equal(result.signedUrlGenerated, false);
  assert.equal(result.requiredHeadersPresent, false);
  assert.equal(result.errorCategory, "IAM_SIGN_BLOB_DENIED");
  assert.equal(writes.length, 1);
  assertNoSelfTestLeaks(result);
  assertNoSelfTestLeaks(writes[0]);
});
