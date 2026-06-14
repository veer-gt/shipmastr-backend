import {
  PlatformCredentialProvider,
  PlatformCredentialStatus,
  PlatformHealthCheckStatus,
  PlatformHealthCheckType,
  Prisma,
  StorePlatform,
  type PlatformConnection
} from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  createLocalPlatformCredentialVault,
  type PlatformCredentialVault
} from "../credentials/platform-credentials.crypto.js";
import { createCustomApiPlatformClient } from "./custom-api.client.js";
import { createMagentoPlatformClient } from "./magento.client.js";
import type { PlatformApiClient, PlatformHealthStep } from "./platform-api-client.types.js";
import { sanitizeHealthDetails, serializeLatestPlatformHealth, serializePlatformHealthCheck } from "./platform-health-check.serializers.js";
import type { PlatformHealthCheckQueryInput } from "./platform-health-check.validation.js";
import { createShopifyPlatformClient } from "./shopify.client.js";
import { createWooCommercePlatformClient } from "./woocommerce.client.js";

type Db = Prisma.TransactionClient | typeof prisma;

type HealthOptions = {
  client?: Db;
  vault?: PlatformCredentialVault;
  platformClients?: Partial<Record<StorePlatform, PlatformApiClient>>;
  realReadsEnabled?: boolean;
  now?: () => Date;
};

const defaultPlatformClients: Record<StorePlatform, PlatformApiClient> = {
  SHOPIFY: createShopifyPlatformClient(),
  WOOCOMMERCE: createWooCommercePlatformClient(),
  MAGENTO: createMagentoPlatformClient(),
  CUSTOM: createCustomApiPlatformClient()
};

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function providerForPlatform(platform: StorePlatform) {
  return platform as unknown as PlatformCredentialProvider;
}

function credentialIdFromRef(value: string | null | undefined) {
  const ref = String(value || "");
  return ref.startsWith("platform-credential:") ? ref.replace(/^platform-credential:/, "") : null;
}

function severity(status: PlatformHealthCheckStatus) {
  const order: Record<PlatformHealthCheckStatus, number> = {
    [PlatformHealthCheckStatus.HEALTHY]: 0,
    [PlatformHealthCheckStatus.SKIPPED]: 1,
    [PlatformHealthCheckStatus.DEGRADED]: 2,
    [PlatformHealthCheckStatus.NOT_CONFIGURED]: 3,
    [PlatformHealthCheckStatus.FAILED]: 4
  };
  return order[status];
}

function overallStatus(steps: PlatformHealthStep[]) {
  let current: PlatformHealthCheckStatus = PlatformHealthCheckStatus.HEALTHY;
  for (const step of steps) {
    if (severity(step.status) > severity(current)) current = step.status;
  }
  return current;
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

async function resolveCredential(
  merchantId: string,
  connection: PlatformConnection,
  client: Db,
  vault: PlatformCredentialVault
) {
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) return null;

  const credential = await client.platformCredential.findFirst({
    where: { id: credentialId, merchantId }
  });
  if (!credential) throw new HttpError(404, "PLATFORM_CREDENTIAL_NOT_FOUND");
  if (credential.status !== PlatformCredentialStatus.ACTIVE && credential.status !== PlatformCredentialStatus.ROTATED) {
    throw new HttpError(409, "PLATFORM_HEALTH_CREDENTIAL_INACTIVE");
  }
  if (credential.platform !== providerForPlatform(connection.platform)) {
    throw new HttpError(409, "PLATFORM_HEALTH_CREDENTIAL_PLATFORM_MISMATCH");
  }
  const secret = await client.platformCredentialSecret.findUnique({
    where: { credentialId: credential.id }
  });
  if (!secret) throw new HttpError(409, "PLATFORM_HEALTH_CREDENTIAL_SECRET_MISSING");

  return {
    credential,
    plaintext: vault.readSecretForInternalUse({
      encryptedValue: secret.encryptedValue,
      encryptionVersion: secret.encryptionVersion
    })
  };
}

async function persistHealthCheck(
  merchantId: string,
  connection: PlatformConnection,
  status: PlatformHealthCheckStatus,
  message: string,
  safeDetails: unknown,
  errorCode: string | null,
  client: Db,
  checkedAt: Date
) {
  const row = await client.platformConnectionHealthCheck.create({
    data: {
      merchantId,
      connectionId: connection.id,
      platform: connection.platform,
      checkType: PlatformHealthCheckType.OVERALL,
      status,
      message,
      safeDetails: toJson(sanitizeHealthDetails(safeDetails)),
      errorCode,
      checkedAt
    }
  });
  return serializePlatformHealthCheck(row);
}

function missingCredentialSteps(connection: PlatformConnection) {
  return [
    {
      code: "credential_attached",
      label: "Credential attached",
      status: connection.platform === StorePlatform.CUSTOM ? PlatformHealthCheckStatus.DEGRADED : PlatformHealthCheckStatus.NOT_CONFIGURED,
      message: connection.platform === StorePlatform.CUSTOM
        ? "Custom API connection is running metadata-only readiness checks."
        : "Attach a secure platform credential before running platform health checks.",
      safeDetails: {
        mockMode: true,
        credentialAttached: false,
        platform: connection.platform
      },
      errorCode: connection.platform === StorePlatform.CUSTOM ? null : "PLATFORM_HEALTH_CREDENTIAL_MISSING"
    } satisfies PlatformHealthStep
  ];
}

export async function runPlatformConnectionHealthCheck(
  merchantId: string,
  connectionId: string,
  options: HealthOptions = {}
) {
  const client = options.client ?? prisma;
  const vault = options.vault ?? createLocalPlatformCredentialVault();
  const realReadsEnabled = options.realReadsEnabled ?? env.PLATFORM_INTEGRATIONS_ENABLE_REAL_READS;
  const checkedAt = options.now?.() ?? new Date();
  const connection = await findConnection(merchantId, connectionId, client);
  const resolved = await resolveCredential(merchantId, connection, client, vault);
  const platformClient = options.platformClients?.[connection.platform] ?? defaultPlatformClients[connection.platform];

  const steps: PlatformHealthStep[] = resolved ? [
    {
      code: "credential_attached",
      label: "Credential attached",
      status: PlatformHealthCheckStatus.HEALTHY,
      message: "A secure platform credential is attached.",
      safeDetails: {
        credentialAttached: true,
        credentialStatus: resolved.credential.status,
        credentialType: resolved.credential.credentialType,
        mockMode: !realReadsEnabled
      }
    }
  ] : missingCredentialSteps(connection);

  if (resolved || connection.platform === StorePlatform.CUSTOM) {
    const context = {
      platform: connection.platform,
      connectionId: connection.id,
      storeUrl: connection.storeUrl,
      storeName: connection.storeName,
      safeMetadata: (resolved?.credential.safeMetadata as Record<string, unknown> | null) ?? null,
      credentialType: resolved?.credential.credentialType ?? null,
      credentialSecret: resolved?.plaintext ?? null,
      realReadsEnabled
    };

    const checks = [
      ["platform_identity", "Platform identity", () => platformClient.getPlatformIdentity(context)],
      ["authentication", "Authentication", () => platformClient.checkAuthentication(context)],
      ["read_permissions", "Read permissions", () => platformClient.checkReadPermissions(context)],
      ["webhook_capability", "Webhook capability", () => platformClient.checkWebhookCapability(context)],
      ["tracking_or_fulfillment_capability", "Tracking / fulfillment capability", () => platformClient.checkFulfillmentOrTrackingCapability(context)]
    ] as const;

    for (const [code, label, run] of checks) {
      try {
        const result = await run();
        const step: PlatformHealthStep = {
          code,
          label,
          status: result.status,
          message: result.message
        };
        if (result.safeDetails) step.safeDetails = result.safeDetails;
        if (result.errorCode) step.errorCode = result.errorCode;
        steps.push(step);
      } catch {
        steps.push({
          code,
          label,
          status: PlatformHealthCheckStatus.FAILED,
          message: `${label} check failed safely.`,
          errorCode: "PLATFORM_HEALTH_CHECK_FAILED",
          safeDetails: {
            mockMode: !realReadsEnabled
          }
        });
      }
    }
  }

  const status = overallStatus(steps);
  const message = status === PlatformHealthCheckStatus.HEALTHY
    ? "Platform connection is ready for read-only foundation checks."
    : status === PlatformHealthCheckStatus.NOT_CONFIGURED
      ? "Platform connection needs a secure credential before health checks can pass."
      : status === PlatformHealthCheckStatus.FAILED
        ? "Platform connection health check failed safely."
        : "Platform connection is partially ready; review non-critical capability notes.";

  return persistHealthCheck(
    merchantId,
    connection,
    status,
    message,
    {
      mockMode: !realReadsEnabled,
      realReadsEnabled,
      credentialAttached: Boolean(resolved),
      platformClientReady: true,
      steps
    },
    steps.find((step) => step.errorCode)?.errorCode ?? null,
    client,
    checkedAt
  );
}

export async function listPlatformConnectionHealthChecks(
  merchantId: string,
  connectionId: string,
  query: PlatformHealthCheckQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const where: Prisma.PlatformConnectionHealthCheckWhereInput = {
    merchantId,
    connectionId: connection.id
  };
  const [rows, total] = await Promise.all([
    client.platformConnectionHealthCheck.findMany({
      where,
      orderBy: { checkedAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformConnectionHealthCheck.count({ where })
  ]);
  return {
    health_checks: rows.map(serializePlatformHealthCheck),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getLatestPlatformConnectionHealth(
  merchantId: string,
  connectionId: string,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const row = await client.platformConnectionHealthCheck.findFirst({
    where: { merchantId, connectionId: connection.id },
    orderBy: { checkedAt: "desc" }
  });
  return serializeLatestPlatformHealth({
    connectionId: connection.id,
    platform: connection.platform,
    latest: row ? serializePlatformHealthCheck(row) : null
  });
}

export async function runAllPlatformConnectionHealthChecks(
  merchantId: string,
  options: HealthOptions = {}
) {
  const client = options.client ?? prisma;
  const connections = await client.platformConnection.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" }
  });
  const results = [];
  for (const connection of connections) {
    try {
      results.push(await runPlatformConnectionHealthCheck(merchantId, connection.id, options));
    } catch (error) {
      results.push({
        connection_id: connection.id,
        platform: connection.platform,
        status: PlatformHealthCheckStatus.FAILED,
        message: error instanceof HttpError ? error.message : "Platform connection health check failed safely.",
        safe_details: {
          mockMode: !(options.realReadsEnabled ?? env.PLATFORM_INTEGRATIONS_ENABLE_REAL_READS)
        },
        error_code: error instanceof HttpError ? error.message : "PLATFORM_HEALTH_CHECK_FAILED"
      });
    }
  }
  return {
    results,
    total: results.length,
    healthy_count: results.filter((result) => result.status === PlatformHealthCheckStatus.HEALTHY).length,
    attention_count: results.filter((result) => result.status !== PlatformHealthCheckStatus.HEALTHY).length
  };
}
