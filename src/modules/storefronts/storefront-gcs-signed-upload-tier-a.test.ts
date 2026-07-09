import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Storage } from "@google-cloud/storage";

import {
  GcsStorefrontAssetStorageAdapter,
  MAX_STOREFRONT_ASSET_BYTES,
  STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH,
  STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER,
  STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
  STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER
} from "./storefront-asset-storage.js";

const requiredEnv = [
  "STOREFRONT_ASSETS_GCS_BUCKET",
  "STOREFRONT_ASSETS_GCS_PROJECT_ID",
  "STOREFRONT_ASSETS_GCS_TEST_SERVICE_ACCOUNT_EMAIL"
] as const;

function tierAEnabled() {
  return process.env.SHIPMASTR_GCS_SIGNED_URL_TESTS === "1"
    && requiredEnv.every((key) => String(process.env[key] ?? "").trim());
}

function requiredHeaders(contentType: string) {
  return {
    "content-type": contentType,
    [STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER]: STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE,
    [STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH_HEADER]: STOREFRONT_ASSET_UPLOAD_IF_GENERATION_MATCH
  };
}

async function putObject(uploadUrl: string, body: Buffer, headers: Record<string, string>) {
  const payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: payload
  });
}

function mutateSignedObjectPath(uploadUrl: string) {
  const url = new URL(uploadUrl);
  url.pathname = url.pathname.replace(/\/[^/]+$/, `/mutated-${randomUUID()}.png`);
  return url.toString();
}

const tierAIt = tierAEnabled() ? it : it.skip;

describe("Tier A storefront GCS signed upload proof", () => {
  tierAIt("enforces signed headers, size, expiry, path, and generation precondition", async () => {
    const bucket = process.env.STOREFRONT_ASSETS_GCS_BUCKET!;
    const projectId = process.env.STOREFRONT_ASSETS_GCS_PROJECT_ID!;
    const storage = new Storage({ projectId });
    const adapter = new GcsStorefrontAssetStorageAdapter({ bucket, projectId, storage });
    const cleanupPaths: string[] = [];

    async function signedPath(suffix: string, expiresAt = new Date(Date.now() + 5 * 60 * 1000)) {
      const gcsPath = `tier-a/storefront-assets/${randomUUID()}-${suffix}.png`;
      cleanupPaths.push(gcsPath);
      const signed = await adapter.createSignedPutUrl({
        gcsPath,
        contentType: "image/png",
        expiresAt
      });
      return { gcsPath, signed };
    }

    try {
      const wrongType = await signedPath("wrong-type");
      const wrongTypeResponse = await putObject(
        wrongType.signed.uploadUrl,
        Buffer.from("png"),
        { ...requiredHeaders("image/png"), "content-type": "image/jpeg" }
      );
      assert.equal(wrongTypeResponse.status, 403);

      const omittedRange = await signedPath("omitted-range");
      const omittedRangeHeaders = requiredHeaders("image/png");
      delete (omittedRangeHeaders as Partial<Record<string, string>>)[STOREFRONT_ASSET_UPLOAD_LENGTH_RANGE_HEADER];
      const omittedRangeResponse = await putObject(
        omittedRange.signed.uploadUrl,
        Buffer.from("png"),
        omittedRangeHeaders
      );
      assert.equal(omittedRangeResponse.status, 403);

      const oversized = await signedPath("oversized");
      const oversizedResponse = await putObject(
        oversized.signed.uploadUrl,
        Buffer.alloc(MAX_STOREFRONT_ASSET_BYTES + 1024 * 1024),
        requiredHeaders("image/png")
      );
      assert.notEqual(oversizedResponse.status, 200);

      const maxAllowed = await signedPath("max-allowed");
      const maxAllowedResponse = await putObject(
        maxAllowed.signed.uploadUrl,
        Buffer.alloc(MAX_STOREFRONT_ASSET_BYTES - 1),
        requiredHeaders("image/png")
      );
      assert.equal(maxAllowedResponse.status, 200);

      const expired = await signedPath("expired", new Date(Date.now() - 60 * 1000));
      const expiredResponse = await putObject(
        expired.signed.uploadUrl,
        Buffer.from("png"),
        requiredHeaders("image/png")
      );
      assert.equal(expiredResponse.status, 403);

      const mutated = await signedPath("mutated");
      const mutatedResponse = await putObject(
        mutateSignedObjectPath(mutated.signed.uploadUrl),
        Buffer.from("png"),
        requiredHeaders("image/png")
      );
      assert.equal(mutatedResponse.status, 403);

      const precondition = await signedPath("precondition");
      const firstPut = await putObject(
        precondition.signed.uploadUrl,
        Buffer.from("png"),
        requiredHeaders("image/png")
      );
      assert.equal(firstPut.status, 200);
      const secondPut = await putObject(
        precondition.signed.uploadUrl,
        Buffer.from("png again"),
        requiredHeaders("image/png")
      );
      assert.equal(secondPut.status, 412);
    } finally {
      await Promise.all(cleanupPaths.map((gcsPath) =>
        storage.bucket(bucket).file(gcsPath).delete({ ignoreNotFound: true }).catch(() => undefined)
      ));
    }
  });
});
