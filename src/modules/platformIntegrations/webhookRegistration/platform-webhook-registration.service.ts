import {
  PlatformCredentialStatus,
  Prisma,
  StorePlatform,
  type PlatformConnection
} from "@prisma/client";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { getLivePilotReadinessSnapshot } from "../../livePilot/live-pilot.service.js";
import { sanitizeLivePilotMeta } from "../../livePilot/live-pilot.serializer.js";
import {
  buildCallbackUrl,
  getPlatformWebhookRegistrationRuntime,
  resolveTopicSpecs
} from "./platform-webhook-registration.providers.js";
import {
  sanitizeWebhookRegistrationValue,
  serializePlatformWebhookRegistration,
  serializeWebhookRegistrationReadiness
} from "./platform-webhook-registration.serializer.js";
import type {
  PlatformWebhookRegistrationRuntime,
  PlatformWebhookRegistrationTopicSpec
} from "./platform-webhook-registration.types.js";
import type {
  DisablePlatformWebhookRegistrationInput,
  DryRunPlatformWebhookRegistrationInput,
  ListPlatformWebhookRegistrationsQueryInput,
  RegisterPlatformWebhooksInput
} from "./platform-webhook-registration.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Source = Record<string, unknown>;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeWebhookRegistrationValue(value ?? {}))) as Prisma.InputJsonValue;
}

function credentialIdFromRef(value: string | null | undefined) {
  const ref = String(value || "");
  return ref.startsWith("platform-credential:") ? ref.replace(/^platform-credential:/, "") : null;
}

async function audit(
  merchantId: string,
  action: string,
  input: { targetId?: string | null; safeMeta?: unknown },
  client: Db
) {
  if (!("livePilotAuditLog" in client)) return null;
  return client.livePilotAuditLog.create({
    data: {
      merchantId,
      action,
      actorId: merchantId,
      targetType: "PlatformWebhookRegistration",
      targetId: input.targetId ?? null,
      safeMeta: JSON.parse(JSON.stringify(sanitizeLivePilotMeta(input.safeMeta ?? {}))) as Prisma.InputJsonValue
    }
  });
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  if (
    connection.platform !== StorePlatform.SHOPIFY
    && connection.platform !== StorePlatform.WOOCOMMERCE
    && connection.platform !== StorePlatform.MAGENTO
  ) {
    throw new HttpError(400, "PLATFORM_WEBHOOK_REGISTRATION_PLATFORM_UNSUPPORTED");
  }
  return connection;
}

function assertRuntimeEnabled(runtime: PlatformWebhookRegistrationRuntime) {
  if (!runtime.enabled) throw new HttpError(409, "PLATFORM_WEBHOOK_REGISTRATION_DISABLED");
  if (!runtime.pilotOnly) throw new HttpError(409, "PLATFORM_WEBHOOK_REGISTRATION_NOT_PILOT_ONLY");
  if (!runtime.callbackBaseConfigured) throw new HttpError(409, "PLATFORM_WEBHOOK_CALLBACK_URL_MISSING");
}

function assertCallbackUrl(value: string | null): asserts value is string {
  if (!value) throw new HttpError(409, "PLATFORM_WEBHOOK_CALLBACK_URL_MISSING");
  try {
    const parsed = new URL(value);
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !local) {
      throw new HttpError(409, "PLATFORM_WEBHOOK_CALLBACK_URL_HTTPS_REQUIRED");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "PLATFORM_WEBHOOK_CALLBACK_URL_INVALID");
  }
}

async function credentialReady(merchantId: string, connection: PlatformConnection, client: Db) {
  const credentialId = credentialIdFromRef(connection.credentialsRef);
  if (!credentialId) return { ready: false, blocker: "PLATFORM_WEBHOOK_CREDENTIAL_MISSING" };
  const credential = await client.platformCredential.findFirst({
    where: { id: credentialId, merchantId }
  });
  if (!credential) return { ready: false, blocker: "PLATFORM_WEBHOOK_CREDENTIAL_MISSING" };
  if (credential.status !== PlatformCredentialStatus.ACTIVE) return { ready: false, blocker: "PLATFORM_WEBHOOK_CREDENTIAL_NOT_ACTIVE" };
  if (String(credential.platform) !== String(connection.platform)) return { ready: false, blocker: "PLATFORM_WEBHOOK_CREDENTIAL_PLATFORM_MISMATCH" };
  const secret = await client.platformCredentialSecret.findUnique({
    where: { credentialId: credential.id }
  });
  if (!secret) return { ready: false, blocker: "PLATFORM_WEBHOOK_CREDENTIAL_DATA_MISSING" };
  return { ready: true, blocker: null };
}

async function evaluateReadiness(
  merchantId: string,
  connection: PlatformConnection,
  runtime: PlatformWebhookRegistrationRuntime,
  client: Db,
  options: { liveRequired?: boolean } = {}
) {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!runtime.enabled) blockers.push("PLATFORM_WEBHOOK_REGISTRATION_DISABLED");
  if (!runtime.pilotOnly) blockers.push("PLATFORM_WEBHOOK_REGISTRATION_NOT_PILOT_ONLY");
  if (!runtime.callbackBaseConfigured) blockers.push("PLATFORM_WEBHOOK_CALLBACK_URL_MISSING");

  const pilot = await getLivePilotReadinessSnapshot(merchantId, client);
  if (options.liveRequired) {
    if (!pilot.allowlisted) blockers.push("LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED");
    if (!pilot.enabledCapabilities.includes("LIVE_WEBHOOK_REGISTRATION")) {
      blockers.push("LIVE_WEBHOOK_REGISTRATION_CAPABILITY_REQUIRED");
    }
  } else if (!pilot.allowlisted || !pilot.enabledCapabilities.includes("LIVE_WEBHOOK_REGISTRATION")) {
    warnings.push("Pilot live webhook registration is not enabled; dry-run registration only.");
  }

  const credential = await credentialReady(merchantId, connection, client);
  if (!credential.ready && credential.blocker) blockers.push(credential.blocker);

  return {
    pilot,
    credential,
    blockers,
    warnings,
    ready: blockers.length === 0
  };
}

function safeMeta(input: {
  runtime: PlatformWebhookRegistrationRuntime;
  spec: PlatformWebhookRegistrationTopicSpec;
  readiness: Awaited<ReturnType<typeof evaluateReadiness>>;
  action: "DRY_RUN" | "REGISTER";
}) {
  return {
    mode: input.runtime.mode,
    action: input.action,
    provider_topic: input.spec.providerTopic,
    callback_ready: input.runtime.callbackBaseConfigured,
    pilot_allowlisted: input.readiness.pilot.allowlisted,
    pilot_capability_enabled: input.readiness.pilot.enabledCapabilities.includes("LIVE_WEBHOOK_REGISTRATION"),
    credential_ready: input.readiness.credential.ready,
    blockers: input.readiness.blockers,
    warnings: input.readiness.warnings,
    dry_run: input.action === "DRY_RUN" || input.runtime.mode !== "LIVE",
    live_registration_performed: false,
    store_mutation: false,
    platform_write_performed: false,
    webhook_secret_exposed: false
  };
}

async function upsertRegistration(
  merchantId: string,
  connection: PlatformConnection,
  runtime: PlatformWebhookRegistrationRuntime,
  spec: PlatformWebhookRegistrationTopicSpec,
  readiness: Awaited<ReturnType<typeof evaluateReadiness>>,
  action: "DRY_RUN" | "REGISTER",
  client: Db
) {
  const callbackUrl = buildCallbackUrl(runtime, spec, connection.id);
  assertCallbackUrl(callbackUrl);
  const callbackUrlSafe = callbackUrl;
  const status = readiness.ready
    ? action === "REGISTER" && runtime.mode === "LIVE"
      ? "READY"
      : "READY"
    : "BLOCKED";
  const record = await client.platformWebhookRegistration.upsert({
    where: { connectionId_topic: { connectionId: connection.id, topic: spec.topic } },
    create: {
      merchantId,
      connectionId: connection.id,
      platform: connection.platform,
      topic: spec.topic,
      callbackUrlSafe,
      status,
      registeredAt: null,
      disabledAt: null,
      safeMeta: toJson(safeMeta({ runtime, spec, readiness, action }))
    },
    update: {
      callbackUrlSafe,
      status,
      disabledAt: null,
      safeMeta: toJson(safeMeta({ runtime, spec, readiness, action }))
    }
  });
  await audit(merchantId, action === "REGISTER" ? "PLATFORM_WEBHOOK_REGISTRATION_EVALUATED" : "PLATFORM_WEBHOOK_REGISTRATION_DRY_RUN", {
    targetId: record.id,
    safeMeta: {
      connection_id: connection.id,
      platform: connection.platform,
      topic: spec.topic,
      status,
      live_registration_performed: false
    }
  }, client);
  return serializePlatformWebhookRegistration(record);
}

export async function getPlatformWebhookRegistrationReadiness(
  merchantId: string,
  connectionId: string,
  client: Db = prisma,
  source: Source = env
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const runtime = getPlatformWebhookRegistrationRuntime(source);
  const readiness = await evaluateReadiness(merchantId, connection, runtime, client, { liveRequired: runtime.mode === "LIVE" });
  return serializeWebhookRegistrationReadiness({
    status: readiness.ready ? "READY" : runtime.enabled ? "BLOCKED" : "DISABLED",
    ready: readiness.ready,
    runtime,
    blockers: readiness.blockers,
    warnings: readiness.warnings
  });
}

export async function listPlatformWebhookRegistrations(
  merchantId: string,
  query: ListPlatformWebhookRegistrationsQueryInput,
  client: Db = prisma
) {
  const where: Prisma.PlatformWebhookRegistrationWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.topic ? { topic: query.topic } : {})
  };
  const [registrations, total] = await Promise.all([
    client.platformWebhookRegistration.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformWebhookRegistration.count({ where })
  ]);
  return {
    registrations: registrations.map(serializePlatformWebhookRegistration),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getPlatformWebhookRegistration(merchantId: string, registrationId: string, client: Db = prisma) {
  const record = await client.platformWebhookRegistration.findFirst({
    where: { id: registrationId, merchantId }
  });
  if (!record) throw new HttpError(404, "PLATFORM_WEBHOOK_REGISTRATION_NOT_FOUND");
  return serializePlatformWebhookRegistration(record);
}

export async function dryRunPlatformWebhookRegistration(
  merchantId: string,
  input: DryRunPlatformWebhookRegistrationInput,
  client: Db = prisma,
  source: Source = env
) {
  const connection = await findConnection(merchantId, input.connectionId, client);
  const runtime = getPlatformWebhookRegistrationRuntime(source);
  assertRuntimeEnabled(runtime);
  const specs = resolveTopicSpecs(connection.platform, input.topics);
  if (!specs.length) throw new HttpError(400, "PLATFORM_WEBHOOK_REGISTRATION_TOPIC_UNSUPPORTED");
  const readiness = await evaluateReadiness(merchantId, connection, runtime, client, { liveRequired: false });
  const registrations = [];
  for (const spec of specs) {
    registrations.push(await upsertRegistration(merchantId, connection, runtime, spec, readiness, "DRY_RUN", client));
  }
  return { registrations, readiness: await getPlatformWebhookRegistrationReadiness(merchantId, connection.id, client, source) };
}

export async function registerPlatformConnectionWebhooks(
  merchantId: string,
  connectionId: string,
  input: RegisterPlatformWebhooksInput,
  client: Db = prisma,
  source: Source = env
) {
  const connection = await findConnection(merchantId, connectionId, client);
  const runtime = getPlatformWebhookRegistrationRuntime(source);
  assertRuntimeEnabled(runtime);
  const specs = resolveTopicSpecs(connection.platform, input.topics);
  if (!specs.length) throw new HttpError(400, "PLATFORM_WEBHOOK_REGISTRATION_TOPIC_UNSUPPORTED");
  const readiness = await evaluateReadiness(merchantId, connection, runtime, client, { liveRequired: runtime.mode === "LIVE" });
  if (runtime.mode === "LIVE" && readiness.blockers.length) {
    throw new HttpError(409, readiness.blockers[0] || "PLATFORM_WEBHOOK_REGISTRATION_BLOCKED");
  }
  const registrations = [];
  for (const spec of specs) {
    registrations.push(await upsertRegistration(merchantId, connection, runtime, spec, readiness, "REGISTER", client));
  }
  return {
    registrations,
    readiness: await getPlatformWebhookRegistrationReadiness(merchantId, connection.id, client, source),
    live_registration_performed: false,
    message: runtime.mode === "LIVE"
      ? "Pilot gates passed, but external webhook provider registration remains interface-only in this phase."
      : "Dry-run registration recorded. No external platform webhook was registered."
  };
}

export async function disablePlatformWebhookRegistration(
  merchantId: string,
  registrationId: string,
  input: DisablePlatformWebhookRegistrationInput,
  client: Db = prisma
) {
  const existing = await client.platformWebhookRegistration.findFirst({
    where: { id: registrationId, merchantId }
  });
  if (!existing) throw new HttpError(404, "PLATFORM_WEBHOOK_REGISTRATION_NOT_FOUND");
  const record = await client.platformWebhookRegistration.update({
    where: { id: existing.id },
    data: {
      status: "DISABLED",
      disabledAt: new Date(),
      safeMeta: toJson({
        ...(typeof existing.safeMeta === "object" && existing.safeMeta ? existing.safeMeta : {}),
        disabled_reason: input.reason ?? null,
        live_registration_performed: false,
        store_mutation: false
      })
    }
  });
  await audit(merchantId, "PLATFORM_WEBHOOK_REGISTRATION_DISABLED", {
    targetId: record.id,
    safeMeta: { registration_id: record.id, topic: record.topic, rollback: true }
  }, client);
  return serializePlatformWebhookRegistration(record);
}
