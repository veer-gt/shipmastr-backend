import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { SellerApiKeyStatus, type Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { serializeSellerApiKey } from "./shipping-api-serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const SELLER_API_SCOPES = [
  "orders:write",
  "orders:read",
  "shipments:write",
  "shipments:read",
  "tracking:read",
  "webhooks:write",
  "webhooks:read",
  "operations:read"
] as const;

export type SellerApiScope = typeof SELLER_API_SCOPES[number];

export type CreateSellerApiKeyInput = {
  name: string;
  scopes?: string[] | undefined;
  expiresAt?: Date | null | undefined;
};

function secretHash(raw: string) {
  return crypto
    .createHash("sha256")
    .update(`${env.APP_SECRET_PEPPER}:seller-api-key:${raw}`)
    .digest("hex");
}

export function hashSellerApiKey(raw: string) {
  return secretHash(raw);
}

function generateRawApiKey() {
  return `sk_shipmastr_test_${crypto.randomBytes(24).toString("base64url")}`;
}

function keyPrefix(rawKey: string) {
  const randomPart = rawKey.replace("sk_shipmastr_test_", "");
  return `sk_shipmastr_test_${randomPart.slice(0, 8)}`;
}

function normalizeScopes(scopes: string[] | undefined) {
  const requested = scopes?.length ? scopes : [...SELLER_API_SCOPES];
  const unsupported = requested.filter((scope) => !SELLER_API_SCOPES.includes(scope as SellerApiScope));
  if (unsupported.length) {
    throw new HttpError(400, "SELLER_API_SCOPE_UNSUPPORTED", { scopes: unsupported });
  }
  return [...new Set(requested)];
}

export async function createSellerApiKey(
  merchantId: string,
  input: CreateSellerApiKeyInput,
  client: Db = prisma
) {
  const rawKey = generateRawApiKey();
  const row = await client.sellerApiKey.create({
    data: {
      merchantId,
      name: input.name,
      keyPrefix: keyPrefix(rawKey),
      keyHash: hashSellerApiKey(rawKey),
      scopes: normalizeScopes(input.scopes),
      status: SellerApiKeyStatus.ACTIVE,
      expiresAt: input.expiresAt ?? null
    }
  });

  return serializeSellerApiKey(row, rawKey);
}

export async function listSellerApiKeys(merchantId: string, client: Db = prisma) {
  const keys = await client.sellerApiKey.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" }
  });

  return {
    api_keys: keys.map((key) => serializeSellerApiKey(key))
  };
}

export async function revokeSellerApiKey(merchantId: string, keyId: string, client: Db = prisma) {
  const key = await client.sellerApiKey.findFirst({
    where: { id: keyId, merchantId }
  });
  if (!key) throw new HttpError(404, "SELLER_API_KEY_NOT_FOUND");

  const updated = await client.sellerApiKey.update({
    where: { id: key.id },
    data: {
      status: SellerApiKeyStatus.REVOKED,
      revokedAt: new Date()
    }
  });

  return serializeSellerApiKey(updated);
}

export async function authenticateSellerApiKey(rawKey: string, client: Db = prisma) {
  const hash = hashSellerApiKey(rawKey.trim());
  const key = await client.sellerApiKey.findUnique({
    where: { keyHash: hash }
  });
  if (!key) return null;
  if (key.status !== SellerApiKeyStatus.ACTIVE) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

  await client.sellerApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() }
  });

  return key;
}

export function assertSellerApiScopes(key: { scopes: string[] }, requiredScopes: string[]) {
  const missing = requiredScopes.filter((scope) => !key.scopes.includes(scope));
  if (missing.length) {
    throw new HttpError(403, "SELLER_API_SCOPE_MISSING", { scopes: missing });
  }
}

function readSellerApiKey(req: Request) {
  const headerKey = req.header("x-api-key") || req.header("x-shipmastr-api-key");
  if (headerKey) return headerKey.trim();

  const authorization = req.header("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer sk_shipmastr_")) {
    return authorization.slice(7).trim();
  }

  return "";
}

export function requireSellerApiKey(requiredScopes: string[] = []) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rawKey = readSellerApiKey(req);
    if (!rawKey) {
      return res.status(401).json({ error: "SELLER_API_KEY_REQUIRED" });
    }

    const key = await authenticateSellerApiKey(rawKey);
    if (!key) {
      return res.status(401).json({ error: "SELLER_API_KEY_INVALID" });
    }

    try {
      assertSellerApiScopes(key, requiredScopes);
    } catch (error) {
      if (error instanceof HttpError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    req.auth = {
      userId: `api_key:${key.id}`,
      merchantId: key.merchantId,
      role: "SELLER_API_KEY"
    };
    (req as Request & { sellerApiKey?: { id: string; keyPrefix: string; scopes: string[] } }).sellerApiKey = {
      id: key.id,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes
    };

    return next();
  };
}
