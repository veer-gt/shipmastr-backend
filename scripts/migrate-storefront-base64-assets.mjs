#!/usr/bin/env node
// SF1c: one-time migration — walks every StorefrontSettings.themeJson row, finds any
// legacy inline `data:image/...;base64,...` blobs (logoUrl / heroImageUrl /
// products[].imageUrl — the shape the wizard used to write before SF1), uploads the
// decoded bytes to GCS as a real StorefrontAsset, and rewrites themeJson to the
// reference shape { logoAssetId, heroImageAssetId, products[].imageAssetId } with the
// matching *Url fields resolved to the new CDN url. Additive/idempotent: rows with no
// base64 are left untouched, and re-running after a partial failure just skips rows
// that were already rewritten (no more `data:image` in them).
//
// SAFE BY DEFAULT: runs as a dry run (reports what it would change) unless --apply is
// passed. Requires STOREFRONT_ASSETS_GCS_BUCKET / STOREFRONT_ASSETS_GCS_PROJECT_ID (or
// GCP_PROJECT_ID) and STOREFRONT_ASSETS_CDN_HOST to be configured for --apply, matching
// the same env vars the running API server uses (see storefront-asset-storage.ts).
//
// Usage:
//   node scripts/migrate-storefront-base64-assets.mjs            # dry run, no writes
//   node scripts/migrate-storefront-base64-assets.mjs --apply    # performs the migration

import { createHash, randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Storage } from "@google-cloud/storage";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const DATA_IMAGE_PATTERN = /^data:image\/(webp|jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const IMAGE_FIELDS_ON_THEME = ["logoUrl", "heroImageUrl"];
const ASSET_ID_FIELD_FOR = {
  logoUrl: "logoAssetId",
  heroImageUrl: "heroImageAssetId"
};

const prisma = new PrismaClient();

function mimeFromDataUrlMatch(match) {
  const kind = match[1].toLowerCase();
  if (kind === "jpg") return { mime: "image/jpeg", ext: "jpg" };
  if (kind === "jpeg") return { mime: "image/jpeg", ext: "jpg" };
  if (kind === "png") return { mime: "image/png", ext: "png" };
  return { mime: "image/webp", ext: "webp" };
}

function getGcsClient() {
  const bucket = String(process.env.STOREFRONT_ASSETS_GCS_BUCKET || "").trim();
  const projectId = String(process.env.STOREFRONT_ASSETS_GCS_PROJECT_ID || process.env.GCP_PROJECT_ID || "").trim();
  const cdnHost = String(process.env.STOREFRONT_ASSETS_CDN_HOST || "").trim();

  if (!bucket || !projectId || !cdnHost) {
    throw new Error(
      "STOREFRONT_ASSETS_GCS_BUCKET, STOREFRONT_ASSETS_GCS_PROJECT_ID (or GCP_PROJECT_ID), and STOREFRONT_ASSETS_CDN_HOST must all be set to run --apply"
    );
  }

  return { storage: new Storage({ projectId }), bucket, cdnHost };
}

async function uploadDecodedAsset({ storage, bucket, cdnHost, merchantId, buffer, mime, ext }) {
  const assetId = `ast_${randomUUID().replace(/-/g, "")}`;
  const gcsPath = `merchants/${merchantId}/storefront/${assetId}.${ext}`;
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  await storage.bucket(bucket).file(gcsPath).save(buffer, {
    contentType: mime,
    resumable: false
  });

  await prisma.storefrontAsset.create({
    data: {
      id: assetId,
      merchantId,
      gcsPath,
      mime,
      bytes: buffer.byteLength,
      sha256,
      status: "READY"
    }
  });

  return { assetId, url: `https://${cdnHost.replace(/\/+$/, "")}/${gcsPath}` };
}

function extractDataImageFields(themeJson) {
  const found = [];
  for (const field of IMAGE_FIELDS_ON_THEME) {
    const value = themeJson?.[field];
    if (typeof value === "string" && value.startsWith("data:image/")) {
      found.push({ path: field, value });
    }
  }
  if (Array.isArray(themeJson?.products)) {
    themeJson.products.forEach((product, index) => {
      const value = product?.imageUrl;
      if (typeof value === "string" && value.startsWith("data:image/")) {
        found.push({ path: `products[${index}].imageUrl`, value });
      }
    });
  }
  return found;
}

async function migrateRow(row, { storage, bucket, cdnHost }) {
  const theme = row.themeJson && typeof row.themeJson === "object" ? { ...row.themeJson } : row.themeJson;
  const hits = extractDataImageFields(theme);
  if (hits.length === 0) return { changed: false };

  for (const field of IMAGE_FIELDS_ON_THEME) {
    const value = theme[field];
    if (typeof value !== "string" || !value.startsWith("data:image/")) continue;

    const match = DATA_IMAGE_PATTERN.exec(value);
    if (!match) {
      throw new Error(`storefrontId=${row.storefrontId} field=${field} has an unrecognized data:image format`);
    }
    const { mime, ext } = mimeFromDataUrlMatch(match);
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`storefrontId=${row.storefrontId} field=${field} exceeds ${MAX_ASSET_BYTES} bytes decoded — skipping, needs manual review`);
    }

    const { assetId, url } = await uploadDecodedAsset({
      storage,
      bucket,
      cdnHost,
      merchantId: row.merchantId,
      buffer,
      mime,
      ext
    });

    theme[ASSET_ID_FIELD_FOR[field]] = assetId;
    theme[field] = url;
  }

  if (Array.isArray(theme.products)) {
    theme.products = await Promise.all(
      theme.products.map(async (product) => {
        const value = product?.imageUrl;
        if (typeof value !== "string" || !value.startsWith("data:image/")) return product;

        const match = DATA_IMAGE_PATTERN.exec(value);
        if (!match) {
          throw new Error(`storefrontId=${row.storefrontId} product image has an unrecognized data:image format`);
        }
        const { mime, ext } = mimeFromDataUrlMatch(match);
        const buffer = Buffer.from(match[2], "base64");
        if (buffer.byteLength > MAX_ASSET_BYTES) {
          throw new Error(`storefrontId=${row.storefrontId} product image exceeds ${MAX_ASSET_BYTES} bytes decoded — skipping, needs manual review`);
        }

        const { assetId, url } = await uploadDecodedAsset({
          storage,
          bucket,
          cdnHost,
          merchantId: row.merchantId,
          buffer,
          mime,
          ext
        });

        return { ...product, imageAssetId: assetId, imageUrl: url };
      })
    );
  }

  return { changed: true, theme, hits: hits.map((h) => h.path) };
}

async function run() {
  const settingsRows = await prisma.storefrontSettings.findMany({
    include: { storefront: { select: { id: true, merchantId: true } } }
  });

  const candidates = settingsRows
    .map((row) => ({
      settingsId: row.id,
      storefrontId: row.storefront.id,
      merchantId: row.storefront.merchantId,
      themeJson: row.themeJson
    }))
    .filter((row) => extractDataImageFields(row.themeJson).length > 0);

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    totalStorefrontSettingsRows: settingsRows.length,
    rowsWithInlineBase64Images: candidates.length,
    storefrontIds: candidates.map((c) => c.storefrontId)
  }, null, 2));

  if (candidates.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  if (!APPLY) {
    console.log("Dry run only — re-run with --apply to perform the migration.");
    return;
  }

  const gcs = getGcsClient();
  const results = [];

  for (const row of candidates) {
    try {
      const outcome = await migrateRow(row, gcs);
      if (outcome.changed) {
        await prisma.storefrontSettings.update({
          where: { id: row.settingsId },
          data: { themeJson: outcome.theme }
        });
        results.push({ storefrontId: row.storefrontId, status: "migrated", fields: outcome.hits });
      }
    } catch (error) {
      results.push({
        storefrontId: row.storefrontId,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  console.log(JSON.stringify({ results }, null, 2));

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length > 0) {
    console.error(`${failed.length} row(s) failed to migrate — see above. Re-run the script after fixing; already-migrated rows are skipped automatically.`);
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
