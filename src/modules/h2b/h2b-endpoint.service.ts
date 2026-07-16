import { createHash, randomBytes } from "node:crypto";
import { H2BEndpointStatus, H2BEndpointTokenRole, PlatformConnectionStatus, Prisma, StorePlatform } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { H2B_ENDPOINT_GRACE_MS, endpointParts, providerFromPlatform, providerHintForProvider, type H2BProvider } from "./h2b.types.js";

type Db = Prisma.TransactionClient | typeof prisma;
type EndpointRow = Prisma.H2BConnectionEndpointGetPayload<{ include: { tokens: true } }>;

function tokenDigest(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function fingerprint(digestValue: string) { return digestValue.slice(0, 16); }
function generateEndpoint(provider: H2BProvider) {
  const token = `${providerHintForProvider(provider)}_${randomBytes(32).toString("base64url")}`;
  const digestValue = tokenDigest(token);
  return { token, digest: digestValue, safeFingerprint: fingerprint(digestValue) };
}

function currentToken(row: EndpointRow) { return row.tokens.find((token) => token.role === H2BEndpointTokenRole.CURRENT) ?? null; }
function previousToken(row: EndpointRow) { return row.tokens.find((token) => token.role === H2BEndpointTokenRole.PREVIOUS) ?? null; }

function safeStatus(row: EndpointRow | null) {
  if (!row) return null;
  const current = currentToken(row);
  const previous = previousToken(row);
  return {
    platform: providerFromPlatform(row.platform),
    status: row.status,
    safeFingerprint: current?.safeFingerprint ?? previous?.safeFingerprint ?? null,
    currentActivatedAt: current?.activatedAt ?? row.createdAt,
    previousValidUntil: previous?.validUntil ?? null,
    revoked: Boolean(row.revokedAt) || row.status === H2BEndpointStatus.REVOKED
  };
}

async function transaction<T>(client: Db, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await (client as typeof prisma).$transaction(callback, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"))) continue;
        throw error;
      }
    }
  }
  return callback(client as Prisma.TransactionClient);
}

async function lockConnection(tx: Prisma.TransactionClient, merchantId: string, connectionId: string, requireActive: boolean) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "platform_connections"
    WHERE id = ${connectionId} AND merchant_id = ${merchantId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  const connection = await tx.platformConnection.findUnique({ where: { id: connectionId } });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  if (requireActive && connection.status !== PlatformConnectionStatus.ACTIVE) throw new HttpError(409, "H2B_CONNECTION_NOT_ACTIVE");
  if (connection.platform !== StorePlatform.SHOPIFY && connection.platform !== StorePlatform.WOOCOMMERCE && connection.platform !== StorePlatform.MAGENTO) {
    throw new HttpError(400, "H2B_PLATFORM_UNSUPPORTED");
  }
  return connection;
}

async function lockEndpoint(tx: Prisma.TransactionClient, connectionId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "h2b_connection_endpoints"
    WHERE connection_id = ${connectionId}
    FOR UPDATE
  `;
  if (locked.length !== 1) return null;
  return tx.h2BConnectionEndpoint.findUnique({ where: { connectionId }, include: { tokens: true } });
}

async function lockTokens(tx: Prisma.TransactionClient, endpointId: string) {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "h2b_connection_endpoint_tokens"
    WHERE endpoint_id = ${endpointId}
    FOR UPDATE
  `;
  return tx.h2BConnectionEndpointToken.findMany({ where: { endpointId } });
}

export async function createH2BEndpoint(merchantId: string, connectionId: string, client: Db = prisma) {
  try {
    const result = await transaction(client, async (tx) => {
      const connection = await lockConnection(tx, merchantId, connectionId, true);
      const existing = await lockEndpoint(tx, connectionId);
      if (existing) throw new HttpError(409, "H2B_ENDPOINT_ALREADY_EXISTS");
      const generated = generateEndpoint(providerFromPlatform(connection.platform as H2BProvider));
      const now = new Date();
      const row = await tx.h2BConnectionEndpoint.create({ data: {
        merchantId, connectionId, platform: connection.platform, status: H2BEndpointStatus.ACTIVE, generation: 1, revokedAt: null,
        tokens: { create: { digest: generated.digest, role: H2BEndpointTokenRole.CURRENT, platform: connection.platform, generation: 1, activatedAt: now, validUntil: null, revokedAt: null, safeFingerprint: generated.safeFingerprint } }
      }, include: { tokens: true } });
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
  const connection = await client.platformConnection.findFirst({ where: { id: connectionId, merchantId } });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return safeStatus(await client.h2BConnectionEndpoint.findUnique({ where: { connectionId }, include: { tokens: true } }));
}

export async function rotateH2BEndpoint(merchantId: string, connectionId: string, client: Db = prisma) {
  const result = await transaction(client, async (tx) => {
    const connection = await lockConnection(tx, merchantId, connectionId, true);
    const current = await lockEndpoint(tx, connectionId);
    if (!current || current.status === H2BEndpointStatus.REVOKED || current.revokedAt) throw new HttpError(409, "H2B_ENDPOINT_NOT_CONFIGURED");
    await lockTokens(tx, current.id);
    const previous = previousToken(current);
    const activeCurrent = currentToken(current);
    const now = new Date();
    if (!activeCurrent) throw new HttpError(409, "H2B_ENDPOINT_NOT_CONFIGURED");
    if (previous?.validUntil && previous.validUntil > now) throw new HttpError(409, "H2B_ENDPOINT_ROTATION_IN_PROGRESS");
    const generated = generateEndpoint(providerFromPlatform(connection.platform as H2BProvider));
    await tx.h2BConnectionEndpointToken.deleteMany({ where: { endpointId: current.id, role: H2BEndpointTokenRole.PREVIOUS } });
    await tx.h2BConnectionEndpointToken.update({ where: { id: activeCurrent.id }, data: { role: H2BEndpointTokenRole.PREVIOUS, generation: current.generation, validUntil: new Date(now.getTime() + H2B_ENDPOINT_GRACE_MS), revokedAt: null } });
    const row = await tx.h2BConnectionEndpoint.update({ where: { id: current.id }, data: {
      status: H2BEndpointStatus.ACTIVE, generation: { increment: 1 }, revokedAt: null,
      tokens: { create: { digest: generated.digest, role: H2BEndpointTokenRole.CURRENT, platform: connection.platform, generation: current.generation + 1, activatedAt: now, validUntil: null, revokedAt: null, safeFingerprint: generated.safeFingerprint } }
    }, include: { tokens: true } });
    return { generated, row };
  });
  return { endpoint: result.generated.token, status: safeStatus(result.row), rawEndpointReturned: true };
}

export async function revokeH2BEndpoint(merchantId: string, connectionId: string, client: Db = prisma) {
  const result = await transaction(client, async (tx) => {
    await lockConnection(tx, merchantId, connectionId, false);
    const current = await lockEndpoint(tx, connectionId);
    if (!current) return null;
    await lockTokens(tx, current.id);
    const now = new Date();
    await tx.h2BConnectionEndpointToken.updateMany({ where: { endpointId: current.id }, data: { revokedAt: now, validUntil: now } });
    return tx.h2BConnectionEndpoint.update({ where: { id: current.id }, data: { status: H2BEndpointStatus.REVOKED, revokedAt: now }, include: { tokens: true } });
  });
  return safeStatus(result);
}

export async function resolveH2BEndpoint(token: string, client: Db = prisma) {
  const parts = endpointParts(token);
  if (!parts) throw new HttpError(404, "H2B_ENDPOINT_NOT_FOUND");
  const now = new Date();
  const row = await client.h2BConnectionEndpointToken.findUnique({ where: { digest: tokenDigest(token) }, include: { endpoint: { include: { connection: true, tokens: true } } } });
  if (!row || row.revokedAt || (row.role === H2BEndpointTokenRole.PREVIOUS && (!row.validUntil || row.validUntil <= now)) || row.endpoint.status !== H2BEndpointStatus.ACTIVE || row.endpoint.revokedAt || row.endpoint.connection.status !== PlatformConnectionStatus.ACTIVE || row.endpoint.connection.merchantId !== row.endpoint.merchantId || row.endpoint.connection.platform !== row.endpoint.platform || providerHintForProvider(providerFromPlatform(row.endpoint.platform)) !== parts.token.slice(0, 3)) {
    throw new HttpError(404, "H2B_ENDPOINT_NOT_FOUND");
  }
  return { ...row.endpoint, safeFingerprint: row.safeFingerprint, resolvedTokenRole: row.role };
}

export function h2bEndpointFingerprint(token: string) { return fingerprint(tokenDigest(token)); }
