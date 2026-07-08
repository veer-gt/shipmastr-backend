import { Prisma, StorefrontAssetStatus } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import {
  ALLOWED_STOREFRONT_ASSET_CONTENT_TYPES,
  MAX_STOREFRONT_ASSET_BYTES,
  buildStorefrontAssetGcsPath,
  buildStorefrontAssetPublicUrl,
  getStorefrontAssetStorageAdapter,
  normalizeStorefrontAssetContentType,
  sha256Hex,
  type StorefrontAssetStorageAdapter
} from "./storefront-asset-storage.js";

const UPLOAD_URL_TTL_MS = 5 * 60 * 1000; // 5 minutes — plenty for a client to PUT one photo

type DbClient = Prisma.TransactionClient | typeof prisma;

export type CreateStorefrontAssetUploadUrlInput = {
  merchantId: string;
  contentType: string;
  client?: DbClient;
  storage?: StorefrontAssetStorageAdapter;
};

export type ConfirmStorefrontAssetInput = {
  merchantId: string;
  assetId: string;
  client?: DbClient;
  storage?: StorefrontAssetStorageAdapter;
};

function safeAssetView(asset: {
  id: string;
  status: StorefrontAssetStatus;
  mime: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
}) {
  return {
    id: asset.id,
    status: asset.status,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt
  };
}

/** SF1a step 1: validates entitlement, creates a pending asset row, returns a signed PUT URL. */
export async function createStorefrontAssetUploadUrl(input: CreateStorefrontAssetUploadUrlInput) {
  const client = input.client || prisma;
  const contentType = normalizeStorefrontAssetContentType(input.contentType);
  const storage = input.storage || getStorefrontAssetStorageAdapter();

  const merchant = await client.merchant.findUnique({
    where: { id: input.merchantId },
    select: { id: true }
  });
  if (!merchant) throw new HttpError(404, "MERCHANT_NOT_FOUND");

  const asset = await client.storefrontAsset.create({
    data: {
      merchantId: input.merchantId,
      // gcsPath depends on the asset's own id, so write a placeholder first — real path
      // set immediately after via update (single extra write, still inside the request,
      // never exposed to the client in a partially-consistent state).
      gcsPath: `pending/${input.merchantId}`,
      mime: contentType,
      status: StorefrontAssetStatus.PENDING
    }
  });

  const gcsPath = buildStorefrontAssetGcsPath({ merchantId: input.merchantId, assetId: asset.id, contentType });
  await client.storefrontAsset.update({
    where: { id: asset.id },
    data: { gcsPath }
  });

  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_MS);
  const signedUrl = await storage.createSignedPutUrl({ gcsPath, contentType, expiresAt });

  return {
    assetId: asset.id,
    uploadUrl: signedUrl.uploadUrl,
    method: signedUrl.method,
    headers: signedUrl.headers,
    expiresAt: signedUrl.expiresAt,
    maxBytes: MAX_STOREFRONT_ASSET_BYTES,
    allowedContentTypes: Array.from(ALLOWED_STOREFRONT_ASSET_CONTENT_TYPES)
  };
}

/**
 * SF1a step 2: server verifies the uploaded object directly against GCS (never trusts the
 * client's word on size/type), records a sha256 for dedup, flips status to ready. Only
 * ready assets are referenceable from themeJson (enforced in storefronts.service.ts).
 */
export async function confirmStorefrontAsset(input: ConfirmStorefrontAssetInput) {
  const client = input.client || prisma;
  const storage = input.storage || getStorefrontAssetStorageAdapter();

  const asset = await client.storefrontAsset.findUnique({
    where: { id: input.assetId }
  });
  if (!asset || asset.merchantId !== input.merchantId) {
    throw new HttpError(404, "STOREFRONT_ASSET_NOT_FOUND");
  }
  if (asset.status === StorefrontAssetStatus.READY) {
    return safeAssetView(asset);
  }
  if (asset.status === StorefrontAssetStatus.DELETED) {
    throw new HttpError(409, "STOREFRONT_ASSET_DELETED");
  }

  const head = await storage.headObject({ gcsPath: asset.gcsPath });
  if (!head.exists) {
    throw new HttpError(409, "STOREFRONT_ASSET_UPLOAD_NOT_FOUND");
  }

  const contentType = normalizeStorefrontAssetContentType(head.contentType ?? asset.mime);
  if (head.contentLength === null || head.contentLength <= 0) {
    throw new HttpError(409, "STOREFRONT_ASSET_UPLOAD_EMPTY");
  }
  if (head.contentLength > MAX_STOREFRONT_ASSET_BYTES) {
    // GCS already has the (oversized) object — delete it, don't leave orphaned storage,
    // and reject the confirm. This is the real, GCS-verified enforcement of the 8MB cap,
    // not client-trusted metadata.
    await storage.deleteObject({ gcsPath: asset.gcsPath }).catch((error) => {
      logger.error({ err: error, assetId: asset.id }, "Failed to delete oversized storefront asset upload");
    });
    throw new HttpError(413, "STOREFRONT_ASSET_TOO_LARGE");
  }

  let sha256: string | null = null;
  try {
    const bytes = await storage.downloadForHashing({ gcsPath: asset.gcsPath, maxBytes: MAX_STOREFRONT_ASSET_BYTES });
    sha256 = sha256Hex(bytes);
  } catch (error) {
    logger.warn({ err: error, assetId: asset.id }, "Could not hash storefront asset for dedup — continuing without sha256");
  }

  // Dedup: if an identical file already exists and is ready, reuse it instead of keeping
  // two copies of the same bytes.
  if (sha256) {
    const existingReady = await client.storefrontAsset.findFirst({
      where: {
        merchantId: input.merchantId,
        sha256,
        status: StorefrontAssetStatus.READY,
        id: { not: asset.id }
      }
    });
    if (existingReady) {
      await storage.deleteObject({ gcsPath: asset.gcsPath }).catch(() => undefined);
      await client.storefrontAsset.update({
        where: { id: asset.id },
        data: { status: StorefrontAssetStatus.DELETED }
      });
      return safeAssetView(existingReady);
    }
  }

  const updated = await client.storefrontAsset.update({
    where: { id: asset.id },
    data: {
      status: StorefrontAssetStatus.READY,
      mime: contentType,
      bytes: head.contentLength,
      sha256
    }
  });

  return safeAssetView(updated);
}

/** Used by save-time themeJson validation (SF1b): must be a ready asset owned by this merchant. */
export async function assertReadyStorefrontAssetOwnedByMerchant(input: {
  merchantId: string;
  assetId: string;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const asset = await client.storefrontAsset.findUnique({
    where: { id: input.assetId },
    select: { id: true, merchantId: true, status: true, gcsPath: true }
  });

  if (!asset || asset.merchantId !== input.merchantId) {
    throw new HttpError(400, "STOREFRONT_ASSET_NOT_FOUND_OR_NOT_OWNED");
  }
  if (asset.status !== StorefrontAssetStatus.READY) {
    throw new HttpError(400, "STOREFRONT_ASSET_NOT_READY");
  }

  return asset;
}

export function storefrontAssetPublicUrl(gcsPath: string) {
  return buildStorefrontAssetPublicUrl(gcsPath);
}
