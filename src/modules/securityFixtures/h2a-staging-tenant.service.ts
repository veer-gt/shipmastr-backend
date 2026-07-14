import { randomUUID } from "node:crypto";
import {
  MerchantAdminStatus,
  Prisma,
  SecurityFixtureKind,
  SecurityFixtureStatus,
  PlatformConnectionStatus,
  PlatformCredentialPurpose
} from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { hashPassword } from "../auth/password-hashing.js";
import { revokePlatformWebhookCredential } from "../credentialVault/platform-webhook-credential.service.js";
import {
  H2A_ACTIVE_SLOT,
  H2A_CONNECTION_MARKER,
  H2A_FIXTURE_KIND,
  type H2ACreateInput
} from "./h2a-staging-tenant.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const H2A_ALREADY_ACTIVE = "H2A_SYNTHETIC_TENANT_ALREADY_ACTIVE";
export const H2A_CLEANUP_FAILED = "H2A_SECOND_TENANT_CLEANUP_FAILED";
export const H2A_UNEXPECTED_STATE = "H2A_SECOND_TENANT_UNEXPECTED_STATE";

export function lifecycleEnabledFor(input: { appEnv: string; enabled: boolean }) {
  return input.appEnv === "staging" && input.enabled;
}

export function fixtureStatusAllowsAuthentication(input: {
  status: SecurityFixtureStatus;
  expiresAt: Date;
  now?: Date;
}) {
  return input.status === SecurityFixtureStatus.ACTIVE && input.expiresAt > (input.now ?? new Date());
}

function assertEnabled() {
  if (!lifecycleEnabledFor({ appEnv: env.APP_ENV, enabled: env.H2A_SYNTHETIC_TENANT_LIFECYCLE_ENABLED })) {
    throw new HttpError(404, "NOT_FOUND");
  }
}

function notFound() {
  return new HttpError(404, "H2A_SYNTHETIC_TENANT_NOT_FOUND");
}

export function safeFixtureStatus(row: {
  status: SecurityFixtureStatus;
  expiresAt: Date;
  cleanupAt: Date | null;
  merchantId: string | null;
}, counts: { connections: number; credentials: number }, now = new Date()) {
  const expired = row.status === SecurityFixtureStatus.EXPIRED || row.expiresAt <= now;
  const active = row.status === SecurityFixtureStatus.ACTIVE && !expired;
  return {
    status: expired && row.status === SecurityFixtureStatus.ACTIVE ? SecurityFixtureStatus.EXPIRED : row.status,
    active,
    expired,
    ownerEnabled: active,
    merchantEnabled: active,
    syntheticConnectionCount: counts.connections,
    configuredCredentialCount: counts.credentials,
    cleanupRequired: row.status !== SecurityFixtureStatus.CLEANED,
    expiresAt: row.expiresAt,
    cleanupAt: row.cleanupAt
  };
}

async function countsFor(client: Db, merchantId: string | null) {
  if (!merchantId) return { connections: 0, credentials: 0 };
  const [connections, credentials] = await Promise.all([
    client.platformConnection.count({ where: { merchantId, storeName: H2A_CONNECTION_MARKER } }),
    client.platformWebhookCredential.count({
      where: {
        merchantId,
        connection: { storeName: H2A_CONNECTION_MARKER },
        purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE,
        revokedAt: null
      }
    })
  ]);
  return { connections, credentials };
}

async function expireIfNeeded(id: string) {
  await prisma.securityFixtureTenant.updateMany({
    where: { id, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT, status: SecurityFixtureStatus.ACTIVE, expiresAt: { lte: new Date() } },
    data: { status: SecurityFixtureStatus.EXPIRED }
  });
}

export async function fixtureAuthenticationAllowed(userId: string) {
  if (!lifecycleEnabledFor({ appEnv: env.APP_ENV, enabled: env.H2A_SYNTHETIC_TENANT_LIFECYCLE_ENABLED })) return true;
  try {
    const fixture = await prisma.securityFixtureTenant.findFirst({
      where: { ownerUserId: userId, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT },
      select: { status: true, expiresAt: true }
    });
    if (!fixture) return true;
    return fixtureStatusAllowsAuthentication(fixture);
  } catch {
    return false;
  }
}

export async function createH2AStagingTenant(input: H2ACreateInput, creatorInternalUserId: string) {
  assertEnabled();
  const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const fixture = await tx.securityFixtureTenant.create({
        data: {
          id: randomUUID(),
          fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT,
          status: SecurityFixtureStatus.CREATING,
          activeSlot: H2A_ACTIVE_SLOT,
          creatorInternalUserId,
          expiresAt
        }
      });
      const passwordHash = await hashPassword(input.password);
      const merchant = await tx.merchant.create({
        data: {
          name: input.merchantName,
          email: input.email
        }
      });
      const owner = await tx.user.create({
        data: {
          merchantId: merchant.id,
          email: input.email,
          name: input.ownerName,
          passwordHash,
          userType: "MERCHANT_ACCOUNT",
          role: "MERCHANT_OWNER"
        }
      });
      await tx.securityFixtureTenant.update({
        where: { id: fixture.id },
        data: { merchantId: merchant.id, ownerUserId: owner.id, status: SecurityFixtureStatus.ACTIVE }
      });
      await tx.auditLog.create({
        data: {
          action: "H2A_SYNTHETIC_TENANT_CREATED",
          entityType: "SecurityFixtureTenant",
          entityId: fixture.id,
          merchantId: merchant.id,
          actorId: creatorInternalUserId,
          metadata: { fixtureKind: H2A_FIXTURE_KIND, status: SecurityFixtureStatus.ACTIVE }
        }
      });
      return fixture;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { fixtureId: created.id, status: SecurityFixtureStatus.ACTIVE, expiresAt: created.expiresAt, ownerReady: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new HttpError(409, H2A_ALREADY_ACTIVE);
    }
    throw error;
  }
}

export async function getH2AStagingTenant(fixtureId: string) {
  assertEnabled();
  await expireIfNeeded(fixtureId);
  const row = await prisma.securityFixtureTenant.findFirst({
    where: { id: fixtureId, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT },
    select: { status: true, expiresAt: true, cleanupAt: true, merchantId: true }
  });
  if (!row) throw notFound();
  return safeFixtureStatus(row, await countsFor(prisma, row.merchantId));
}

async function hasUnexpectedState(tx: Prisma.TransactionClient, merchantId: string) {
  const connections = await tx.platformConnection.findMany({ where: { merchantId }, select: { id: true, storeName: true } });
  if (connections.some((connection) => connection.storeName !== H2A_CONNECTION_MARKER)) return true;
  const [orders, shipments, firstShipmentRequests, checkoutOrders, checkoutPayments] = await Promise.all([
    tx.order.findFirst({ where: { merchantId }, select: { id: true } }),
    tx.shipment.findFirst({ where: { sellerId: merchantId }, select: { id: true } }),
    tx.firstShipmentRequest.findFirst({ where: { merchantId }, select: { id: true } }),
    tx.checkoutOrder.findFirst({ where: { merchantId }, select: { id: true } }),
    tx.checkoutPayment.findFirst({ where: { merchantId }, select: { id: true } })
  ]);
  return Boolean(orders || shipments || firstShipmentRequests || checkoutOrders || checkoutPayments);
}

async function markCleanupFailed(fixtureId: string, code: string) {
  await prisma.securityFixtureTenant.updateMany({
    where: { id: fixtureId, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT },
    data: { status: SecurityFixtureStatus.FAILED, lastErrorCode: code }
  });
}

export async function cleanupH2AStagingTenant(fixtureId: string) {
  assertEnabled();
  await expireIfNeeded(fixtureId);
  const current = await prisma.securityFixtureTenant.findFirst({
    where: { id: fixtureId, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT }
  });
  if (!current) throw notFound();
  if (current.status === SecurityFixtureStatus.CLEANED) {
    return safeFixtureStatus(current, await countsFor(prisma, current.merchantId));
  }
  if (current.status !== SecurityFixtureStatus.ACTIVE && current.status !== SecurityFixtureStatus.EXPIRED && current.status !== SecurityFixtureStatus.FAILED) {
    throw new HttpError(409, "H2A_SECOND_TENANT_CLEANUP_IN_PROGRESS");
  }
  const claimed = await prisma.securityFixtureTenant.updateMany({
    where: { id: fixtureId, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT, status: { in: [SecurityFixtureStatus.ACTIVE, SecurityFixtureStatus.EXPIRED, SecurityFixtureStatus.FAILED] } },
    data: { status: SecurityFixtureStatus.CLEANING, lastErrorCode: null }
  });
  if (claimed.count !== 1) throw new HttpError(409, "H2A_SECOND_TENANT_CLEANUP_IN_PROGRESS");

  try {
    const cleaned = await prisma.$transaction(async (tx) => {
      const fixture = await tx.securityFixtureTenant.findFirst({
        where: { id: fixtureId, fixtureKind: SecurityFixtureKind.H2A_STAGING_CROSS_TENANT, status: SecurityFixtureStatus.CLEANING }
      });
      if (!fixture || !fixture.merchantId) throw new Error(H2A_CLEANUP_FAILED);
      if (await hasUnexpectedState(tx, fixture.merchantId)) throw new Error(H2A_UNEXPECTED_STATE);
      const connections = await tx.platformConnection.findMany({
        where: { merchantId: fixture.merchantId, storeName: H2A_CONNECTION_MARKER },
        select: { id: true, status: true }
      });
      for (const connection of connections) {
        if (connection.status !== PlatformConnectionStatus.DISABLED) {
          await revokePlatformWebhookCredential(fixture.merchantId!, connection.id, tx);
        }
      }
      const credentialRows = connections.length
        ? await tx.platformWebhookCredential.findMany({
            where: { merchantId: fixture.merchantId, connectionId: { in: connections.map((connection) => connection.id) }, purpose: PlatformCredentialPurpose.PLATFORM_WEBHOOK_SIGNATURE },
            select: { revokedAt: true, encryptedCurrentValue: true, currentNonce: true, currentAuthTag: true, encryptedPreviousValue: true, previousNonce: true, previousAuthTag: true }
          })
        : [];
      if (credentialRows.some((row) => !row.revokedAt || row.encryptedCurrentValue || row.currentNonce || row.currentAuthTag || row.encryptedPreviousValue || row.previousNonce || row.previousAuthTag)) {
        throw new Error(H2A_CLEANUP_FAILED);
      }
      for (const connection of connections) {
        await tx.platformConnection.update({ where: { id: connection.id }, data: { status: PlatformConnectionStatus.DISABLED, disabledAt: new Date() } });
      }
      await tx.merchant.update({ where: { id: fixture.merchantId }, data: { adminStatus: MerchantAdminStatus.BLOCKED } });
      const updated = await tx.securityFixtureTenant.update({
        where: { id: fixture.id },
        data: { status: SecurityFixtureStatus.CLEANED, cleanupAt: new Date(), activeSlot: null, lastErrorCode: null }
      });
      await tx.auditLog.create({
        data: {
          action: "H2A_SYNTHETIC_TENANT_CLEANED",
          entityType: "SecurityFixtureTenant",
          entityId: fixture.id,
          merchantId: fixture.merchantId,
          metadata: { fixtureKind: H2A_FIXTURE_KIND, status: SecurityFixtureStatus.CLEANED }
        }
      });
      return updated;
    });
    return safeFixtureStatus(cleaned, await countsFor(prisma, cleaned.merchantId));
  } catch (error) {
    const code = error instanceof Error && error.message === H2A_UNEXPECTED_STATE ? H2A_UNEXPECTED_STATE : H2A_CLEANUP_FAILED;
    try {
      await markCleanupFailed(fixtureId, code);
    } catch {
      // Preserve the stable cleanup blocker even if the failure marker cannot be written.
    }
    throw new HttpError(409, code);
  }
}
