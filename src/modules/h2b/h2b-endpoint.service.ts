import { createHash, randomBytes } from "node:crypto";
import { H2BEndpointStatus, Prisma, StorePlatform } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { H2B_ENDPOINT_GRACE_MS, endpointParts, providerFromPlatform, providerHintForProvider, type H2BProvider } from "./h2b.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

function digest(token: string) { return createHash("sha256").update(token, "utf8").digest("hex"); }
function fingerprint(digestValue: string) { return digestValue.slice(0, 16); }
function generateEndpoint(provider: H2BProvider) {
  const token = `${providerHintForProvider(provider)}_${randomBytes(32).toString("base64url")}`;
  return { token, digest: digest(token) };
}

function safeStatus(row: {
  platform: StorePlatform;
  status: H2BEndpointStatus;
  safeFingerprint: string;
  currentActivatedAt: Date;
  previousValidUntil: Date | null;
  revokedAt: Date | null;
} | null) {
  if (!row) return null;
  return {
    platform: providerFromPlatform(row.platform), status: row.status,
    safeFingerprint: row.safeFingerprint, currentActivatedAt: row.currentActivatedAt,
    previousValidUntil: row.previousValidUntil,
    revoked: Boolean(row.revokedAt) || row.status === H2BEndpointStatus.REVOKED
  };
}

async function ownedConnection(merchantId: string, connectionId: string, client: Db, requireActive = false) {
  const connection = await client.platformConnection.findFirst({ where: { id: connectionId, merchantId } });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  if (requireActive && connection.status !== "ACTIVE") throw new HttpError(409, "H2B_CONNECTION_NOT_ACTIVE");
  if (connection.platform !== StorePlatform.SHOPIFY && connection.platform !== StorePlatform.WOOCOMMERCE && connection.platform !== StorePlatform.MAGENTO) {
    throw new HttpError(400, "H2B_PLATFORM_UNSUPPORTED");
  }
  return connection;
}

async function transaction<T>(client: Db, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await (client as typeof prisma).$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) { if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") continue; throw error; }
    }
  }
  return callback(client as Prisma.TransactionClient);
}

export async function createH2BEndpoint(merchantId: string, connectionId: string, client: Db = prisma) {
  const connection = await ownedConnection(merchantId, connectionId, client, true);
  try {
    const result = await transaction(client, async (tx) => {
      const existing = await tx.h2BConnectionEndpoint.findUnique({ where: { connectionId } });
      if (existing) throw new HttpError(409, "H2B_ENDPOINT_ALREADY_EXISTS");
      const generated = generateEndpoint(providerFromPlatform(connection.platform as "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO"));
      const now = new Date();
      const row = await tx.h2BConnectionEndpoint.create({ data: {
        merchantId, connectionId, platform: connection.platform, status: H2BEndpointStatus.ACTIVE,
        currentDigest: generated.digest, currentActivatedAt: now, previousDigest: null,
        previousValidUntil: null, safeFingerprint: fingerprint(generated.digest), revokedAt: null
      } });
      return { generated, row };
    });
    return { endpoint: result.generated.token, status: safeStatus(result.row), rawEndpointReturned: true };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new HttpError(409, "H2B_ENDPOINT_ALREADY_EXISTS");
    throw error;
  }
}

export async function getH2BEndpointStatus(merchantId: string, connectionId: string, client: Db = prisma) {
  await ownedConnection(merchantId, connectionId, client, false);
  return safeStatus(await client.h2BConnectionEndpoint.findUnique({ where: { connectionId } }));
}

export async function rotateH2BEndpoint(merchantId: string, connectionId: string, client: Db = prisma) {
  const connection = await ownedConnection(merchantId, connectionId, client, true);
  const result = await transaction(client, async (tx) => {
    const current = await tx.h2BConnectionEndpoint.findUnique({ where: { connectionId } });
    if (!current || current.status === H2BEndpointStatus.REVOKED || current.revokedAt) throw new HttpError(409, "H2B_ENDPOINT_NOT_CONFIGURED");
    const now = new Date();
    if (current.previousValidUntil && current.previousValidUntil > now) throw new HttpError(409, "H2B_ENDPOINT_ROTATION_IN_PROGRESS");
    const generated = generateEndpoint(providerFromPlatform(connection.platform as "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO"));
    const row = await tx.h2BConnectionEndpoint.update({ where: { connectionId }, data: {
      merchantId, platform: connection.platform, status: H2BEndpointStatus.ACTIVE,
      currentDigest: generated.digest, currentActivatedAt: now, previousDigest: current.currentDigest,
      previousValidUntil: new Date(now.getTime() + H2B_ENDPOINT_GRACE_MS),
      safeFingerprint: fingerprint(generated.digest), revokedAt: null
    } });
    return { generated, row };
  });
  return { endpoint: result.generated.token, status: safeStatus(result.row), rawEndpointReturned: true };
}

export async function revokeH2BEndpoint(merchantId: string, connectionId: string, client: Db = prisma) {
  await ownedConnection(merchantId, connectionId, client, false);
  const now = new Date();
  const result = await transaction(client, async (tx) => tx.h2BConnectionEndpoint.updateMany({
    where: { merchantId, connectionId, status: { not: H2BEndpointStatus.REVOKED } },
    data: { status: H2BEndpointStatus.REVOKED, revokedAt: now, previousValidUntil: now }
  }));
  if (result.count === 0) return safeStatus(await client.h2BConnectionEndpoint.findUnique({ where: { connectionId } }));
  return safeStatus(await client.h2BConnectionEndpoint.findUnique({ where: { connectionId } }));
}

export async function resolveH2BEndpoint(token: string, client: Db = prisma) {
  const parts = endpointParts(token);
  if (!parts) throw new HttpError(404, "H2B_ENDPOINT_NOT_FOUND");
  const now = new Date();
  const row = await client.h2BConnectionEndpoint.findFirst({
    where: { status: H2BEndpointStatus.ACTIVE, revokedAt: null, OR: [
      { currentDigest: digest(token) }, { previousDigest: digest(token), previousValidUntil: { gt: now } }
    ] }, include: { connection: true }
  });
  if (!row || row.connection.status !== "ACTIVE" || row.connection.merchantId !== row.merchantId || row.connection.platform !== row.platform || providerHintForProvider(providerFromPlatform(row.platform)) !== token.slice(0, 3)) {
    throw new HttpError(404, "H2B_ENDPOINT_NOT_FOUND");
  }
  return row;
}

export function h2bEndpointFingerprint(token: string) { return fingerprint(digest(token)); }
